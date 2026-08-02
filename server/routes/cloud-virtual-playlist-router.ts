import express from "express";
import {
  CloudVirtualPlaylistNotFoundError,
  CloudVirtualPlaylistValidationError,
  createCloudVirtualPlaylist,
  deleteCloudVirtualPlaylist,
  getCloudVirtualPlaylistState,
  moveCloudVirtualPlaylistSongs,
  renameCloudVirtualPlaylist
} from "../cloud-virtual-playlist-store.js";

export type CloudVirtualPlaylistRouterDependencies = {
  getDataScopeId: () => Promise<string>;
  getState?: (dataScopeId: string) => ReturnType<typeof getCloudVirtualPlaylistState> | Promise<ReturnType<typeof getCloudVirtualPlaylistState>>;
  createPlaylist?: (name: unknown, dataScopeId: string) => ReturnType<typeof createCloudVirtualPlaylist>;
  renamePlaylist?: (playlistId: string, name: unknown, dataScopeId: string) => ReturnType<typeof renameCloudVirtualPlaylist>;
  deletePlaylist?: (playlistId: string, dataScopeId: string) => ReturnType<typeof deleteCloudVirtualPlaylist>;
  moveSongs?: (songIds: unknown, playlistId: unknown, dataScopeId: string) => ReturnType<typeof moveCloudVirtualPlaylistSongs>;
};

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getErrorStatus(error: unknown) {
  if (error instanceof CloudVirtualPlaylistNotFoundError) {
    return 404;
  }
  if (error instanceof CloudVirtualPlaylistValidationError) {
    return 400;
  }
  return 500;
}

async function resolveRequestDataScope(
  request: express.Request,
  response: express.Response,
  getDataScopeId: CloudVirtualPlaylistRouterDependencies["getDataScopeId"]
) {
  const expectedDataScopeId = request.header("x-data-scope-id")?.trim() ?? "";
  const currentDataScopeId = await getDataScopeId();
  if (!expectedDataScopeId || expectedDataScopeId !== currentDataScopeId) {
    response.status(409).json({ message: "账号数据作用域已变化，请重试。" });
    return null;
  }

  return currentDataScopeId;
}

function getState(dependencies: CloudVirtualPlaylistRouterDependencies, dataScopeId: string) {
  return dependencies.getState?.(dataScopeId) ?? getCloudVirtualPlaylistState(dataScopeId);
}

function createPlaylist(dependencies: CloudVirtualPlaylistRouterDependencies, name: unknown, dataScopeId: string) {
  return dependencies.createPlaylist?.(name, dataScopeId) ?? createCloudVirtualPlaylist(name, dataScopeId);
}

function renamePlaylist(dependencies: CloudVirtualPlaylistRouterDependencies, playlistId: string, name: unknown, dataScopeId: string) {
  return dependencies.renamePlaylist?.(playlistId, name, dataScopeId) ?? renameCloudVirtualPlaylist(playlistId, name, dataScopeId);
}

function deletePlaylist(dependencies: CloudVirtualPlaylistRouterDependencies, playlistId: string, dataScopeId: string) {
  return dependencies.deletePlaylist?.(playlistId, dataScopeId) ?? deleteCloudVirtualPlaylist(playlistId, dataScopeId);
}

function moveSongs(dependencies: CloudVirtualPlaylistRouterDependencies, songIds: unknown, playlistId: unknown, dataScopeId: string) {
  return dependencies.moveSongs?.(songIds, playlistId, dataScopeId) ?? moveCloudVirtualPlaylistSongs(songIds, playlistId, dataScopeId);
}

export function createCloudVirtualPlaylistRouter(dependencies: CloudVirtualPlaylistRouterDependencies) {
  const router = express.Router();
  const basePath = "/api/cloud/virtual-playlists";

  router.get(basePath, async (request, response) => {
    try {
      const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
      if (!dataScopeId) return;
      response.json(await getState(dependencies, dataScopeId));
    } catch (error) {
      response.status(getErrorStatus(error)).json({ message: getErrorMessage(error, "获取云盘虚拟歌单失败") });
    }
  });

  router.post(basePath, async (request, response) => {
    try {
      const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
      if (!dataScopeId) return;
      const playlist = await createPlaylist(dependencies, request.body?.name, dataScopeId);
      response.status(201).json({ playlist });
    } catch (error) {
      response.status(getErrorStatus(error)).json({ message: getErrorMessage(error, "创建云盘虚拟歌单失败") });
    }
  });

  router.patch(`${basePath}/assignments`, async (request, response) => {
    try {
      const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
      if (!dataScopeId) return;
      const playlistId = request.body?.playlistId === null || typeof request.body?.playlistId === "string"
        ? request.body.playlistId
        : undefined;
      if (playlistId === undefined) {
        throw new CloudVirtualPlaylistValidationError("目标歌单引用无效。");
      }
      response.json(await moveSongs(dependencies, request.body?.songIds, playlistId, dataScopeId));
    } catch (error) {
      response.status(getErrorStatus(error)).json({ message: getErrorMessage(error, "移动云盘歌曲失败") });
    }
  });

  router.patch(`${basePath}/:id`, async (request, response) => {
    try {
      const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
      if (!dataScopeId) return;
      const playlist = await renamePlaylist(dependencies, request.params.id, request.body?.name, dataScopeId);
      response.json({ playlist });
    } catch (error) {
      response.status(getErrorStatus(error)).json({ message: getErrorMessage(error, "重命名云盘虚拟歌单失败") });
    }
  });

  router.delete(`${basePath}/:id`, async (request, response) => {
    try {
      const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
      if (!dataScopeId) return;
      response.json(await deletePlaylist(dependencies, request.params.id, dataScopeId));
    } catch (error) {
      response.status(getErrorStatus(error)).json({ message: getErrorMessage(error, "删除云盘虚拟歌单失败") });
    }
  });

  return router;
}
