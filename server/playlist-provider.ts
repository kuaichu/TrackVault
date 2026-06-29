import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import { getSettings } from "./settings-store.js";
import type { PlaylistSongsPage, Song, UserPlaylist } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { formatImageUrl, toSongFromUnifiedTrack } from "./music-platform/types.js";

const require = createRequire(import.meta.url);
const { login_status, playlist_track_all, song_detail, user_playlist } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type LoginStatusBody = {
  data?: {
    account?: {
      id?: number;
    } | null;
    profile?: {
      userId?: number;
      nickname?: string;
    } | null;
  };
  account?: {
    id?: number;
  } | null;
  profile?: {
    userId?: number;
    nickname?: string;
  } | null;
};

type NeteasePlaylist = {
  id: number;
  name?: string;
  coverImgUrl?: string;
  trackCount?: number;
  playCount?: number;
  subscribed?: boolean;
  creator?: {
    userId?: number;
    nickname?: string;
  };
};

type PlaylistTrack = {
  id: number;
  name?: string;
  dt?: number;
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
  ar?: Array<{
    id?: number;
    name?: string;
  }>;
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};

type DetailSong = PlaylistTrack;
const PLAYLIST_PAGE_SIZE = 100;
const PLAYLIST_SEARCH_FETCH_BATCH_SIZE = 500;
const SONG_DETAIL_BATCH_SIZE = 300;
const PLAYLIST_PAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const PLAYLIST_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

const playlistPageCache = new Map<string, { expiresAt: number; page: PlaylistSongsPage }>();
const playlistSearchCache = new Map<string, { expiresAt: number; songs: Song[] }>();

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

async function getLoggedInUser(cookie: string) {
  const response = await login_status({ cookie });
  const body = response.body as LoginStatusBody;
  const userId = body.data?.profile?.userId ?? body.data?.account?.id ?? body.profile?.userId ?? body.account?.id;

  if (!userId) {
    throw new Error("Cookie 未通过登录态校验，请重新复制网易云 Cookie。");
  }

  return {
    userId,
    nickname: body.data?.profile?.nickname ?? body.profile?.nickname ?? "网易云账号"
  };
}

async function getSongDetailMap(songIds: string[], cookie: string) {
  if (songIds.length === 0) {
    return new Map<string, DetailSong>();
  }

  const detailMap = new Map<string, DetailSong>();

  for (let index = 0; index < songIds.length; index += SONG_DETAIL_BATCH_SIZE) {
    const batch = songIds.slice(index, index + SONG_DETAIL_BATCH_SIZE);
    const response = await song_detail({
      ids: batch.join(","),
      cookie,
      type: 1 as SearchType
    } as any);

    const songs = ((response.body as { songs?: DetailSong[] }).songs ?? []) as DetailSong[];
    for (const song of songs) {
      detailMap.set(String(song.id), song);
    }
  }

  return detailMap;
}

async function getPlaylistTracksPage(playlistId: string, cookie: string, page: number, limit: number) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || PLAYLIST_PAGE_SIZE));
  const offset = (safePage - 1) * safeLimit;

  const response = await playlist_track_all({
    id: playlistId,
    limit: safeLimit,
    offset,
    cookie
  });

  const songs = ((response.body as { songs?: PlaylistTrack[] }).songs ?? []) as PlaylistTrack[];
  return {
    songs,
    page: safePage,
    limit: safeLimit,
    hasMore: songs.length === safeLimit
  };
}

function mapTrackToSong(track: PlaylistTrack, detailMap: Map<string, DetailSong>) {
  const detail = detailMap.get(String(track.id)) ?? track;
  const unifiedTrack = toUnifiedNeteaseTrack(
    {
      id: track.id,
      name: track.name,
      dt: track.dt,
      ar: track.ar,
      al: track.al,
      h: detail.h ?? track.h,
      sq: detail.sq ?? track.sq,
      hr: detail.hr ?? track.hr
    },
    {
      source: "netease",
      coverUrl: detail.al?.picUrl ?? track.al?.picUrl
    }
  );

  if (!unifiedTrack) {
    return {
      id: String(track.id),
      title: track.name?.trim() || "未知歌曲",
      artist: "未知歌手",
      album: track.al?.name?.trim() || "未知专辑",
      albumId: track.al?.id ? String(track.al.id) : undefined,
      coverUrl: formatImageUrl(detail.al?.picUrl ?? track.al?.picUrl, 160),
      duration: "00:00",
      quality: "128K",
      availableQualities: [{ level: "standard", label: "128K" }],
      source: "netease"
    } satisfies Song;
  }

  return toSongFromUnifiedTrack(unifiedTrack);
}

