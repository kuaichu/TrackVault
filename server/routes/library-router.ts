import express from "express";
import type {
  AppSettings,
  PlaylistSongsPage,
  PlaylistTrackRemoveResult,
  Song,
  UserPlaylist
} from "../types.js";

export type PlaylistProviderMode = "netease" | "qq";

type PlaylistTrackAddResult = {
  playlistId: string;
  playlistName: string;
  songId: string;
  addedCount: number;
};

type CloudSongsResult = {
  songs: Song[];
  count: number;
  size: number;
  maxSize: number;
};

export type LibraryRouterDependencies = {
  getSettings: () => Promise<AppSettings>;
  getUserPlaylists: () => Promise<UserPlaylist[]>;
  getQqUserPlaylists: () => Promise<UserPlaylist[]>;
  getPlaylistSongs: (
    playlistId: string,
    page: number,
    limit: number,
    keyword: string,
    sort: string
  ) => Promise<PlaylistSongsPage>;
  getQqPlaylistSongs: (
    playlistId: string,
    page: number,
    limit: number,
    keyword: string,
    sort: string
  ) => Promise<PlaylistSongsPage>;
  addSongToUserPlaylist: (playlistId: string, songId: string) => Promise<PlaylistTrackAddResult>;
  removeSongsFromUserPlaylist: (
    playlistId: string,
    songIds: string[]
  ) => Promise<PlaylistTrackRemoveResult>;
  getCloudSongs: () => Promise<CloudSongsResult>;
};

export function resolvePlaylistProvider(
  queryProvider: unknown,
  settings: Pick<AppSettings, "providerMode">
): PlaylistProviderMode {
  if (queryProvider === "qq") {
    return "qq";
  }

  if (queryProvider === "netease") {
    return "netease";
  }

  return settings.providerMode === "qq" ? "qq" : "netease";
}

export function createLibraryRouter(dependencies: LibraryRouterDependencies) {
  const router = express.Router();

  router.get("/api/playlists", async (request, response) => {
    try {
      const settings = await dependencies.getSettings();
      const provider = resolvePlaylistProvider(request.query.provider, settings);
      response.json({
        playlists: provider === "qq"
          ? await dependencies.getQqUserPlaylists()
          : await dependencies.getUserPlaylists()
      });
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取歌单失败"
      });
    }
  });

  router.get("/api/playlists/:id/songs", async (request, response) => {
    try {
      const page = Number(request.query.page);
      const limit = Number(request.query.limit);
      const keyword = typeof request.query.keyword === "string" ? request.query.keyword : "";
      const sort = typeof request.query.sort === "string" ? request.query.sort : "default";
      const settings = await dependencies.getSettings();
      const provider = resolvePlaylistProvider(request.query.provider, settings);
      response.json(
        provider === "qq"
          ? await dependencies.getQqPlaylistSongs(request.params.id, page, limit, keyword, sort)
          : await dependencies.getPlaylistSongs(request.params.id, page, limit, keyword, sort)
      );
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取歌单歌曲失败"
      });
    }
  });

  router.post("/api/playlists/:id/tracks", async (request, response) => {
    const songId = typeof request.body?.songId === "string" ? request.body.songId : "";

    try {
      const settings = await dependencies.getSettings();
      if (settings.providerMode === "qq") {
        response.status(501).json({ message: "QQ 音乐收藏到歌单暂未接入。" });
        return;
      }

      response.status(201).json(await dependencies.addSongToUserPlaylist(request.params.id, songId));
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "添加到歌单失败"
      });
    }
  });

  router.delete("/api/playlists/:id/tracks", async (request, response) => {
    const songIds = Array.isArray(request.body?.songIds)
      ? request.body.songIds.filter((songId: unknown): songId is string => typeof songId === "string")
      : [];

    try {
      const settings = await dependencies.getSettings();
      if (settings.providerMode === "qq") {
        response.status(501).json({ message: "QQ 音乐歌单删除暂未接入。" });
        return;
      }

      response.json(await dependencies.removeSongsFromUserPlaylist(request.params.id, songIds));
    } catch (error) {
      response.status(400).json({
        message: error instanceof Error ? error.message : "从歌单移除失败"
      });
    }
  });

  router.get("/api/cloud/songs", async (_request, response) => {
    try {
      response.json(await dependencies.getCloudSongs());
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取云盘音乐失败"
      });
    }
  });

  return router;
}
