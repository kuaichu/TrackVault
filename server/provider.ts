import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import type { Song } from "./types.js";
import { getSettings } from "./settings-store.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { toSongFromUnifiedTrack } from "./music-platform/types.js";

const require = createRequire(import.meta.url);
const { search, song_detail } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

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

export async function searchProvider(query: string): Promise<Song[]> {
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
    const unifiedTrack = toUnifiedNeteaseTrack(
      {
        ...song,
        al: song.al ?? song.album,
        ar: song.ar ?? song.artists,
        h: detailSong?.h ?? song.h,
        sq: detailSong?.sq ?? song.sq,
        hr: detailSong?.hr ?? song.hr
      },
      {
        source: "netease",
        coverUrl: detailSong?.al?.picUrl ?? song.al?.picUrl ?? song.album?.picUrl
      }
    );

    if (!unifiedTrack) {
      return {
        id: String(song.id),
        title: song.name,
        artist:
          song.ar?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") ||
          song.artists?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") ||
          "未知歌手",
        primaryArtistId: song.ar?.[0]?.id ? String(song.ar[0].id) : song.artists?.[0]?.id ? String(song.artists[0].id) : undefined,
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
        duration: "00:00",
        quality: "128K",
        availableQualities: [{ level: "standard", label: "128K" }],
        source: "netease"
      };
    }

    return toSongFromUnifiedTrack(unifiedTrack);
  });
}
