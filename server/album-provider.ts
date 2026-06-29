import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { AlbumProfile, Song } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { formatImageUrl, toSongFromUnifiedTrack } from "./music-platform/types.js";

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

function mapAlbumSong(song: AlbumSong): Song | null {
  const unifiedTrack = toUnifiedNeteaseTrack(
    {
      id: song.id,
      name: song.name,
      dt: song.dt,
      ar: song.ar,
      al: song.al,
      h: song.h,
      sq: song.sq,
      hr: song.hr
    },
    {
      source: "netease-album",
      coverUrl: song.al?.picUrl
    }
  );

  return unifiedTrack ? toSongFromUnifiedTrack(unifiedTrack) : null;
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
