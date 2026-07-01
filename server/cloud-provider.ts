import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { DownloadQualityOption, Song } from "./types.js";
import { getNeteaseSongAvailability, type NeteasePrivilegeLike } from "./song-availability.js";

const require = createRequire(import.meta.url);
const { user_cloud } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type CloudSongItem = {
  privateCloud?: {
    song?: string;
    artist?: string;
    album?: string;
    bitrate?: number;
    fileSize?: number;
  };
  simpleSong?: {
    id?: number;
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
    m?: unknown | null;
    l?: {
      br?: number;
    } | null;
    sq?: unknown | null;
    hr?: unknown | null;
    fee?: number;
    st?: number;
    cp?: number;
    copyright?: number;
    noCopyrightRcmd?: unknown | null;
    privilege?: NeteasePrivilegeLike | null;
  };
};

type CloudBody = {
  data?: CloudSongItem[];
  count?: number;
  size?: number;
  maxSize?: number;
  hasMore?: boolean;
};

const CLOUD_PAGE_SIZE = 500;

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

function getQualityLabel(song: NonNullable<CloudSongItem["simpleSong"]>) {
  if (song.hr) {
    return "Hi-Res";
  }

  if (song.sq) {
    return "FLAC";
  }

  if (song.h || song.l?.br && song.l.br >= 320000) {
    return "320K";
  }

  return "128K";
}

function getAvailableQualities(song: NonNullable<CloudSongItem["simpleSong"]>) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (song.h || song.l?.br && song.l.br >= 320000) {
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

function mapCloudSong(item: CloudSongItem): Song | null {
  const song = item.simpleSong;
  if (!song?.id) {
    return null;
  }

  const privateCloud = item.privateCloud;
  return {
    id: String(song.id),
    title: song.name?.trim() || privateCloud?.song?.trim() || "未知歌曲",
    artist: song.ar?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") || privateCloud?.artist?.trim() || "未知歌手",
    primaryArtistId: song.ar?.[0]?.id ? String(song.ar[0].id) : undefined,
    artists: song.ar?.map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    })).filter((artist) => artist.name),
    album: song.al?.name?.trim() || privateCloud?.album?.trim() || "云盘音乐",
    albumId: song.al?.id ? String(song.al.id) : undefined,
    coverUrl: formatImageUrl(song.al?.picUrl, 160),
    duration: formatDuration(song.dt),
    quality: getQualityLabel(song),
    availableQualities: getAvailableQualities(song),
    availability: getNeteaseSongAvailability(song),
    source: "netease-cloud"
  };
}

export async function getCloudSongs(): Promise<{ songs: Song[]; count: number; size: number; maxSize: number }> {
  const cookie = await getCookie();
  const songs: Song[] = [];
  let count = 0;
  let size = 0;
  let maxSize = 0;

  for (let offset = 0; ; offset += CLOUD_PAGE_SIZE) {
    const response = await user_cloud({
      limit: CLOUD_PAGE_SIZE,
      offset,
      cookie
    });
    const body = response.body as CloudBody;
    const pageSongs = body.data ?? [];
    count = body.count ?? count;
    size = body.size ?? size;
    maxSize = body.maxSize ?? maxSize;

    for (const item of pageSongs) {
      const mapped = mapCloudSong(item);
      if (mapped) {
        songs.push(mapped);
      }
    }

    if (!body.hasMore || pageSongs.length < CLOUD_PAGE_SIZE) {
      break;
    }
  }

  return {
    songs,
    count: count || songs.length,
    size,
    maxSize
  };
}
