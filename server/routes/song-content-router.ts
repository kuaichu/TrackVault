import express from "express";
import type { getSongLyrics } from "../lyric-provider.js";
import type { MediaAccessError } from "../media-security.js";
import type {
  getQqSongLyrics,
  isQqMusicSong,
  probeQqSongAudio
} from "../qqmusic-provider.js";
import type { getNeteaseSongInsight } from "../song-insight-provider.js";
import type { isSongLiked, toggleSongLike } from "../song-like-provider.js";
import type { probeSongAudio } from "../task-store.js";
import type { DownloadQualityLevel, Song } from "../types.js";

export type SongContentRouterDependencies = {
  getSongLyrics: typeof getSongLyrics;
  getQqSongLyrics: typeof getQqSongLyrics;
  isQqMusicSong: typeof isQqMusicSong;
  probeQqSongAudio: typeof probeQqSongAudio;
  probeSongAudio: typeof probeSongAudio;
  getNeteaseSongInsight: typeof getNeteaseSongInsight;
  isSongLiked: typeof isSongLiked;
  toggleSongLike: typeof toggleSongLike;
  isMediaAccessError: (error: unknown) => error is MediaAccessError;
};

export function createSongContentRouter(dependencies: SongContentRouterDependencies) {
  const router = express.Router();

  router.get("/api/lyrics/:id", async (request, response) => {
    const source = typeof request.query.source === "string" ? request.query.source : "";
    const mediaId = typeof request.query.mediaId === "string" ? request.query.mediaId : undefined;

    try {
      response.json({
        lyrics: source === "qqmusic"
          ? await dependencies.getQqSongLyrics(request.params.id, mediaId)
          : await dependencies.getSongLyrics(request.params.id)
      });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取歌词失败"
      });
    }
  });

  router.post("/api/songs/audio-probe", async (request, response) => {
    const song = request.body?.song as Song | undefined;
    const level = typeof request.body?.level === "string" ? request.body.level : "standard";
    const mode = request.body?.mode === "download" ? "download" : "playback";
    const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

    if (!song?.id || !song?.title || !song?.artist) {
      response.status(400).json({ message: "缺少歌曲信息" });
      return;
    }

    try {
      response.json({
        probe: dependencies.isQqMusicSong(song)
          ? await dependencies.probeQqSongAudio(song, level as DownloadQualityLevel, mode)
          : await dependencies.probeSongAudio(song, level as DownloadQualityLevel, mode, userCookieOverride)
      });
    } catch (error) {
      response.status(dependencies.isMediaAccessError(error) ? error.status : 502).json({
        message: error instanceof Error ? error.message : "检测实际音源失败"
      });
    }
  });

  router.get("/api/songs/:id/insight", async (request, response) => {
    const source = typeof request.query.source === "string" ? request.query.source : "";

    try {
      if (source === "qqmusic") {
        response.json({
          insight: {
            songId: request.params.id,
            listening: { note: "QQ 音乐歌曲洞察暂未接入" },
            encyclopedia: { tags: [] }
          }
        });
        return;
      }

      response.json({ insight: await dependencies.getNeteaseSongInsight(request.params.id) });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取歌曲洞察失败"
      });
    }
  });

  router.get("/api/likes/:id", async (request, response) => {
    try {
      response.json({ liked: await dependencies.isSongLiked(request.params.id) });
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取喜欢状态失败"
      });
    }
  });

  router.post("/api/likes/:id", async (request, response) => {
    const liked = Boolean(request.body?.liked);

    try {
      response.json(await dependencies.toggleSongLike(request.params.id, liked));
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : liked ? "加入喜欢失败" : "取消喜欢失败"
      });
    }
  });

  return router;
}
