import type {
  AuditIssueItem,
  CompareResult,
  CompareStatus,
  ExportFormat,
  ExportPayload,
  ImportAuditResult,
  JobView,
  MusicPlatform,
  Song,
  StartCompareInput,
  StartImportAuditInput,
  StartTransferInput,
  TransferAvailability,
  TransferResult,
  TransferTrack,
  TransferTrackResult,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type {
  CreatePlaylistResult,
  ProviderAuthContext,
  ProviderRegistry,
} from "../../domain/ports/music-provider.js";
import {
  type ProviderCandidateTrack,
  comparePlaylistsAsync,
  matchTransferTrack,
  normalizeMatchText,
  summarizeTransferResults,
} from "../../domain/transfer/matcher.js";
import {
  formatCompareExport,
  formatImportAuditExport,
  formatTransferExport,
  parseCsvPlaylist,
  parseTextPlaylist,
} from "../../domain/transfer/text-and-csv.js";
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";

function songToTransferTrack(song: Song): TransferTrack {
  return {
    source: song.platform,
    sourceTrackId: song.id,
    title: song.title,
    artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
    album: song.album,
    durationSeconds: song.durationSeconds,
  };
}

function songToCandidate(song: Song): ProviderCandidateTrack {
  let availability: TransferAvailability = "playable";
  const status = song.availability?.playback.status;
  if (status === "copyright") availability = "copyright_unavailable";
  else if (status === "vip" || status === "paid_album") availability = "vip_only";

  return {
    provider: song.platform,
    id: song.id,
    title: song.title,
    artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
    album: song.album,
    durationSeconds: song.durationSeconds,
    availability,
  };
}

export class TransferService {
  readonly #providers: ProviderRegistry;
  readonly #credentials: CredentialRepository;
  readonly #jobs: BackgroundJobManager;

  constructor(deps: {
    providers: ProviderRegistry;
    credentials: CredentialRepository;
    jobs: BackgroundJobManager;
  }) {
    this.#providers = deps.providers;
    this.#credentials = deps.credentials;
    this.#jobs = deps.jobs;
  }

  #buildAuth(actor: ActorContext, platform: MusicPlatform, signal?: AbortSignal): ProviderAuthContext {
    const binding =
      typeof this.#credentials.getBindingView === "function"
        ? this.#credentials.getBindingView(actor.userId, platform)
        : null;
    return {
      platform,
      cookie: this.#credentials.getDecryptedCookie(actor.userId, platform),
      scopeKey: actor.userId,
      accountUid: binding?.accountUid ?? null,
      signal,
    };
  }

  /**
   * C015: Read-only public candidate search auth context for transfer/audit matching.
   * NEVER used for reading private user playlists or creating/modifying playlists.
   */
  #buildPublicSearchAuth(
    actor: ActorContext,
    platform: MusicPlatform,
    signal?: AbortSignal,
  ): ProviderAuthContext {
    const personal = this.#buildAuth(actor, platform, signal);
    if (personal.cookie) return personal;
    if (actor.trustedFallback && typeof this.#credentials.getDecryptedSystemFallbackCookie === "function") {
      const fallbackCookie = this.#credentials.getDecryptedSystemFallbackCookie(platform);
      if (fallbackCookie) {
        return {
          platform,
          cookie: fallbackCookie,
          scopeKey: "system-fallback",
          accountUid: null,
          signal,
        };
      }
    }
    return personal;
  }

  async #loadSourceTracks(actor: ActorContext, input: StartTransferInput): Promise<TransferTrack[]> {
    if (input.sourceTracks && input.sourceTracks.length > 0) {
      return input.sourceTracks.slice(0, 1000);
    }

    if (input.sourceProvider === "text") {
      return parseTextPlaylist(input.rawText ?? "", 1000);
    }
    if (input.sourceProvider === "csv") {
      return parseCsvPlaylist(input.rawText ?? "", 1000);
    }

    if (!input.playlistId) {
      throw new AppError("VALIDATION_ERROR", "请提供源歌单 ID。");
    }

    const songs = await this.#providers
      .get(input.sourceProvider)
      .getAllPlaylistTracks(input.playlistId, this.#buildAuth(actor, input.sourceProvider), 1000);

    const selectedSet =
      input.selectedSourceTrackIds && input.selectedSourceTrackIds.length > 0
        ? new Set(input.selectedSourceTrackIds)
        : null;

    return songs.filter((song) => !selectedSet || selectedSet.has(song.id)).map(songToTransferTrack);
  }

  startTransferJob(actor: ActorContext, input: StartTransferInput): JobView {
    const playlistName = input.playlistName?.trim() || "歌单互转任务";

    return this.#jobs.enqueue({
      actor,
      kind: "transfer",
      title: playlistName,
      subtitle: `${input.sourceProvider} → ${input.targetProvider}`,
      maxUserConcurrency: 2,
      runner: async (handle) => {
        handle.updateProgress(5, "加载源曲目列表...");
        const sourceTracks = await this.#loadSourceTracks(actor, input);
        if (sourceTracks.length === 0) {
          throw new AppError("VALIDATION_ERROR", "源歌单或文本中没有解析到有效歌曲。");
        }

        const targetAdapter = this.#providers.get(input.targetProvider);
        const targetAuth = this.#buildPublicSearchAuth(actor, input.targetProvider, handle.signal);
        const seenKeys = new Set<string>();
        const results: TransferTrackResult[] = [];

        for (let i = 0; i < sourceTracks.length; i += 1) {
          if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "任务已取消。");
          const track = sourceTracks[i];
          if (!track) continue;

          const dedupKey = `${normalizeMatchText(track.title)}::${track.artists.map(normalizeMatchText).join(",")}`;
          if (seenKeys.has(dedupKey)) {
            results.push({
              sourceTrack: track,
              status: "duplicate",
              candidates: [],
              reason: "重复曲目已跳过",
            });
            continue;
          }
          seenKeys.add(dedupKey);

          // Same-platform shortcut when sourceTrackId is already valid
          if (track.source === input.targetProvider && track.sourceTrackId) {
            results.push(
              matchTransferTrack(track, [
                {
                  provider: input.targetProvider,
                  id: track.sourceTrackId,
                  title: track.title,
                  artists: track.artists,
                  album: track.album,
                  durationSeconds: track.durationSeconds,
                  availability: "playable",
                },
              ]),
            );
          } else {
            const searchQuery = `${track.title} ${track.artists[0] ?? ""}`.trim();
            try {
              const found = await targetAdapter.searchTracks(searchQuery, targetAuth, 8);
              results.push(matchTransferTrack(track, found.map(songToCandidate)));
            } catch (error) {
              // Single track network failure must NOT abort the entire batch
              results.push({
                sourceTrack: track,
                status: "not_found",
                candidates: [],
                reason: error instanceof Error ? `搜索失败：${error.message}` : "搜索请求异常",
              });
            }
          }

          const pct = Math.min(96, Math.round(((i + 1) / sourceTracks.length) * 90) + 5);
          handle.updateProgress(pct, `已匹配 ${i + 1}/${sourceTracks.length} 首`);
        }

        const summary = summarizeTransferResults(results);
        const result: TransferResult = {
          sourceProvider: input.sourceProvider,
          targetProvider: input.targetProvider,
          playlistName,
          summary,
          results,
        };

        return {
          result,
          subtitle: `共 ${summary.total} 首 · 匹配 ${summary.matched} · 待确认 ${summary.manualReview}`,
        };
      },
    });
  }

  startImportAuditJob(actor: ActorContext, input: StartImportAuditInput): JobView {
    const playlistName = input.playlistName?.trim() || `网易云歌单 ${input.playlistId}`;

    return this.#jobs.enqueue({
      actor,
      kind: "import_audit",
      title: `可用性审计 · ${playlistName}`,
      subtitle: "准备扫描...",
      maxUserConcurrency: 1,
      runner: async (handle) => {
        const netease = this.#providers.get("netease");
        const auth = this.#buildAuth(actor, "netease", handle.signal);
        const searchAuth = this.#buildPublicSearchAuth(actor, "netease", handle.signal);

        handle.updateProgress(5, "拉取歌单曲目...");
        const songs = await netease.getAllPlaylistTracks(input.playlistId, auth, input.maxTracks);
        if (songs.length === 0) {
          throw new AppError("VALIDATION_ERROR", "该歌单没有可扫描的曲目。");
        }

        const playableTrackIds: string[] = [];
        const issues: AuditIssueItem[] = [];

        for (let i = 0; i < songs.length; i += 1) {
          if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "审计任务已取消。");
          const song = songs[i];
          if (!song) continue;

          const status = song.availability?.playback.status ?? "available";
          const locked = Boolean(song.availability?.playback.locked);

          if (!locked && status === "available") {
            playableTrackIds.push(song.id);
          } else {
            const issueType: AuditIssueItem["issueType"] =
              status === "copyright" ? "copyright_unavailable" : "vip_only";
            const reason = song.availability?.playback.reason ?? "曲目当前不可直接完整播放";

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

        const result: ImportAuditResult = {
          playlistId: input.playlistId,
          playlistName,
          scannedCount: songs.length,
          playableCount: playableTrackIds.length,
          issueCount: issues.length,
          playableTrackIds,
          issues,
        };

        return {
          result,
          subtitle: `扫描 ${result.scannedCount} 首 · 正常 ${result.playableCount} · 异常 ${result.issueCount}`,
        };
      },
    });
  }

  startCompareJob(actor: ActorContext, input: StartCompareInput): JobView {
    const leftName = input.leftPlaylistName?.trim() || `${input.leftProvider} 歌单 ${input.leftPlaylistId}`;
    const rightName =
      input.rightPlaylistName?.trim() || `${input.rightProvider} 歌单 ${input.rightPlaylistId}`;

    return this.#jobs.enqueue({
      actor,
      kind: "compare",
      title: `对比 · ${leftName} vs ${rightName}`,
      subtitle: "加载两侧歌单...",
      maxUserConcurrency: 2,
      runner: async (handle) => {
        const [leftSongs, rightSongs] = await Promise.all([
          this.#providers
            .get(input.leftProvider)
            .getAllPlaylistTracks(input.leftPlaylistId, this.#buildAuth(actor, input.leftProvider), 1500),
          this.#providers
            .get(input.rightProvider)
            .getAllPlaylistTracks(input.rightPlaylistId, this.#buildAuth(actor, input.rightProvider), 1500),
        ]);

        handle.updateProgress(25, "比对曲目...");
        const result = await comparePlaylistsAsync({
          left: {
            provider: input.leftProvider,
            playlistId: input.leftPlaylistId,
            playlistName: leftName,
            tracks: leftSongs.map(songToTransferTrack),
          },
          right: {
            provider: input.rightProvider,
            playlistId: input.rightPlaylistId,
            playlistName: rightName,
            tracks: rightSongs.map(songToTransferTrack),
          },
          signal: handle.signal,
          onProgress: (pct) => handle.updateProgress(Math.round(25 + pct * 0.72), `比对进度 ${pct}%`),
        });

        return {
          result,
          subtitle: `一致 ${result.summary.exact} · 仅左 ${result.summary.leftOnly} · 仅右 ${result.summary.rightOnly}`,
        };
      },
    });
  }

  exportJob(
    actor: ActorContext,
    jobId: string,
    format: ExportFormat,
    statuses?: readonly CompareStatus[],
  ): ExportPayload {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，无法导出。");
    }

    if (record.kind === "transfer") {
      return formatTransferExport(record.result as TransferResult, format);
    }
    if (record.kind === "compare") {
      return formatCompareExport(record.result as CompareResult, format, statuses);
    }
    if (record.kind === "import_audit") {
      return formatImportAuditExport(record.result as ImportAuditResult, format);
    }

    throw new AppError("VALIDATION_ERROR", "该任务类型不支持文本导出。");
  }

  async importTransferResultToPlatform(
    actor: ActorContext,
    jobId: string,
    options: { name?: string; existingPlaylistId?: string },
  ): Promise<CreatePlaylistResult & { skippedCount: number }> {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，不能导入歌单。");
    }

    if (record.kind === "transfer") {
      const data = record.result as TransferResult;
      const trackIds = data.results
        .filter((r) => r.status === "matched" && r.selectedCandidate?.targetTrackId)
        .map((r) => r.selectedCandidate?.targetTrackId ?? "")
        .filter(Boolean);

      if (trackIds.length === 0) {
        throw new AppError("VALIDATION_ERROR", "没有已匹配的歌曲可供导入。");
      }

      const adapter = this.#providers.get(data.targetProvider);
      const auth = this.#buildAuth(actor, data.targetProvider);

      if (options.existingPlaylistId && adapter.addTracksToPlaylist) {
        const { addedCount } = await adapter.addTracksToPlaylist(options.existingPlaylistId, trackIds, auth);
        return {
          playlistId: options.existingPlaylistId,
          playlistName: options.name || data.playlistName,
          playlistUrl:
            data.targetProvider === "netease"
              ? `https://music.163.com/#/playlist?id=${encodeURIComponent(options.existingPlaylistId)}`
              : "https://y.qq.com/",
          addedCount,
          skippedCount: Math.max(0, data.summary.total - addedCount),
        };
      }

      if (!adapter.createPlaylistWithTracks) {
        throw new AppError("FEATURE_UNSUPPORTED", `${data.targetProvider} 暂不支持直接建单导入。`);
      }
      const created = await adapter.createPlaylistWithTracks(
        options.name?.trim() || `${data.playlistName} 转换结果`,
        trackIds,
        auth,
      );
      return { ...created, skippedCount: Math.max(0, data.summary.total - created.addedCount) };
    }

    if (record.kind === "import_audit") {
      const data = record.result as ImportAuditResult;
      if (data.playableTrackIds.length === 0) {
        throw new AppError("VALIDATION_ERROR", "没有正常可播歌曲可以创建新歌单。");
      }
      const adapter = this.#providers.get("netease");
      if (!adapter.createPlaylistWithTracks) {
        throw new AppError("FEATURE_UNSUPPORTED", "暂不支持网易云建单。");
      }
      const created = await adapter.createPlaylistWithTracks(
        options.name?.trim() || `${data.playlistName} - 正常歌曲`,
        data.playableTrackIds,
        this.#buildAuth(actor, "netease"),
      );
      return { ...created, skippedCount: Math.max(0, data.scannedCount - created.addedCount) };
    }

    throw new AppError("VALIDATION_ERROR", "该任务类型不支持直接导入歌单。");
  }
}
