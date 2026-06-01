import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { DownloadQualityOption, Song } from "./types.js";

const require = createRequire(import.meta.url);
const { recommend_songs } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type RecommendSong = {
  id: number;
  name?: string;
  dt?: number;
  ar?: Array<{
    id?: number;
    name?: string;
  }>;
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

type RecommendBody = {
  data?: {
    dailySongs?: RecommendSong[];
  };
};

function formatDuration(durationMs: number | undefined) {
  if (!durationMs || durationMs <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatImageUrl(url: string | undefined, size = 160) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}

function getQualityLabel(song: RecommendSong) {
  if (song.hr) {
    return "Hi-Res";
  }

  if (song.sq) {
    return "FLAC";
  }

  if (song.h) {
    return "320K";
  }

  return "128K";
}

function getAvailableQualities(song: RecommendSong) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (song.h) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if (song.sq) {
    qualities.push({ level: "lossless", label: "FLAC" });
  }

  if (song.hr) {
    qualities.push({ level: "hires", label: "Hi-Res" });
  }

  return qualities;
}

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

function mapRecommendSong(song: RecommendSong): Song {
  return {
    id: String(song.id),
    title: song.name?.trim() || "未知歌曲",
    artist: song.ar?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") || "未知歌手",
    primaryArtistId: song.ar?.[0]?.id ? String(song.ar[0].id) : undefined,
    artists: song.ar?.map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    })).filter((artist) => artist.name),
    album: song.al?.name?.trim() || "未知专辑",
    albumId: song.al?.id ? String(song.al.id) : undefined,
    coverUrl: formatImageUrl(song.al?.picUrl, 160),
    duration: formatDuration(song.dt),
    quality: getQualityLabel(song),
    availableQualities: getAvailableQualities(song),
    source: "netease-daily"
  };
}

export async function getDailyRecommendSongs(): Promise<Song[]> {
  const cookie = await getCookie();
  const response = await recommend_songs({ cookie });
  const body = response.body as RecommendBody;

  return (body.data?.dailySongs ?? []).map(mapRecommendSong);
}
