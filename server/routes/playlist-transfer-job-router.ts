import express from "express";
import type { CreatePlaylistTransferDeps, CreatePlaylistTransferInput } from "../playlist-transfer/service.js";
import type { PlaylistTransferRunJob } from "../playlist-transfer/playlist-transfer-job.js";
import type { PlaylistTransferJob, TransferExportResult } from "../playlist-transfer/types.js";
import { toPublicPlaylistTransferJob } from "../playlist-transfer/public-dto.js";
import {
  parseTransferImportRequest,
  TransferImportRequestValidationError
} from "../playlist-transfer/transfer-import-request.js";
import { resolveBackgroundJobOwner } from "./background-job-owner.js";
import {
  PUBLIC_ERROR_MESSAGES,
  publicErrorResponse,
  toExpressError
} from "../public-error.js";

type PlaylistImportResult = {
  playlistId: string;
  playlistName: string;
  playlistUrl?: string;
  addedCount: number;
};

function toPublicPlaylistImportResult(result: PlaylistImportResult, skippedCount: number) {
  return {
    playlistId: result.playlistId,
    playlistName: result.playlistName,
    ...(result.playlistUrl === undefined ? {} : { playlistUrl: result.playlistUrl }),
    addedCount: result.addedCount,
    skippedCount
  };
}

export type PlaylistTransferJobRouterDependencies = {
  getCurrentUserKey: () => Promise<string>;
  listPlaylistTransferJobs: (ownerKey: string) => Promise<PlaylistTransferJob[]>;
  createPlaylistTransferJob: (input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) => Promise<PlaylistTransferJob>;
  startPlaylistTransferRunJob: (
    input: CreatePlaylistTransferInput,
    deps: CreatePlaylistTransferDeps
  ) => PlaylistTransferRunJob | Promise<PlaylistTransferRunJob>;
  loadSourceTracks: NonNullable<CreatePlaylistTransferDeps["loadSourceTracks"]>;
  searchTargetTracks: CreatePlaylistTransferDeps["searchTargetTracks"];
  checkAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]>;
  saveJob: CreatePlaylistTransferDeps["saveJob"];
  getPlaylistTransferRunJob: (ownerKey: string, id: string) => PlaylistTransferRunJob | null;
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

  router.get("/api/playlist-transfer/jobs", async (_request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const jobs = await dependencies.listPlaylistTransferJobs(ownerKey);
      response.json({ jobs: jobs.map(toPublicPlaylistTransferJob) });
    } catch (error) {
      next(toExpressError(error, "Failed to list playlist transfer jobs"));
    }
  });

  router.post("/api/playlist-transfer/jobs", async (request, response) => {
    const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
    if (ownerKey === null) {
      return;
    }
    try {
      const payload = parseTransferImportRequest(request.body);
      const job = await dependencies.createPlaylistTransferJob(
        {
          ...payload,
          ownerKey
        },
        createDependencies
      );
      response.status(201).json(toPublicPlaylistTransferJob(job));
    } catch (error) {
      response.status(400).json(error instanceof TransferImportRequestValidationError
        ? { message: error.message }
        : publicErrorResponse(PUBLIC_ERROR_MESSAGES.playlistTransferCreate));
    }
  });

  router.post("/api/playlist-transfer/jobs/progress", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const payload = parseTransferImportRequest(request.body);
      const job = await dependencies.startPlaylistTransferRunJob(
        {
          ...payload,
          ownerKey
        },
        createDependencies
      );

      response.status(202).json({ job });
    } catch (error) {
      if (error instanceof TransferImportRequestValidationError) {
        response.status(400).json({ message: error.message });
        return;
      }
      next(toExpressError(error, "Failed to start playlist transfer progress job"));
    }
  });

  router.get("/api/playlist-transfer/jobs/progress/:id", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const job = dependencies.getPlaylistTransferRunJob(ownerKey, request.params.id);
      if (!job) {
        response.status(404).json({ message: "歌单互转进度任务不存在" });
        return;
      }

      response.json({ job });
    } catch (error) {
      next(toExpressError(error, "Failed to read playlist transfer progress job"));
    }
  });

  router.get("/api/playlist-transfer/jobs/:id", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
      if (!job) {
        response.status(404).json({ message: "歌单互转任务不存在" });
        return;
      }

      response.json(toPublicPlaylistTransferJob(job));
    } catch (error) {
      next(toExpressError(error, "Failed to read playlist transfer job"));
    }
  });

  router.post("/api/playlist-transfer/jobs/:id/export", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
      const job = await dependencies.getPlaylistTransferJob(ownerKey, request.params.id);
      if (!job) {
        response.status(404).json({ message: "歌单互转任务不存在" });
        return;
      }

      const format = typeof request.body?.format === "string" ? request.body.format : "markdown";
      response.json(dependencies.formatTransferExport(job, format));
    } catch (error) {
      next(toExpressError(error, "Failed to export playlist transfer job"));
    }
  });

  router.post("/api/playlist-transfer/jobs/:id/import/netease", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
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
        response.json(toPublicPlaylistImportResult(
          result,
          job.summary.total - result.addedCount
        ));
      } catch {
        response.status(400).json(publicErrorResponse(PUBLIC_ERROR_MESSAGES.neteaseImport));
      }
    } catch (error) {
      next(toExpressError(error, "Failed to resolve Netease playlist import job"));
    }
  });

  router.post("/api/playlist-transfer/jobs/:id/import/qq", async (request, response, next) => {
    try {
      const ownerKey = await resolveBackgroundJobOwner(dependencies.getCurrentUserKey, response);
      if (ownerKey === null) {
        return;
      }
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
        response.json(toPublicPlaylistImportResult(
          result,
          job.summary.total - result.addedCount
        ));
      } catch {
        response.status(400).json(publicErrorResponse(PUBLIC_ERROR_MESSAGES.qqImport));
      }
    } catch (error) {
      next(toExpressError(error, "Failed to resolve QQ playlist import job"));
    }
  });

  return router;
}
