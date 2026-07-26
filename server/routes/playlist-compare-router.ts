import express from "express";
import type { getPlaylistCompareJob, startPlaylistCompareJob } from "../playlist-transfer/playlist-compare-job.js";
import type {
  comparePlaylists,
  formatPlaylistCompareExport,
  PlaylistCompareResult,
  PlaylistCompareStatus
} from "../playlist-transfer/playlist-compare.js";
import type { loadNeteasePlaylistTransferTracks } from "../playlist-transfer/netease-provider.js";
import type { loadQqPlaylistTransferTracks } from "../playlist-transfer/qq-provider.js";
import type { TransferTrack } from "../playlist-transfer/types.js";
import {
  parsePublicPlaylistCompareResult,
  toPublicPlaylistCompareJob,
  toPublicPlaylistCompareResult
} from "../playlist-transfer/playlist-compare-public-dto.js";
import {
  assertPlaylistCompareExportResultWithinLimits,
  assertPlaylistCompareExportSelectorsWithinLimits,
  PlaylistCompareExportLimitError,
  toPlaylistCompareExportLimitResponse
} from "../playlist-transfer/playlist-compare-export-policy.js";
import { resolveBackgroundJobOwner } from "./background-job-owner.js";
import {
  PUBLIC_ERROR_MESSAGES,
  publicErrorResponse,
  toExpressError
} from "../public-error.js";

const UNSUPPORTED_COMPARE_PROVIDER_MESSAGE = "歌单对比暂只支持网易云歌单和 QQ 音乐公开歌单。";

export type PlaylistCompareRouterDependencies = {
  getCurrentUserKey: () => Promise<string>;
  loadNeteasePlaylistTransferTracks: typeof loadNeteasePlaylistTransferTracks;
  loadQqPlaylistTransferTracks: typeof loadQqPlaylistTransferTracks;
  startPlaylistCompareJob: typeof startPlaylistCompareJob;
  getPlaylistCompareJob: typeof getPlaylistCompareJob;
  comparePlaylists: typeof comparePlaylists;
  formatPlaylistCompareExport: typeof formatPlaylistCompareExport;
};

type NormalizedCompareInput = {
  leftProvider: "netease" | "qq";
  leftPlaylistId: string;
  leftPlaylistName: string;
  rightProvider: "netease" | "qq";
  rightPlaylistId: string;
  rightPlaylistName: string;
};

function normalizeCompareInput(body: unknown): NormalizedCompareInput {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const leftProvider = typeof input.leftProvider === "string" ? input.leftProvider.trim() : "";
  const rightProvider = typeof input.rightProvider === "string" ? input.rightProvider.trim() : "";
  const leftPlaylistId = typeof input.leftPlaylistId === "string" ? input.leftPlaylistId.trim() : "";
  const rightPlaylistId = typeof input.rightPlaylistId === "string" ? input.rightPlaylistId.trim() : "";
  const leftPlaylistName = typeof input.leftPlaylistName === "string" && input.leftPlaylistName.trim()
    ? input.leftPlaylistName.trim()
    : `左侧歌单 ${leftPlaylistId}`;
  const rightPlaylistName = typeof input.rightPlaylistName === "string" && input.rightPlaylistName.trim()
    ? input.rightPlaylistName.trim()
    : `右侧歌单 ${rightPlaylistId}`;

  return {
    leftProvider: leftProvider as "netease" | "qq",
    leftPlaylistId,
    leftPlaylistName,
    rightProvider: rightProvider as "netease" | "qq",
    rightPlaylistId,
    rightPlaylistName
  };
}

function hasSupportedCompareProviders(input: NormalizedCompareInput) {
  return (input.leftProvider === "netease" || input.leftProvider === "qq")
    && (input.rightProvider === "netease" || input.rightProvider === "qq");
}

function normalizeCompareStatuses(input: unknown): PlaylistCompareStatus[] {
  const allowed: PlaylistCompareStatus[] = ["exact", "same_title_different_artist", "similar_title", "left_only", "right_only"];
  if (!Array.isArray(input)) {
    return allowed;
  }

  return input.filter((item): item is PlaylistCompareStatus => allowed.includes(item as PlaylistCompareStatus));
}

function normalizeCompareItemIndexes(input: unknown, itemCount: number) {
  if (!Array.isArray(input)) {
    return undefined;
  }

  return [...new Set(input.filter((item): item is number => Number.isInteger(item) && item >= 0 && item < itemCount))];
}

