import express from "express";
import type { CreatePlaylistTransferDeps, CreatePlaylistTransferInput } from "../playlist-transfer/service.js";
import type { PlaylistTransferRunJob } from "../playlist-transfer/playlist-transfer-job.js";
import type { PlaylistTransferJob, TransferExportResult, TransferImportRequest } from "../playlist-transfer/types.js";

type PlaylistImportResult = {
  playlistId: string;
  playlistName: string;
  playlistUrl?: string;
  addedCount: number;
};

export type PlaylistTransferJobRouterDependencies = {
  getCurrentUserKey: () => Promise<string>;
  listPlaylistTransferJobs: (ownerKey: string) => Promise<PlaylistTransferJob[]>;
  createPlaylistTransferJob: (input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) => Promise<PlaylistTransferJob>;
  startPlaylistTransferRunJob: (input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) => PlaylistTransferRunJob;
  loadSourceTracks: NonNullable<CreatePlaylistTransferDeps["loadSourceTracks"]>;
  searchTargetTracks: CreatePlaylistTransferDeps["searchTargetTracks"];
  checkAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]>;
  saveJob: CreatePlaylistTransferDeps["saveJob"];
  getPlaylistTransferRunJob: (id: string) => PlaylistTransferRunJob | null;
  getPlaylistTransferJob: (ownerKey: string, id: string) => Promise<PlaylistTransferJob | null>;
  formatTransferExport: (job: PlaylistTransferJob, format: string) => TransferExportResult;
  getNeteaseImportTrackIds: (job: PlaylistTransferJob) => string[];
  addNeteaseTrackIdsToExistingPlaylist: (playlistId: string, trackIds: string[]) => Promise<PlaylistImportResult>;
  createNeteasePlaylistFromTrackIds: (name: string, trackIds: string[]) => Promise<PlaylistImportResult>;
  getQqImportTrackMids: (job: PlaylistTransferJob) => string[];
  createQqPlaylistFromTrackMids: (name: string, trackMids: string[]) => Promise<PlaylistImportResult>;
};

export function createPlaylistTransferJobRouter(dependencies: PlaylistTransferJobRouterDependencies) {
  const router = express.Router();
  const createDependencies: CreatePlaylistTransferDeps = {
    loadSourceTracks: dependencies.loadSourceTracks,
    searchTargetTracks: dependencies.searchTargetTracks,
    checkAvailability: dependencies.checkAvailability,
    saveJob: dependencies.saveJob
  };

  router.get("/api/playlist-transfer/jobs", async (_request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    response.json({ jobs: await dependencies.listPlaylistTransferJobs(ownerKey) });
  });

  router.post("/api/playlist-transfer/jobs", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const payload = request.body as TransferImportRequest;

    try {
      const job = await dependencies.createPlaylistTransferJob(
        {
          ...payload,
          ownerKey
        },
        createDependencies
      );
      response.status(201).json(job);
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "创建歌单互转任务失败"
      });
    }
  });

  router.post("/api/playlist-transfer/jobs/progress", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const payload = request.body as TransferImportRequest;
    const job = dependencies.startPlaylistTransferRunJob(
      {
        ...payload,
        ownerKey
      },
      createDependencies
    );

    response.status(202).json({ job });
  });

  router.get("/api/playlist-transfer/jobs/progress/:id", (request, response) => {
    const job = dependencies.getPlaylistTransferRunJob(request.params.id);
    if (!job) {
      response.status(404).json({ message: "歌单互转进度任务不存在" });
      return;
    }

    response.json({ job });
  });

  router.get("/api/playlist-transfer/jobs/:id", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "歌单互转任务不存在" });
      return;
    }

    response.json(job);
  });

  router.post("/api/playlist-transfer/jobs/:id/export", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "歌单互转任务不存在" });
      return;
    }

    const format = typeof request.body?.format === "string" ? request.body.format : "markdown";
    response.json(dependencies.formatTransferExport(job, format));
  });

  router.post("/api/playlist-transfer/jobs/:id/import/netease", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "歌单互转任务不存在" });
      return;
    }

    if (job.targetProvider !== "netease") {
      response.status(400).json({ message: "只有目标为网易云的互转任务才能直接导入网易云歌单。" });
      return;
    }

    try {
      const name = typeof request.body?.name === "string" && request.body.name.trim()
        ? request.body.name.trim()
        : `${job.playlistName} 转换结果`;
      const targetPlaylistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
      const trackIds = dependencies.getNeteaseImportTrackIds(job);
      const result = targetPlaylistId
        ? await dependencies.addNeteaseTrackIdsToExistingPlaylist(targetPlaylistId, trackIds)
        : await dependencies.createNeteasePlaylistFromTrackIds(name, trackIds);
      response.json({
        ...result,
        skippedCount: job.summary.total - result.addedCount
      });
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "导入网易云歌单失败"
      });
    }
  });

  router.post("/api/playlist-transfer/jobs/:id/import/qq", async (request, response) => {
    const ownerKey = await dependencies.getCurrentUserKey();
    const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
    if (!job) {
      response.status(404).json({ message: "歌单互转任务不存在" });
      return;
    }

    if (job.targetProvider !== "qq") {
      response.status(400).json({ message: "只有目标为 QQ 音乐的互转任务才能直接导入 QQ 歌单。" });
      return;
    }

    try {
      const name = typeof request.body?.name === "string" && request.body.name.trim()
        ? request.body.name.trim()
        : `${job.playlistName} 转换结果`;
      const trackMids = dependencies.getQqImportTrackMids(job);
      const result = await dependencies.createQqPlaylistFromTrackMids(name, trackMids);
      response.json({
        ...result,
        skippedCount: job.summary.total - result.addedCount
      });
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "导入 QQ 音乐歌单失败"
      });
    }
  });

  return router;
}
