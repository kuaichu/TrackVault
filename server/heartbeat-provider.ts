import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import { collectNeteaseSongs } from "./netease-song-mapper.js";
import type { Song } from "./types.js";

const require = createRequire(import.meta.url);
const { playmode_intelligence_list } = require("NeteaseCloudMusicApi") as {
  playmode_intelligence_list: (params: Record<string, unknown>) => Promise<{ body: unknown }>;
};

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

export async function getHeartbeatSongs(options: { songId: string; playlistId: string; startSongId?: string; count?: number }): Promise<Song[]> {
  const cookie = await getCookie();
  const songId = options.songId.trim();
  const playlistId = options.playlistId.trim();

  if (!songId || !playlistId) {
    throw new Error("心动模式需要当前歌曲和来源歌单。");
  }

  const response = await playmode_intelligence_list({
    cookie,
    id: songId,
    pid: playlistId,
    sid: options.startSongId?.trim() || songId,
    count: Math.min(12, Math.max(1, options.count ?? 6))
  });
  const songs = collectNeteaseSongs(response.body, "netease-heartbeat", 12).filter((song) => song.id !== songId);

  if (songs.length === 0) {
    throw new Error("暂时没有读取到心动模式歌曲。");
  }

  return songs;
}