async function getAllPlaylistSongsForSearch(playlistId: string, cookie: string) {
  const cached = playlistSearchCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.songs;
  }

  const tracks: PlaylistTrack[] = [];
  let offset = 0;

  while (true) {
    const response = await playlist_track_all({
      id: playlistId,
      limit: PLAYLIST_SEARCH_FETCH_BATCH_SIZE,
      offset,
      cookie
    });

    const batch = ((response.body as { songs?: PlaylistTrack[] }).songs ?? []) as PlaylistTrack[];
    if (batch.length === 0) {
      break;
    }

    tracks.push(...batch);

    if (batch.length < PLAYLIST_SEARCH_FETCH_BATCH_SIZE) {
      break;
    }

    offset += batch.length;
  }

  const detailMap = await getSongDetailMap(tracks.map((song) => String(song.id)), cookie);
  const songs = tracks.map((track) => mapTrackToSong(track, detailMap));

  playlistSearchCache.set(playlistId, {
    expiresAt: Date.now() + PLAYLIST_SEARCH_CACHE_TTL_MS,
    songs
  });

  return songs;
}

function filterPlaylistSongs(songs: Song[], keyword: string) {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  if (!normalizedKeyword) {
    return songs;
  }

  return songs.filter((song) =>
    [song.title, song.artist, song.album].some((field) => field.toLocaleLowerCase().includes(normalizedKeyword))
  );
}

export async function getUserPlaylists(): Promise<UserPlaylist[]> {
  const cookie = await getCookie();
  const user = await getLoggedInUser(cookie);
  const response = await user_playlist({
    uid: user.userId,
    limit: 50,
    offset: 0,
    cookie
  });

  const playlists = ((response.body as { playlist?: NeteasePlaylist[] }).playlist ?? []) as NeteasePlaylist[];

  return playlists.map((playlist) => {
    const creatorId = playlist.creator?.userId;

    return {
      id: String(playlist.id),
      name: playlist.name?.trim() || "未命名歌单",
      coverUrl: formatImageUrl(playlist.coverImgUrl, 180),
      trackCount: playlist.trackCount ?? 0,
      creatorName: playlist.creator?.nickname?.trim() || user.nickname,
      playCount: playlist.playCount ?? 0,
      owned: creatorId ? creatorId === user.userId : !playlist.subscribed
    };
  });
}

export async function getPlaylistSongs(playlistId: string, page = 1, limit = PLAYLIST_PAGE_SIZE, keyword = ""): Promise<PlaylistSongsPage> {
  const cookie = await getCookie();
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || PLAYLIST_PAGE_SIZE));
  const normalizedKeyword = keyword.trim();
  const cacheKey = `${playlistId}:${safePage}:${safeLimit}:${normalizedKeyword.toLocaleLowerCase()}`;
  const cached = playlistPageCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.page;
  }

  if (normalizedKeyword) {
    const allSongs = await getAllPlaylistSongsForSearch(playlistId, cookie);
    const filteredSongs = filterPlaylistSongs(allSongs, normalizedKeyword);
    const offset = (safePage - 1) * safeLimit;
    const songs = filteredSongs.slice(offset, offset + safeLimit);
    const pageResult: PlaylistSongsPage = {
      songs,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + songs.length < filteredSongs.length,
      total: filteredSongs.length,
      sourceTotal: allSongs.length,
      keyword: normalizedKeyword
    };

    playlistPageCache.set(cacheKey, {
      expiresAt: Date.now() + PLAYLIST_PAGE_CACHE_TTL_MS,
      page: pageResult
    });

    return pageResult;
  }

  const trackPage = await getPlaylistTracksPage(playlistId, cookie, safePage, safeLimit);
  const detailMap = await getSongDetailMap(trackPage.songs.map((song) => String(song.id)), cookie);
  const songs = trackPage.songs.map((track) => mapTrackToSong(track, detailMap));

  const pageResult: PlaylistSongsPage = {
    songs,
    page: trackPage.page,
    limit: trackPage.limit,
    hasMore: trackPage.hasMore,
    total: songs.length,
    keyword: ""
  };

  playlistPageCache.set(cacheKey, {
    expiresAt: Date.now() + PLAYLIST_PAGE_CACHE_TTL_MS,
    page: pageResult
  });

  return pageResult;
}
