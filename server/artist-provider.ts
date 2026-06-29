import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import { getSettings } from "./settings-store.js";
import type { ArtistProfile, Song } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { toSongFromUnifiedTrack } from "./music-platform/types.js";

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

function formatImageUrl(url: string | undefined, size = 240) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}
function mapArtistSong(song: ArtistSong): Song | null {
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
      source: "netease-artist",
      coverUrl: song.al?.picUrl
    }
  );

  return unifiedTrack ? toSongFromUnifiedTrack(unifiedTrack) : null;
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
