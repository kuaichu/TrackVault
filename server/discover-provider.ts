import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { DownloadQualityOption, Song } from "./types.js";

const require = createRequire(import.meta.url);
const { personalized_newsong } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");
const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;

let discoverCache: { fetchedAt: number; songs: Song[] } | null = null;
let discoverRefreshPromise: Promise<Song[]> | null = null;

type PersonalizedNewSongItem = {
  song?: {
    id?: number;
    name?: string;
    duration?: number;
    artists?: Array<{
      id?: number;
      name?: string;
    }>;
    album?: {
      id?: number;
      name?: string;
      picUrl?: string;
    };
    hMusic?: unknown | null;
    sqMusic?: unknown | null;
    hrMusic?: unknown | null;
  };
};

type PersonalizedNewSongBody = {
  result?: PersonalizedNewSongItem[];
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

function getQualityLabel(song: NonNullable<PersonalizedNewSongItem["song"]>) {
  if (song.hrMusic) {
    return "Hi-Res";
  }

  if (song.sqMusic) {
    return "FLAC";
  }

  if (song.hMusic) {
    return "320K";
  }

  return "128K";
}

function getAvailableQualities(song: NonNullable<PersonalizedNewSongItem["song"]>) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (song.hMusic) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if (song.sqMusic) {
    qualities.push({ level: "lossless", label: "FLAC" });
  }

  if (song.hrMusic) {
    qualities.push({ level: "hires", label: "Hi-Res" });
  }

  return qualities;
}

function mapDiscoverSong(item: PersonalizedNewSongItem): Song | null {
  const song = item.song;
  if (!song?.id) {
    return null;
  }

  return {
    id: String(song.id),
    title: song.name?.trim() || "未知歌曲",
    artist: song.artists?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") || "未知歌手",
    primaryArtistId: song.artists?.[0]?.id ? String(song.artists[0].id) : undefined,
    artists: song.artists?.map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    })).filter((artist) => artist.name),
    album: song.album?.name?.trim() || "未知专辑",
    albumId: song.album?.id ? String(song.album.id) : undefined,
    coverUrl: formatImageUrl(song.album?.picUrl, 160),
    duration: formatDuration(song.duration),
    quality: getQualityLabel(song),
    availableQualities: getAvailableQualities(song),
    source: "netease-discover"
  };
}

async function fetchDiscoverSongs(): Promise<Song[]> {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  const response = await personalized_newsong({
    limit: 30,
    ...(cookie ? { cookie } : {})
  });
  const body = response.body as PersonalizedNewSongBody;

  return (body.result ?? []).map(mapDiscoverSong).filter((song): song is Song => Boolean(song));
}

async function refreshDiscoverCache() {
  if (!discoverRefreshPromise) {
    discoverRefreshPromise = fetchDiscoverSongs()
      .then((songs) => {
        discoverCache = {
          fetchedAt: Date.now(),
          songs
        };
        return songs;
      })
      .finally(() => {
        discoverRefreshPromise = null;
      });
  }

  return discoverRefreshPromise;
}

export async function getDiscoverSongs(): Promise<Song[]> {
  const cacheAge = discoverCache ? Date.now() - discoverCache.fetchedAt : Number.POSITIVE_INFINITY;

  if (discoverCache && cacheAge < DISCOVER_CACHE_TTL_MS) {
    return discoverCache.songs;
  }

  if (discoverCache) {
    void refreshDiscoverCache().catch(() => undefined);
    return discoverCache.songs;
  }

  return refreshDiscoverCache();
}
