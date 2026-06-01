import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { AlbumProfile, DownloadQualityOption, Song } from "./types.js";

const require = createRequire(import.meta.url);
const { album, album_detail_dynamic } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type AlbumArtist = {
  id?: number;
  name?: string;
};

type AlbumSong = {
  id?: number;
  name?: string;
  dt?: number;
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
  ar?: AlbumArtist[];
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

type AlbumBody = {
  code?: number;
  songs?: AlbumSong[];
  album?: {
    id?: number;
    name?: string;
    picUrl?: string;
    description?: string;
    briefDesc?: string;
    company?: string;
    publishTime?: number;
    size?: number;
    artist?: AlbumArtist | null;
  };
};

type AlbumDynamicBody = {
  subCount?: number;
  commentCount?: number;
  shareCount?: number;
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

function getQualityLabel(song: { h?: unknown | null; sq?: unknown | null; hr?: unknown | null }) {
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

function getAvailableQualities(song: { h?: unknown | null; sq?: unknown | null; hr?: unknown | null }) {
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

function mapAlbumSong(song: AlbumSong): Song | null {
  if (!song.id) {
    return null;
  }

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
    source: "netease-album"
  };
}

function formatPublishDate(timestamp: number | undefined) {
  if (!timestamp) {
    return undefined;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export async function getAlbumProfile(albumId: string): Promise<AlbumProfile> {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  const [albumResponse, dynamicResponse] = await Promise.all([
    album({ id: albumId, ...(cookie ? { cookie } : {}) }),
    album_detail_dynamic({ id: albumId, ...(cookie ? { cookie } : {}) }).catch(() => ({ body: {} }))
  ]);

  const body = albumResponse.body as AlbumBody;
  const albumInfo = body.album;

  if (!albumInfo?.id) {
    throw new Error("未找到该专辑信息。");
  }

  const songs = (body.songs ?? []).map(mapAlbumSong).filter((song): song is Song => Boolean(song));
  const dynamic = dynamicResponse.body as AlbumDynamicBody;

  return {
    id: String(albumInfo.id),
    name: albumInfo.name?.trim() || "未知专辑",
    coverUrl: formatImageUrl(albumInfo.picUrl, 240),
    description: albumInfo.description?.trim() || albumInfo.briefDesc?.trim() || "暂无专辑简介。",
    artist: albumInfo.artist?.name?.trim() || songs[0]?.artist || "未知歌手",
    artistId: albumInfo.artist?.id ? String(albumInfo.artist.id) : songs[0]?.primaryArtistId,
    company: albumInfo.company?.trim() || undefined,
    publishDate: formatPublishDate(albumInfo.publishTime),
    trackCount: albumInfo.size ?? songs.length,
    likedCount: typeof dynamic.subCount === "number" ? dynamic.subCount : undefined,
    commentCount: typeof dynamic.commentCount === "number" ? dynamic.commentCount : undefined,
    shareCount: typeof dynamic.shareCount === "number" ? dynamic.shareCount : undefined,
    songs
  };
}
