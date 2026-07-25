import express from "express";
import type { SearchProviderMode } from "../provider.js";
import type { AppSettings, PersonalRadioKind, Song } from "../types.js";

export type MusicDiscoveryRouterDependencies = {
  searchProvider: (query: string, providerMode: SearchProviderMode) => Promise<Song[]>;
  getSettings: () => Promise<AppSettings>;
  getDiscoverSongs: () => Promise<Song[]>;
  getQqDiscoverSongs: () => Promise<Song[]>;
  getDailyRecommendSongs: () => Promise<Song[]>;
  getPersonalRadioSongs: (kind: PersonalRadioKind) => Promise<Song[]>;
  getHeartbeatSongs: (options: {
    songId: string;
    playlistId: string;
    startSongId?: string;
    count?: number;
  }) => Promise<Song[]>;
};

export function createMusicDiscoveryRouter(dependencies: MusicDiscoveryRouterDependencies) {
  const router = express.Router();

  router.get("/api/search", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q : "";
    const provider = typeof request.query.provider === "string" ? request.query.provider : "netease";
    const providerMode: SearchProviderMode = provider === "qq" || provider === "aggregate" ? provider : "netease";

    try {
      const results = await dependencies.searchProvider(query, providerMode);
      response.json({ results, provider: providerMode });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "搜索失败"
      });
    }
  });

  router.get("/api/discover/songs", async (_request, response) => {
    try {
      const settings = await dependencies.getSettings();
      response.json({
        songs: settings.providerMode === "qq"
          ? await dependencies.getQqDiscoverSongs()
          : await dependencies.getDiscoverSongs()
      });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取发现音乐失败"
      });
    }
  });

  router.get("/api/recommend/daily", async (_request, response) => {
    try {
      response.json({ songs: await dependencies.getDailyRecommendSongs() });
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取每日推荐失败"
      });
    }
  });

  router.get("/api/recommend/personal-radio", async (request, response) => {
    const kind: PersonalRadioKind = request.query.kind === "roaming" ? "roaming" : "radar";

    try {
      response.json({ kind, songs: await dependencies.getPersonalRadioSongs(kind) });
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取私人推荐失败"
      });
    }
  });

  router.get("/api/playmode/heartbeat", async (request, response) => {
    const songId = typeof request.query.id === "string" ? request.query.id : "";
    const playlistId = typeof request.query.pid === "string" ? request.query.pid : "";
    const startSongId = typeof request.query.sid === "string" ? request.query.sid : undefined;
    const count = Number(request.query.count);

    try {
      response.json({
        songs: await dependencies.getHeartbeatSongs({
          songId,
          playlistId,
          startSongId,
          count: Number.isFinite(count) ? count : undefined
        })
      });
    } catch (error) {
      response.status(songId && playlistId ? 401 : 400).json({
        message: error instanceof Error ? error.message : "获取心动模式歌曲失败"
      });
    }
  });

  return router;
}
