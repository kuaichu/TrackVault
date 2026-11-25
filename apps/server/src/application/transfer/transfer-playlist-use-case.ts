import {
  type JobDetailView,
  type JobView,
  type ScanStats,
  type ScanStatsInput,
  type StartTransferInput,
  type TransferAvailability,
  type TransferResult,
  type TransferTrack,
  type TransferTrackResult,
  type UpdateTransferSelectionInput,
  formatScanStatsSummary,
  normalizeScanStats,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError, isAppError } from "../../domain/errors.js";
import type {
  AudioResolveTarget,
  MusicProviderAdapter,
  ProviderAuthContext,
  ProviderRegistry,
} from "../../domain/ports/music-provider.js";
import {
  type ProviderCandidateTrack,
  matchTransferTrack,
  rankHighConfidenceCandidates,
  summarizeTransferResults,
} from "../../domain/transfer/track-matcher.js";
import { buildTransferDedupKey } from "../../domain/transfer/track-normalizer.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { loadTransferSourceTracks, songToCandidate } from "./playlist-source-loader.js";

const MAX_AVAILABILITY_PROBES_PER_TRACK = 8;

export function buildTransferSubtitle(
  summary: TransferResult["summary"],
  statsInput?: ScanStatsInput | null,
): string {
  const scanSummary = formatScanStatsSummary(statsInput, {
    subjectLabel: "源歌单",
    processedVerb: "已处理",
    limitLabel: "扫描或单次处理上限",
  });

  if (summary.total === 0 && scanSummary.stats.sourceTotal > 0) {
    return scanSummary.hasOmissions
      ? scanSummary.summaryText
      : `源歌单共 ${scanSummary.stats.playlistTotal} 首，未处理 ${scanSummary.stats.sourceTotal} 首`;
  }

  const base = `共 ${summary.total} 首 · 匹配 ${summary.matched} · 待确认 ${summary.manualReview}`;
  return scanSummary.hasOmissions ? `${base}（${scanSummary.summaryText}）` : base;
}

function withInitialMatch(item: TransferTrackResult): TransferTrackResult {
  if (item.initialMatch) return item;
  return {
    ...item,
    initialMatch: {
      status: item.status,
      ...(item.selectedCandidate ? { selectedCandidate: item.selectedCandidate } : {}),
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
    },
  };
}

export async function probeTrackAvailability(
  adapter: MusicProviderAdapter,
  target: AudioResolveTarget,
  auth: ProviderAuthContext,
): Promise<
  | { kind: "unsupported" }
  | { kind: "resolved"; availability: TransferAvailability }
  | { kind: "error"; message: string }
> {
  if (typeof adapter.resolveAudio !== "function") return { kind: "unsupported" };
  try {
    const resolved = await adapter.resolveAudio(target, "standard", "playback", auth);
    if (typeof resolved.url === "string" && resolved.url.trim().length === 0) {
      return { kind: "resolved", availability: "copyright_unavailable" };
    }
    return { kind: "resolved", availability: resolved.trial ? "trial_only" : "playable" };
  } catch (error) {
    if (isAppError(error)) {
      if (error.code === "COPYRIGHT_UNAVAILABLE") {
        return { kind: "resolved", availability: "copyright_unavailable" };
      }
      if (error.code === "TRIAL_ONLY") {
        return { kind: "resolved", availability: "trial_only" };
      }
      if (error.code === "VIP_REQUIRED") {
        return { kind: "resolved", availability: "vip_only" };
      }
      return { kind: "error", message: error.message || "音源探测请求异常" };
    }
    return {
      kind: "error",
      message: error instanceof Error && error.message ? error.message : "音源探测请求失败",
    };
  }
}

async function matchWithOptionalProbe(
  track: TransferTrack,
  candidates: ProviderCandidateTrack[],
  targetAdapter: MusicProviderAdapter,
  targetAuth: ProviderAuthContext,
  checkAvailability: boolean,
): Promise<TransferTrackResult> {
  if (!checkAvailability || typeof targetAdapter.resolveAudio !== "function") {
    return matchTransferTrack(track, candidates);
  }

  const working = candidates.map((c) => ({ ...c }));
  const rankedHighConfidence = rankHighConfidenceCandidates(track, working);
  if (rankedHighConfidence.length === 0) {
    return matchTransferTrack(track, working, { checkAvailability: true });
  }

  let foundVerifiedPlayable = false;
  for (const candidate of rankedHighConfidence.slice(0, MAX_AVAILABILITY_PROBES_PER_TRACK)) {
    const outcome = await probeTrackAvailability(
      targetAdapter,
      {
        id: candidate.id,
        mediaId: candidate.mediaId,
        title: candidate.title,
        durationSeconds: candidate.durationSeconds,
        availableLevels: candidate.availableLevels,
      },
      targetAuth,
    );

    if (outcome.kind === "resolved") {
      candidate.availability = outcome.availability;
      if (outcome.availability === "playable") {
        candidate.probeStatus = "verified_playable";
        foundVerifiedPlayable = true;
        break;
      }
      candidate.probeStatus = "verified_restricted";
    } else if (outcome.kind === "error") {
      candidate.probeStatus = "probe_error";
      candidate.probeError = outcome.message;
    }
  }

  if (!foundVerifiedPlayable) {
    for (const candidate of rankedHighConfidence) {
      if (!candidate.probeStatus) {
        candidate.probeStatus = "unprobed";
      }
    }
  }

  return matchTransferTrack(track, working, { checkAvailability: true });
}

