import type { DownloadQualityOption, Song } from "../types.js";

export type MusicPlatform = "netease" | "qq";

export type UnifiedArtist = {
  id?: string;
  name: string;
};

export type UnifiedAlbum = {
  id?: string;
  name: string;
  coverUrl?: string;
};

export type UnifiedTrack = {
  id: string;
  platform: MusicPlatform;
  title: string;
  artists: UnifiedArtist[];
  album: UnifiedAlbum;
  durationMs?: number;
  qualityLabel: string;
  availableQualities: DownloadQualityOption[];
  source: string;
};

export type UnifiedTrackSearchResult = {
  tracks: UnifiedTrack[];
};

export function toSongFromUnifiedTrack(track: UnifiedTrack): Song {
  const artistNames = track.artists.map((artist) => artist.name.trim()).filter(Boolean);

  return {
    id: track.id,
    title: track.title.trim() || "未知歌曲",
    artist: artistNames.join(" / ") || "未知歌手",
    primaryArtistId: track.artists[0]?.id,
    artists: track.artists.length > 0 ? track.artists : undefined,
    album: track.album.name.trim() || "未知专辑",
    albumId: track.album.id,
    coverUrl: track.album.coverUrl,
    duration: formatDuration(track.durationMs),
    quality: track.qualityLabel,
    availableQualities: track.availableQualities,
    source: track.source
  };
}

export function formatDuration(durationMs: number | undefined) {
  if (!durationMs || durationMs <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatImageUrl(url: string | undefined, size = 160) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}
