import type { DownloadQualityOption, Song } from "./types.js";

type NeteaseArtistLike = {
  id?: number | string;
  name?: string;
};

type NeteaseAlbumLike = {
  id?: number | string;
  name?: string;
  picUrl?: string;
};

export type NeteaseSongLike = {
  id?: number | string;
  name?: string;
  dt?: number;
  duration?: number;
  ar?: NeteaseArtistLike[];
  artists?: NeteaseArtistLike[];
  al?: NeteaseAlbumLike;
  album?: NeteaseAlbumLike;
  h?: unknown | null;
  hMusic?: unknown | null;
  sq?: unknown | null;
  sqMusic?: unknown | null;
  hr?: unknown | null;
  hrMusic?: unknown | null;
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

function getQualityLabel(song: NeteaseSongLike) {
  if (song.hr || song.hrMusic) {
    return "Hi-Res";
  }

  if (song.sq || song.sqMusic) {
    return "FLAC";
  }

  if (song.h || song.hMusic) {
    return "320K";
  }

  return "128K";
}

function getAvailableQualities(song: NeteaseSongLike) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (song.h || song.hMusic) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if (song.sq || song.sqMusic) {
    qualities.push({ level: "lossless", label: "FLAC" });
  }

  if (song.hr || song.hrMusic) {
    qualities.push({ level: "hires", label: "Hi-Res" });
  }

  return qualities;
}

export function mapNeteaseSong(song: NeteaseSongLike, source: string): Song | null {
  if (!song.id || !song.name) {
    return null;
  }

  const artists = Array.isArray(song.ar) && song.ar.length > 0 ? song.ar : song.artists;
  const album = song.al ?? song.album;
  const cleanedArtists = artists
    ?.map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    }))
    .filter((artist) => artist.name);

  return {
    id: String(song.id),
    title: song.name.trim() || "未知歌曲",
    artist: cleanedArtists?.map((artist) => artist.name).join(" / ") || "未知歌手",
    primaryArtistId: cleanedArtists?.[0]?.id,
    artists: cleanedArtists,
    album: album?.name?.trim() || "未知专辑",
    albumId: album?.id ? String(album.id) : undefined,
    coverUrl: formatImageUrl(album?.picUrl, 160),
    duration: formatDuration(song.dt ?? song.duration),
    quality: getQualityLabel(song),
    availableQualities: getAvailableQualities(song),
    source
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function collectNeteaseSongs(value: unknown, source: string, limit = 30): Song[] {
  const songs: Song[] = [];
  const seenIds = new Set<string>();
  const seenObjects = new WeakSet<object>();
  const preferredKeys = ["data", "songs", "songList", "list", "items", "recommend", "recommendedSongs", "songInfo", "song", "mainSong"];

  const visit = (node: unknown, depth: number) => {
    if (songs.length >= limit || depth > 6 || node == null) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    if (seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    const mapped = mapNeteaseSong(node as NeteaseSongLike, source);
    if (mapped && !seenIds.has(mapped.id)) {
      seenIds.add(mapped.id);
      songs.push(mapped);
    }

    preferredKeys.forEach((key) => {
      if (key in node) {
        visit(node[key], depth + 1);
      }
    });
  };

  visit(value, 0);
  return songs.slice(0, limit);
}
