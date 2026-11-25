import {
  type JobView,
  type ScanStats,
  type StartCompareInput,
  formatScanStatsSummary,
  normalizeScanStats,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import type { ProviderRegistry } from "../../domain/ports/music-provider.js";
import { comparePlaylistsAsync } from "../../domain/transfer/playlist-comparator.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";
import {
  type LoadedProviderPlaylist,
  MAX_COMPARE_TRACKS,
  computeLoadedPlaylistOmissions,
  fetchProviderPlaylistBounded,
  songToTransferTrack,
} from "./playlist-source-loader.js";

function toCompareScanStats(loaded: LoadedProviderPlaylist): ScanStats {
  const omissions = computeLoadedPlaylistOmissions(loaded, MAX_COMPARE_TRACKS);
  return normalizeScanStats(
    {
      playlistTotal: loaded.sourceTotal,
      sourceTotal: loaded.sourceTotal,
      scannedSlotCount: omissions.scannedSlotCount,
      processedCount: loaded.songs.length,
      unprocessedCount: omissions.unprocessedCount,
      missingDetailCount: omissions.missingDetailCount,
      truncatedCount: omissions.truncatedCount,
      truncated: loaded.truncated,
    },
    loaded.songs.length,
  );
}

export function startCompareJobUseCase(deps: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  jobs: BackgroundJobManager;
  actor: ActorContext;
  input: StartCompareInput;
}): JobView {
  const { providers, authResolver, jobs, actor, input } = deps;
  const leftName = input.leftPlaylistName?.trim() || `${input.leftProvider} 歌单 ${input.leftPlaylistId}`;
  const rightName = input.rightPlaylistName?.trim() || `${input.rightProvider} 歌单 ${input.rightPlaylistId}`;

  return jobs.enqueue({
    actor,
    kind: "compare",
    title: `对比 · ${leftName} vs ${rightName}`,
    subtitle: "加载两侧歌单...",
    maxUserConcurrency: 2,
    runner: async (handle) => {
      const [leftLoaded, rightLoaded] = await Promise.all([
        fetchProviderPlaylistBounded(
          providers.get(input.leftProvider),
          input.leftPlaylistId,
          authResolver.buildPersonalAuth(actor, input.leftProvider, handle.signal),
          MAX_COMPARE_TRACKS,
        ),
        fetchProviderPlaylistBounded(
          providers.get(input.rightProvider),
          input.rightPlaylistId,
          authResolver.buildPersonalAuth(actor, input.rightProvider, handle.signal),
          MAX_COMPARE_TRACKS,
        ),
      ]);

      const leftScanStats = toCompareScanStats(leftLoaded);
      const rightScanStats = toCompareScanStats(rightLoaded);

      handle.updateProgress(25, "比对曲目...");
      const result = await comparePlaylistsAsync({
        left: {
          provider: input.leftProvider,
          playlistId: input.leftPlaylistId,
          playlistName: leftName,
          tracks: leftLoaded.songs.map(songToTransferTrack),
          scanStats: leftScanStats,
        },
        right: {
          provider: input.rightProvider,
          playlistId: input.rightPlaylistId,
          playlistName: rightName,
          tracks: rightLoaded.songs.map(songToTransferTrack),
          scanStats: rightScanStats,
        },
        signal: handle.signal,
        onProgress: (pct) => handle.updateProgress(Math.round(25 + pct * 0.72), `比对进度 ${pct}%`),
      });

      const leftSummary = formatScanStatsSummary(leftScanStats, {
        subjectLabel: "左侧歌单",
        processedVerb: "已比对",
        limitLabel: "单次对比上限",
      });
      const rightSummary = formatScanStatsSummary(rightScanStats, {
        subjectLabel: "右侧歌单",
        processedVerb: "已比对",
        limitLabel: "单次对比上限",
      });
      const scopeParts = [leftSummary, rightSummary].filter((s) => s.hasOmissions).map((s) => s.summaryText);
      const scopeSuffix = scopeParts.length > 0 ? `（${scopeParts.join("；")}）` : "";
      return {
        result,
        subtitle: `一致 ${result.summary.exact} · 仅左 ${result.summary.leftOnly} · 仅右 ${result.summary.rightOnly}${scopeSuffix}`,
      };
    },
  });
}