export function createPlaylistCompareRouter(dependencies: PlaylistCompareRouterDependencies) {
  const router = express.Router();

  async function loadCompareSideTracks(provider: string, playlistId: string): Promise<TransferTrack[]> {
    if (provider === "netease") {
      return dependencies.loadNeteasePlaylistTransferTracks(playlistId);
    }

    if (provider === "qq") {
      return dependencies.loadQqPlaylistTransferTracks(playlistId);
    }

    throw new Error(UNSUPPORTED_COMPARE_PROVIDER_MESSAGE);
  }

  router.post("/api/playlist-transfer/compare/jobs", async (request, response, next) => {
    const input = normalizeCompareInput(request.body);

    if (!input.leftPlaylistId || !input.rightPlaylistId) {
      response.status(400).json({ message: "请填写左右两个歌单 ID。" });
      return;
    }

    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const job = dependencies.startPlaylistCompareJob(ownerKey, input, {
        loadSideTracks: loadCompareSideTracks
      });

      response.status(202).json({ job: toPublicPlaylistCompareJob(job) });
    } catch (error) {
      next(toExpressError(error, "Failed to start playlist compare job"));
    }
  });

  router.get("/api/playlist-transfer/compare/jobs/:id", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const job = dependencies.getPlaylistCompareJob(ownerKey, request.params.id);
      if (!job) {
        response.status(404).json({ message: "歌单对比进度任务不存在" });
        return;
      }

      response.json({ job: toPublicPlaylistCompareJob(job) });
    } catch (error) {
      next(toExpressError(error, "Failed to read playlist compare job"));
    }
  });

  router.post("/api/playlist-transfer/compare", async (request, response) => {
    const input = normalizeCompareInput(request.body);

    if (!input.leftPlaylistId || !input.rightPlaylistId) {
      response.status(400).json({ message: "请填写左右两个歌单 ID。" });
      return;
    }

    if (!hasSupportedCompareProviders(input)) {
      response.status(400).json({ message: UNSUPPORTED_COMPARE_PROVIDER_MESSAGE });
      return;
    }

    try {
      const [leftTracks, rightTracks] = await Promise.all([
        loadCompareSideTracks(input.leftProvider, input.leftPlaylistId),
        loadCompareSideTracks(input.rightProvider, input.rightPlaylistId)
      ]);
      response.json(toPublicPlaylistCompareResult(dependencies.comparePlaylists({
        left: {
          provider: input.leftProvider,
          playlistId: input.leftPlaylistId,
          playlistName: input.leftPlaylistName,
          tracks: leftTracks
        },
        right: {
          provider: input.rightProvider,
          playlistId: input.rightPlaylistId,
          playlistName: input.rightPlaylistName,
          tracks: rightTracks
        }
      })));
    } catch {
      response.status(400).json(publicErrorResponse(PUBLIC_ERROR_MESSAGES.playlistCompare));
    }
  });

  router.post("/api/playlist-transfer/compare/export", (request, response, next) => {
    try {
      assertPlaylistCompareExportResultWithinLimits(request.body?.result);
      const result = parsePublicPlaylistCompareResult(request.body?.result);
      const format = typeof request.body?.format === "string" ? request.body.format : "markdown";

      if (!result) {
        response.status(400).json({ message: "缺少有效的歌单对比结果。" });
        return;
      }

      const statuses = normalizeCompareStatuses(request.body?.statuses);
      assertPlaylistCompareExportSelectorsWithinLimits(statuses, request.body?.itemIndexes);
      const itemIndexes = normalizeCompareItemIndexes(request.body?.itemIndexes, result.items.length);
      const preferredProvider = request.body?.preferredProvider === "netease" || request.body?.preferredProvider === "qq"
        ? request.body.preferredProvider
        : undefined;

      response.json(dependencies.formatPlaylistCompareExport(
        result,
        format as "markdown" | "text" | "csv" | "json",
        statuses,
        { itemIndexes, preferredProvider }
      ));
    } catch (error) {
      if (error instanceof PlaylistCompareExportLimitError) {
        response.status(413).json(toPlaylistCompareExportLimitResponse(error));
        return;
      }
      next(toExpressError(error, "Failed to export playlist compare result"));
    }
  });

  return router;
}
