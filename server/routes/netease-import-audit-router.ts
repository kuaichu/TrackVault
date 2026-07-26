import express, { type Response } from "express";
import type { buildNeteaseImportedPlaylistAudit } from "../playlist-transfer/netease-import-audit.js";
import type {
  cancelNeteaseImportAuditJob,
  formatNeteaseImportAuditJobExport,
  getNeteaseImportAuditJob,
  startNeteaseImportAuditJob
} from "../playlist-transfer/netease-import-audit-job.js";
import type {
  checkNeteaseProviderTrackAvailability,
  createNeteasePlaylistFromTrackIds,
  loadNeteasePlaylistAuditEntries,
  searchNeteaseProviderTracksByTitle
} from "../playlist-transfer/netease-provider.js";
import type { TransferExportFormat } from "../playlist-transfer/types.js";
import { resolveBackgroundJobOwner } from "./background-job-owner.js";

export type NeteaseImportAuditRouterDependencies = {
  getCurrentUserKey: () => Promise<string>;
  loadNeteasePlaylistAuditEntries: typeof loadNeteasePlaylistAuditEntries;
  buildNeteaseImportedPlaylistAudit: typeof buildNeteaseImportedPlaylistAudit;
  searchNeteaseProviderTracksByTitle: typeof searchNeteaseProviderTracksByTitle;
  checkNeteaseProviderTrackAvailability: typeof checkNeteaseProviderTrackAvailability;
  startNeteaseImportAuditJob: typeof startNeteaseImportAuditJob;
  getNeteaseImportAuditJob: typeof getNeteaseImportAuditJob;
  cancelNeteaseImportAuditJob: typeof cancelNeteaseImportAuditJob;
  formatNeteaseImportAuditJobExport: typeof formatNeteaseImportAuditJobExport;
  createNeteasePlaylistFromTrackIds: typeof createNeteasePlaylistFromTrackIds;
};

async function withAuditTimeout<T>(operation: Promise<T>, timeoutMs: number, fallback: T) {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createNeteaseImportAuditRouter(dependencies: NeteaseImportAuditRouterDependencies) {
  const router = express.Router();

  async function resolveOwner(response: Response) {
    return resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
  }

  router.post("/api/playlist-transfer/netease-import-audit", async (request, response) => {
    const playlistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
    const playlistName = typeof request.body?.playlistName === "string" && request.body.playlistName.trim()
      ? request.body.playlistName.trim()
      : "网易云歌单";
    const maxTracks = Number(request.body?.maxTracks ?? 300);
    const candidateLimit = Number(request.body?.candidateLimit ?? 5);
    const checkAvailability = request.body?.checkAvailability !== false;

    if (!playlistId) {
      response.status(400).json({ message: "缺少网易云歌单 ID。" });
      return;
    }

    try {
      const tracks = await dependencies.loadNeteasePlaylistAuditEntries(playlistId, maxTracks);
      const audit = await dependencies.buildNeteaseImportedPlaylistAudit({
        playlistId,
        playlistName,
        tracks,
        candidateLimit,
        searchCandidates: dependencies.searchNeteaseProviderTracksByTitle,
        checkCandidateAvailability: checkAvailability
          ? dependencies.checkNeteaseProviderTrackAvailability
          : undefined
      });

      response.json(audit);
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "网易云导入歌单清理失败"
      });
    }
  });

  router.post("/api/playlist-transfer/netease-import-audit/jobs", async (request, response) => {
    const playlistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
    const playlistName = typeof request.body?.playlistName === "string" && request.body.playlistName.trim()
      ? request.body.playlistName.trim()
      : "网易云歌单";
    const maxTracks = Math.min(1000, Math.max(1, Math.trunc(Number(request.body?.maxTracks ?? 300)) || 300));
    const candidateLimit = Math.min(10, Math.max(1, Math.trunc(Number(request.body?.candidateLimit ?? 5)) || 5));
    const checkAvailability = request.body?.checkAvailability === true;

    if (!playlistId) {
      response.status(400).json({ message: "缺少网易云歌单 ID。" });
      return;
    }

    const ownerKey = await resolveOwner(response);
    if (ownerKey === null) {
      return;
    }
    const job = dependencies.startNeteaseImportAuditJob(
      ownerKey,
      {
        playlistId,
        playlistName,
        maxTracks,
        candidateLimit,
        checkAvailability
      },
      {
        loadEntries: dependencies.loadNeteasePlaylistAuditEntries,
        searchCandidates: (track) => withAuditTimeout(
          dependencies.searchNeteaseProviderTracksByTitle(track),
          12000,
          []
        ),
        checkCandidateAvailability: (candidate) => withAuditTimeout(
          dependencies.checkNeteaseProviderTrackAvailability(candidate),
          8000,
          null
        )
      }
    );

    response.status(202).json({ job });
  });

  router.get("/api/playlist-transfer/netease-import-audit/jobs/:id", async (request, response) => {
    const ownerKey = await resolveOwner(response);
    if (ownerKey === null) {
      return;
    }
    const job = dependencies.getNeteaseImportAuditJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
      return;
    }

    response.json({ job });
  });

  router.post("/api/playlist-transfer/netease-import-audit/jobs/:id/cancel", async (request, response) => {
    const ownerKey = await resolveOwner(response);
    if (ownerKey === null) {
      return;
    }
    const job = dependencies.cancelNeteaseImportAuditJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
      return;
    }

    response.json({ job });
  });

  router.post("/api/playlist-transfer/netease-import-audit/jobs/:id/export", async (request, response) => {
    const ownerKey = await resolveOwner(response);
    if (ownerKey === null) {
      return;
    }
    const job = dependencies.getNeteaseImportAuditJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
      return;
    }

    if (job.status !== "completed" || !job.result) {
      response.status(400).json({ message: "任务尚未完成，不能导出。" });
      return;
    }

    const format = typeof request.body?.format === "string" ? request.body.format : "text";
    response.json(dependencies.formatNeteaseImportAuditJobExport(job.result, format as TransferExportFormat));
  });

  router.post("/api/playlist-transfer/netease-import-audit/jobs/:id/import/playable", async (request, response) => {
    const ownerKey = await resolveOwner(response);
    if (ownerKey === null) {
      return;
    }
    const job = dependencies.getNeteaseImportAuditJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
      return;
    }

    if (job.status !== "completed" || !job.result) {
      response.status(400).json({ message: "任务尚未完成，不能创建正常歌曲新歌单。" });
      return;
    }

    const trackIds = job.result.playableTrackIds;
    if (trackIds.length === 0) {
      response.status(400).json({ message: "扫描结果里没有正常可播歌曲，不能创建新歌单。" });
      return;
    }

    const name = typeof request.body?.name === "string" && request.body.name.trim()
      ? request.body.name.trim()
      : `${job.result.playlistName} - 正常歌曲`;

    try {
      const result = await dependencies.createNeteasePlaylistFromTrackIds(name, trackIds);
      response.json({
        ...result,
        skippedCount: Math.max(0, job.result.scannedCount - trackIds.length)
      });
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "创建正常歌曲新歌单失败"
      });
    }
  });

  return router;
}
