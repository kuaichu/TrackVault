import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import { getSettings } from "./settings-store.js";
import type { ArtistProfile, DownloadQualityOption, Song } from "./types.js";

const require = createRequire(import.meta.url);
const { artist_desc, artist_detail, artist_top_song, artists, search } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type ArtistInfoBody = {
  artist?: {
    id?: number;
    name?: string;
    picUrl?: string;
    cover?: string;
    musicSize?: number;
    albumSize?: number;
    mvSize?: number;
    briefDesc?: string;
  };
  hotSongs?: ArtistSong[];
};

type ArtistDetailBody = {
  data?: {
    artist?: {
      img1v1Url?: string;
      cover?: string;
      musicSize?: number;
      albumSize?: number;
      mvSize?: number;
      briefDesc?: string;
    };
  };
};

type ArtistDescBody = {
  briefDesc?: string;
  introduction?: Array<{
    txt?: string;
  }>;
};

type ArtistSong = {
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
  sq?: unknown | null;
  hr?: unknown | null;
};

type ArtistSearchBody = {
  result?: {
    artists?: Array<{
      id?: number;
      name?: string;
    }>;
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

function formatImageUrl(url: string | undefined, size = 240) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}

function getQualityLabel(song: ArtistSong) {
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

function getAvailableQualities(song: ArtistSong) {
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

function mapArtistSong(song: ArtistSong): Song | null {
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
    source: "netease-artist"
  };
}

async function getCookie() {
  const settings = await getSettings();
  return settings.neteaseCookie.trim();
}

export async function resolveArtistIdByName(name: string) {
  const keyword = name.split("/")[0]?.trim() ?? "";
  if (!keyword) {
    throw new Error("缺少歌手名称，无法解析歌手页面。");
  }

  const cookie = await getCookie();
  const response = await search({
    keywords: keyword,
    limit: 5,
    type: 100 as SearchType,
    ...(cookie ? { cookie } : {})
  });
  const body = response.body as ArtistSearchBody;
  const artists = body.result?.artists ?? [];
  const exactMatch =
    artists.find((artist) => artist.name?.trim() === keyword) ??
    artists.find((artist) => artist.name?.trim()?.includes(keyword));

  if (!exactMatch?.id) {
    throw new Error(`没有找到歌手：${keyword}`);
  }

  return {
    id: String(exactMatch.id),
    name: exactMatch.name?.trim() || keyword
  };
}

export async function getArtistProfile(artistId: string): Promise<ArtistProfile> {
  const cookie = await getCookie();
  const [artistInfoResponse, artistDetailResponse, artistDescResponse, artistTopSongsResponse] = await Promise.all([
    artists({ id: artistId, ...(cookie ? { cookie } : {}) }),
    artist_detail({ id: artistId, ...(cookie ? { cookie } : {}) }),
    artist_desc({ id: artistId, ...(cookie ? { cookie } : {}) }),
    artist_top_song({ id: artistId, ...(cookie ? { cookie } : {}) })
  ]);

  const artistInfoBody = artistInfoResponse.body as ArtistInfoBody;
  const artistDetailBody = artistDetailResponse.body as ArtistDetailBody;
  const artistDescBody = artistDescResponse.body as ArtistDescBody;
  const artist = artistInfoBody.artist;
  const detailArtist = artistDetailBody.data?.artist;
  const topSongsBody = artistTopSongsResponse.body as { songs?: ArtistSong[] };
  const description =
    artistDescBody.briefDesc?.trim() ||
    artistDescBody.introduction?.map((item) => item.txt?.trim()).filter(Boolean).join("\n\n") ||
    artist?.briefDesc?.trim() ||
    detailArtist?.briefDesc?.trim() ||
    "暂无歌手简介。";

  if (!artist?.id) {
    throw new Error("未获取到歌手信息。");
  }

  return {
    id: String(artist.id),
    name: artist.name?.trim() || "未知歌手",
    avatarUrl: formatImageUrl(detailArtist?.img1v1Url ?? artist.picUrl, 240),
    coverUrl: formatImageUrl(detailArtist?.cover ?? artist.cover, 360),
    description,
    musicCount: detailArtist?.musicSize ?? artist.musicSize ?? 0,
    albumCount: detailArtist?.albumSize ?? artist.albumSize ?? 0,
    mvCount: detailArtist?.mvSize ?? artist.mvSize ?? 0,
    topSongs: (topSongsBody.songs ?? []).map(mapArtistSong).filter((song): song is Song => Boolean(song))
  };
}
