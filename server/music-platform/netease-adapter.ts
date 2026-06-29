import type { DownloadQualityOption } from "../types.js";
import { formatImageUrl, type UnifiedTrack } from "./types.js";

type QualityFlags = {
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

export type NeteaseTrackInput = QualityFlags & {
  id?: number | string;
  name?: string;
  duration?: number;
  dt?: number;
  artists?: Array<{
    id?: number | string;
    name?: string;
  }>;
  ar?: Array<{
    id?: number | string;
    name?: string;
  }>;
  album?: {
    id?: number | string;
    name?: string;
    picUrl?: string;
  };
  al?: {
    id?: number | string;
    name?: string;
    picUrl?: string;
  };
};

export function getNeteaseQualityLabel(song: QualityFlags) {
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

export function getNeteaseAvailableQualities(song: QualityFlags) {
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

export function toUnifiedNeteaseTrack(
  input: NeteaseTrackInput,
  options: {
    source: string;
    coverUrl?: string;
  }
): UnifiedTrack | null {
  if (!input.id) {
    return null;
  }

  const artists = (input.ar ?? input.artists ?? [])
    .map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    }))
    .filter((artist) => artist.name);

  const album = input.al ?? input.album;

  return {
    id: String(input.id),
    platform: "netease",
    title: input.name?.trim() || "未知歌曲",
    artists,
    album: {
      id: album?.id ? String(album.id) : undefined,
      name: album?.name?.trim() || "未知专辑",
      coverUrl: formatImageUrl(options.coverUrl ?? album?.picUrl, 160)
    },
    durationMs: input.dt ?? input.duration,
    qualityLabel: getNeteaseQualityLabel(input),
    availableQualities: getNeteaseAvailableQualities(input),
    source: options.source
  };
}
