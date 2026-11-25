import {
  type AuditIssueItem,
  type ImportAuditResult,
  type JobView,
  type StartImportAuditInput,
  formatScanStatsSummary,
  normalizeScanStats,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type { ProviderRegistry } from "../../domain/ports/music-provider.js";
import { matchTransferTrack } from "../../domain/transfer/track-matcher.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";
import {
  computeLoadedPlaylistOmissions,
  fetchProviderPlaylistBounded,
  songToCandidate,
  songToTransferTrack,
} from "./playlist-source-loader.js";
import { probeTrackAvailability } from "./transfer-playlist-use-case.js";

export function startImportAuditJobUseCase(deps: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  jobs: BackgroundJobManager;
  actor: ActorContext;
  input: StartImportAuditInput;
}): JobView {
  const { providers, authResolver, jobs, actor, input } = deps;
  const playlistName = input.playlistName?.trim() || `网易云歌单 ${input.playlistId}`;

  return jobs.enqueue({
    actor,
    kind: "import_audit",
    title: `可用性审计 · ${playlistName}`,
    subtitle: "准备扫描...",
    maxUserConcurrency: 1,
    runner: async (handle) => {
      const netease = providers.get("netease");
      const auth = authResolver.buildPersonalAuth(actor, "netease", handle.signal);
      const searchAuth = authResolver.buildPublicReadAuth(actor, "netease", handle.signal);

      handle.updateProgress(5, "拉取歌单曲目...");
      const loaded = await fetchProviderPlaylistBounded(netease, input.playlistId, auth, input.maxTracks);
      const songs = loaded.songs;
      if (songs.length === 0) {
        throw new AppError("VALIDATION_ERROR", "该歌单没有可扫描的曲目。");
      }

      const playableTrackIds: string[] = [];
      const issues: AuditIssueItem[] = [];
      const shouldProbe = Boolean(input.checkAvailability);

      for (let i = 0; i < songs.length; i += 1) {
        if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "审计任务已取消。");
        const song = songs[i];
        if (!song) continue;

        const status = song.availability?.playback.status ?? "available";
        const locked = Boolean(song.availability?.playback.locked);

        let staticIssueType: AuditIssueItem["issueType"] | null = null;
        let reason = song.availability?.playback.reason ?? "曲目当前不可直接完整播放";

        if (status === "copyright") {
          staticIssueType = "copyright_unavailable";
        } else if (locked) {
          if (status === "paid_album") staticIssueType = "paid_album";
          else if (status === "restricted") staticIssueType = "restricted";
          else staticIssueType = "vip_only";
        }

        let issueType: AuditIssueItem["issueType"] | null = staticIssueType;

        if (shouldProbe) {
          const outcome = await probeTrackAvailability(
            netease,
            {
              id: song.id,
              mediaId: song.mediaId,
              title: song.title,
              durationSeconds: song.durationSeconds,
              availableLevels: song.availableQualities?.map((q) => q.level),
            },
            searchAuth,
          );
          if (outcome.kind === "resolved") {
            const probed = outcome.availability;
            if (probed === "playable") {
              issueType = null;
            } else if (probed === "trial_only") {
              issueType = "trial_only";
              reason = "实测音源仅提供试听片段";
            } else if (probed === "copyright_unavailable") {
              issueType = "copyright_unavailable";
              reason = "实测音源无可用版权";
            } else if (probed === "vip_only") {
              issueType =
                staticIssueType === "paid_album" || staticIssueType === "restricted"
                  ? staticIssueType
                  : "vip_only";
              if (!staticIssueType) {
                reason = "实测音源需要会员权限";
              }
            }
          } else if (outcome.kind === "error") {
            if (staticIssueType) {
              issueType = staticIssueType;
              reason = `音源实测未完成（${outcome.message}）：${reason}`;
            } else {
              issueType = "probe_error";
              reason = `音源实测未完成（${outcome.message}），暂未确认为可直接播放`;
            }
          }
        }

        if (!issueType) {
          playableTrackIds.push(song.id);
        } else {
          let replacements: AuditIssueItem["replacements"] = [];
          try {
            const found = await netease.searchTracks(
              `${song.title} ${song.artist}`,
              searchAuth,
              input.candidateLimit + 2,
            );
            const matched = matchTransferTrack(
              songToTransferTrack(song),
              found.filter((f) => f.id !== song.id).map(songToCandidate),
            );
            replacements = matched.candidates.slice(0, input.candidateLimit);
          } catch {
            replacements = [];
          }

          issues.push({
            trackId: song.id,
            title: song.title,
            artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
            album: song.album,
            issueType,
            reason,
            replacements,
          });
        }

        handle.updateProgress(
          Math.min(96, Math.round(((i + 1) / songs.length) * 90) + 5),
          `已扫描 ${i + 1}/${songs.length} 首`,
        );
      }

      const auditOmissions = computeLoadedPlaylistOmissions(loaded, input.maxTracks);
      const auditScanStats = normalizeScanStats(
        {
          playlistTotal: loaded.sourceTotal,
          sourceTotal: loaded.sourceTotal,
          scannedSlotCount: auditOmissions.scannedSlotCount,
          processedCount: songs.length,
          unprocessedCount: auditOmissions.unprocessedCount,
          missingDetailCount: auditOmissions.missingDetailCount,
          truncatedCount: auditOmissions.truncatedCount,
          truncated: loaded.truncated,
        },
        songs.length,
      );
      const result: ImportAuditResult = {
        playlistId: input.playlistId,
        playlistName,
        scannedCount: songs.length,
        playableCount: playableTrackIds.length,
        issueCount: issues.length,
        playableTrackIds,
        issues,
        scanStats: auditScanStats,
        sourceTotal: auditScanStats.sourceTotal,
        unprocessedCount: auditScanStats.unprocessedCount,
        missingDetailCount: auditScanStats.missingDetailCount,
        truncatedCount: auditScanStats.truncatedCount,
        scannedSlotCount: auditScanStats.scannedSlotCount,
        truncated: auditScanStats.truncated,
      };

      const auditSummary = formatScanStatsSummary(auditScanStats, {
        subjectLabel: "源歌单",
        processedVerb: "已扫描",
        limitLabel: "单次扫描上限",
      });
      const scopeNote = auditSummary.hasOmissions ? `（${auditSummary.summaryText}）` : "";
      return {
        result,
        subtitle: `扫描 ${result.scannedCount} 首 · 正常 ${result.playableCount} · 异常 ${result.issueCount}${scopeNote}`,
      };
    },
  });
}
