import express from "express";
import type { MediaAccessError } from "../media-security.js";
import type {
  assertDownloadAccess,
  createTask,
  getAllTasks,
  getTaskFileForDownload
} from "../task-store.js";
import type { DownloadRequest } from "../types.js";

export type DownloadTaskRouterDependencies = {
  getAllTasks: typeof getAllTasks;
  getTaskFileForDownload: typeof getTaskFileForDownload;
  assertDownloadAccess: typeof assertDownloadAccess;
  createTask: typeof createTask;
  isMediaAccessError: (error: unknown) => error is MediaAccessError;
};

export function createDownloadTaskRouter(dependencies: DownloadTaskRouterDependencies) {
  const router = express.Router();

  router.get("/api/tasks", async (_request, response) => {
    response.json(await dependencies.getAllTasks());
  });

  router.get("/api/tasks/:taskId/file", async (request, response) => {
    const file = await dependencies.getTaskFileForDownload(request.params.taskId);

    if (!file) {
      response.status(404).json({ message: "下载文件不存在或无权访问" });
      return;
    }

    response.download(file.filePath, file.filename, (error) => {
      if (!error || response.headersSent) {
        return;
      }

      response.status(500).json({ message: "读取下载文件失败" });
    });
  });

  router.post("/api/download", async (request, response) => {
    const payload = request.body as DownloadRequest;
    const song = payload?.song;
    const level = payload?.level;
    const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

    if (!song?.id || !song?.title || !song?.artist) {
      response.status(400).json({ message: "缺少歌曲信息" });
      return;
    }

    if (!level) {
      response.status(400).json({ message: "缺少下载音质" });
      return;
    }

    try {
      await dependencies.assertDownloadAccess(song, level, userCookieOverride);
      const task = await dependencies.createTask(song, level);
      response.status(201).json(task);
    } catch (error) {
      response.status(dependencies.isMediaAccessError(error) ? error.status : 502).json({
        message: error instanceof Error ? error.message : "加入下载队列失败"
      });
    }
  });

  return router;
}