function buildTransferResultPayload(params: {
  input: StartTransferInput;
  playlistName: string;
  results: TransferTrackResult[];
  scanStats: ScanStats;
  includePlaylistTotal: boolean;
}): TransferResult {
  const { input, playlistName, results, scanStats, includePlaylistTotal } = params;
  return {
    sourceProvider: input.sourceProvider,
    targetProvider: input.targetProvider,
    playlistName,
    summary: summarizeTransferResults(results),
    results,
    scanStats,
    sourceTotal: scanStats.sourceTotal,
    ...(includePlaylistTotal ? { playlistTotal: scanStats.playlistTotal } : {}),
    processedCount: scanStats.processedCount,
    unprocessedCount: scanStats.unprocessedCount,
    missingDetailCount: scanStats.missingDetailCount,
    truncatedCount: scanStats.truncatedCount,
    scannedSlotCount: scanStats.scannedSlotCount,
    truncated: scanStats.truncated,
  };
}

export function startTransferJobUseCase(deps: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  jobs: BackgroundJobManager;
  actor: ActorContext;
  input: StartTransferInput;
}): JobView {
  const { providers, authResolver, jobs, actor, input } = deps;
  const playlistName = input.playlistName?.trim() || "歌单互转任务";

  return jobs.enqueue({
    actor,
    kind: "transfer",
    title: playlistName,
    subtitle: `${input.sourceProvider} → ${input.targetProvider}`,
    maxUserConcurrency: 2,
    runner: async (handle) => {
      handle.updateProgress(5, "加载源曲目列表...");
      const loaded = await loadTransferSourceTracks({
        providers,
        authResolver,
        actor,
        input,
        signal: handle.signal,
      });

      if (loaded.tracks.length === 0) {
        if (
          (loaded.scanStats.truncated && loaded.scanStats.sourceTotal > 0) ||
          (loaded.selectedMode && loaded.scanStats.sourceTotal > 0 && loaded.scanStats.playlistTotal > 0)
        ) {
          const emptyStats = normalizeScanStats(
            {
              ...loaded.scanStats,
              processedCount: 0,
              unprocessedCount: loaded.scanStats.sourceTotal,
              beyondScanCount: loaded.beyondScanCount,
            },
            0,
          );
          const emptyResult = buildTransferResultPayload({
            input,
            playlistName,
            results: [],
            scanStats: emptyStats,
            includePlaylistTotal: loaded.hasPlaylistTotal,
          });
          return {
            result: emptyResult,
            subtitle: buildTransferSubtitle(emptyResult.summary, emptyResult),
          };
        }
        throw new AppError("VALIDATION_ERROR", "源歌单或文本中没有解析到有效歌曲。");
      }

      const targetAdapter = providers.get(input.targetProvider);
      const targetAuth = authResolver.buildPublicReadAuth(actor, input.targetProvider, handle.signal);
      const seenKeys = new Set<string>();
      const results: TransferTrackResult[] = [];
      const shouldProbe = Boolean(input.checkAvailability);

      for (let i = 0; i < loaded.tracks.length; i += 1) {
        if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "任务已取消。");
        const track = loaded.tracks[i];
        if (!track) continue;

        const dedupKey = buildTransferDedupKey(track);
        if (seenKeys.has(dedupKey)) {
          results.push(
            withInitialMatch({
              sourceTrack: track,
              status: "duplicate",
              candidates: [],
              reason: "重复曲目已跳过",
            }),
          );
          continue;
        }
        seenKeys.add(dedupKey);

        if (track.source === input.targetProvider && track.sourceTrackId) {
          const sourceMeta = loaded.sourceMetaByKey.get(`${track.source}:${track.sourceTrackId}`);
          const candidate: ProviderCandidateTrack = {
            provider: input.targetProvider,
            id: track.sourceTrackId,
            mediaId: sourceMeta?.mediaId,
            title: track.title,
            artists: track.artists,
            album: track.album,
            durationSeconds: track.durationSeconds,
            availableLevels: sourceMeta?.availableLevels,
            availability: sourceMeta?.availability ?? "playable",
          };
          results.push(
            withInitialMatch(
              await matchWithOptionalProbe(track, [candidate], targetAdapter, targetAuth, shouldProbe),
            ),
          );
        } else {
          const searchQuery = `${track.title} ${track.artists[0] ?? ""}`.trim();
          try {
            const found = await targetAdapter.searchTracks(searchQuery, targetAuth, 8);
            results.push(
              withInitialMatch(
                await matchWithOptionalProbe(
                  track,
                  found.map(songToCandidate),
                  targetAdapter,
                  targetAuth,
                  shouldProbe,
                ),
              ),
            );
          } catch (error) {
            results.push(
              withInitialMatch({
                sourceTrack: track,
                status: "not_found",
                candidates: [],
                reason: error instanceof Error ? `搜索失败：${error.message}` : "搜索请求异常",
              }),
            );
          }
        }

        const pct = Math.min(96, Math.round(((i + 1) / loaded.tracks.length) * 90) + 5);
        handle.updateProgress(pct, `已匹配 ${i + 1}/${loaded.tracks.length} 首`);
      }

      const processedCount = results.length;
      const finalScanStats = normalizeScanStats(
        {
          ...loaded.scanStats,
          processedCount,
          unprocessedCount: Math.max(0, loaded.scanStats.sourceTotal - processedCount),
          beyondScanCount: loaded.beyondScanCount,
        },
        processedCount,
      );
      const result = buildTransferResultPayload({
        input,
        playlistName,
        results,
        scanStats: finalScanStats,
        includePlaylistTotal: loaded.hasPlaylistTotal,
      });

      return {
        result,
        subtitle: buildTransferSubtitle(result.summary, result),
      };
    },
  });
}

