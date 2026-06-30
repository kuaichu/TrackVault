import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import type { DownloadQualityOption, Song } from "./types.js";
import { getSettings } from "./settings-store.js";
import { searchQqMusicSongs } from "./qqmusic-provider.js";

const require = createRequire(import.meta.url);
const { search, song_detail } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

export type SearchProviderMode = "netease" | "qq" | "aggregate";

type SearchSong = {
  id: number;
  name: string;
  dt?: number;
  duration?: number;
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
  album?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
  ar?: Array<{
    id?: number;
    name?: string;
  }>;
  artists?: Array<{
    id?: number;
    name?: string;
  }>;
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

type DetailSong = {
  id: number;
  al?: {
    picUrl?: string;
  };
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

type QualityFlags = {
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
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

function getQualityLabel(song: QualityFlags) {
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

function getAvailableQualities(song: QualityFlags) {
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

function formatCoverUrl(coverUrl: string | undefined) {
  const trimmed = coverUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=160y160`;
}

async function getSongDetailMap(songIds: string[]) {
  if (songIds.length === 0) {
    return new Map<string, DetailSong>();
  }

  const settings = await getSettings();
  const response = await song_detail({
    ids: songIds.join(","),
    cookie: settings.neteaseCookie || undefined
  });

  const songs = ((response.body as { songs?: DetailSong[] }).songs ?? []) as DetailSong[];
  return new Map(songs.map((song) => [String(song.id), song]));
}

async function searchNeteaseSongs(query: string): Promise<Song[]> {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }

  const result = await search({
    keywords: keyword,
    limit: 20,
    type: 1 as SearchType
  });

  const songs = ((result.body as {
    result?: {
      songs?: SearchSong[];
    };
  }).result?.songs ?? []) as SearchSong[];
  const detailMap = await getSongDetailMap(songs.map((song) => String(song.id)));

  return songs.map((song) => {
    const detailSong = detailMap.get(String(song.id));

    return {
      id: String(song.id),
      title: song.name,
      artist:
        song.ar?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") ||
        song.artists?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") ||
        "未知歌手",
      primaryArtistId: String(song.ar?.[0]?.id ?? song.artists?.[0]?.id ?? ""),
      artists:
        song.ar?.map((artist) => ({
          id: artist.id ? String(artist.id) : undefined,
          name: artist.name?.trim() || "未知歌手"
        })).filter((artist) => artist.name) ||
        song.artists?.map((artist) => ({
          id: artist.id ? String(artist.id) : undefined,
          name: artist.name?.trim() || "未知歌手"
        })).filter((artist) => artist.name) ||
        undefined,
      album: song.al?.name?.trim() || song.album?.name?.trim() || "未知专辑",
      albumId: song.al?.id ? String(song.al.id) : song.album?.id ? String(song.album.id) : undefined,
      coverUrl: formatCoverUrl(detailSong?.al?.picUrl ?? song.al?.picUrl ?? song.album?.picUrl),
      duration: formatDuration(song.dt ?? song.duration),
      quality: getQualityLabel(detailSong ?? song),
      availableQualities: getAvailableQualities(detailSong ?? song),
      source: "netease"
    };
  });
}

export async function searchProvider(query: string, providerMode: SearchProviderMode = "netease"): Promise<Song[]> {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }

  if (providerMode === "qq") {
    return searchQqMusicSongs(keyword);
  }

  if (providerMode === "aggregate") {
    const [neteaseResult, qqResult] = await Promise.allSettled([
      searchNeteaseSongs(keyword),
      searchQqMusicSongs(keyword)
    ]);

    const neteaseSongs = neteaseResult.status === "fulfilled" ? neteaseResult.value : [];
    const qqSongs = qqResult.status === "fulfilled" ? qqResult.value : [];

    if (neteaseSongs.length === 0 && qqSongs.length === 0) {
      const firstError = neteaseResult.status === "rejected" ? neteaseResult.reason : qqResult.status === "rejected" ? qqResult.reason : null;
      if (firstError) {
        throw firstError;
      }
    }

    return [...neteaseSongs, ...qqSongs];
  }

  return searchNeteaseSongs(keyword);
}