export function updateTransferTrackSelectionUseCase(deps: {
  jobs: BackgroundJobManager;
  actor: ActorContext;
  jobId: string;
  input: UpdateTransferSelectionInput;
}): JobDetailView {
  const { jobs, actor, jobId, input } = deps;
  return jobs.mutateOwnedJobResult<TransferResult>(actor, jobId, (record) => {
    if (record.kind !== "transfer") {
      throw new AppError("VALIDATION_ERROR", "仅跨平台互转任务支持人工确认曲目。");
    }
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，无法更新曲目确认状态。");
    }

    const data = record.result as TransferResult;
    const item = data.results[input.index];
    if (!item) {
      throw new AppError("VALIDATION_ERROR", "目标曲目序号超出范围。");
    }

    let updatedItem: TransferTrackResult;
    if (input.action === "select") {
      if (!input.targetTrackId) {
        throw new AppError("VALIDATION_ERROR", "请选择要确认的候选曲目。");
      }
      const chosen = item.candidates.find((c) => c.targetTrackId === input.targetTrackId);
      if (!chosen) {
        throw new AppError("VALIDATION_ERROR", "所选候选曲目不存在于该条目的候选列表中。");
      }
      updatedItem = {
        ...item,
        status: "matched",
        selectedCandidate: chosen,
        reason: "已人工确认",
        manualDecision: {
          action: "select",
          targetTrackId: chosen.targetTrackId,
          updatedAt: Date.now(),
        },
      };
    } else if (input.action === "skip") {
      updatedItem = {
        ...item,
        status: "skipped",
        selectedCandidate: undefined,
        reason: "已人工跳过",
        manualDecision: {
          action: "skip",
          updatedAt: Date.now(),
        },
      };
    } else if (item.initialMatch) {
      updatedItem = {
        ...item,
        status: item.initialMatch.status,
        selectedCandidate: item.initialMatch.selectedCandidate,
        reason: item.initialMatch.reason,
        manualDecision: undefined,
      };
    } else {
      updatedItem = {
        ...item,
        status: item.candidates.length > 0 ? "manual_review" : "not_found",
        selectedCandidate: undefined,
        reason: item.candidates.length > 0 ? "存在相似候选，建议人工确认" : "目标平台未找到匹配候选",
        manualDecision: undefined,
      };
    }

    const nextResults = data.results.map((entry, idx) => (idx === input.index ? updatedItem : entry));
    const nextSummary = summarizeTransferResults(nextResults);
    const nextScanStats = data.scanStats ?? normalizeScanStats(data, nextSummary.total);
    const nextResult: TransferResult = {
      ...data,
      scanStats: nextScanStats,
      summary: nextSummary,
      results: nextResults,
    };

    return {
      result: nextResult,
      subtitle: buildTransferSubtitle(nextSummary, nextResult),
    };
  });
}
