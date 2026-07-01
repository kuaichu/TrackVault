import { createRequire } from "node:module";
import type { SearchType } from "NeteaseCloudMusicApi";
import { getSettings } from "./settings-store.js";
import type { DownloadQualityOption, PlaylistSongsPage, PlaylistTrackRemoveResult, Song, UserPlaylist } from "./types.js";
import { getNeteaseSongAvailability, type NeteasePrivilegeLike } from "./song-availability.js";

const require = createRequire(import.meta.url);
const { login_status, playlist_track_all, playlist_tracks, song_detail, user_playlist } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

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
  fee?: number;
  st?: number;
  cp?: number;
  copyright?: number;
  noCopyrightRcmd?: unknown | null;
  privilege?: NeteasePrivilegeLike | null;
};

type DetailSong = PlaylistTrack;
type QualityFlags = {
  h?: unknown | null;
  sq?: unknown | null;
  hr?: unknown | null;
};
type PlaylistSortMode = "default" | "title-asc" | "title-desc" | "artist-asc" | "artist-desc";

const PLAYLIST_PAGE_SIZE = 100;
const PLAYLIST_SEARCH_FETCH_BATCH_SIZE = 500;
const SONG_DETAIL_BATCH_SIZE = 300;
const PLAYLIST_PAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const PLAYLIST_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

const playlistPageCache = new Map<string, { expiresAt: number; page: PlaylistSongsPage }>();
const playlistSearchCache = new Map<string, { expiresAt: number; songs: Song[] }>();

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

    const body = response.body as { songs?: DetailSong[]; privileges?: NeteasePrivilegeLike[] };
    const songs = (body.songs ?? []) as DetailSong[];
    const privilegeMap = new Map((body.privileges ?? []).map((privilege) => [String((privilege as { id?: number | string }).id), privilege]));
    songs.forEach((song) => {
      song.privilege = privilegeMap.get(String(song.id)) ?? song.privilege;
    });
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

  return {
    id: String(track.id),
    title: track.name?.trim() || "未知歌曲",
    artist: track.ar?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") || "未知歌手",
    primaryArtistId: track.ar?.[0]?.id ? String(track.ar[0].id) : undefined,
    artists: track.ar?.map((artist) => ({
      id: artist.id ? String(artist.id) : undefined,
      name: artist.name?.trim() || "未知歌手"
    })).filter((artist) => artist.name),
    album: track.al?.name?.trim() || "未知专辑",
    albumId: track.al?.id ? String(track.al.id) : undefined,
    coverUrl: formatImageUrl(detail.al?.picUrl ?? track.al?.picUrl, 160),
    duration: formatDuration(track.dt),
    quality: getQualityLabel(detail),
    availableQualities: getAvailableQualities(detail),
    availability: getNeteaseSongAvailability(detail),
    source: "netease"
  } satisfies Song;
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

function normalizePlaylistSortMode(sortMode: string | undefined): PlaylistSortMode {
  const allowedModes: PlaylistSortMode[] = ["default", "title-asc", "title-desc", "artist-asc", "artist-desc"];
  return allowedModes.includes(sortMode as PlaylistSortMode) ? (sortMode as PlaylistSortMode) : "default";
}

function sortPlaylistSongs(songs: Song[], sortMode: PlaylistSortMode) {
  if (sortMode === "default") {
    return songs;
  }

  const compareText = (left: string, right: string) => left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  const sortedSongs = [...songs];

  sortedSongs.sort((left, right) => {
    switch (sortMode) {
      case "title-asc":
        return compareText(left.title, right.title);
      case "title-desc":
        return compareText(right.title, left.title);
      case "artist-asc":
        return compareText(left.artist, right.artist) || compareText(left.title, right.title);
      case "artist-desc":
        return compareText(right.artist, left.artist) || compareText(right.title, left.title);
      default:
        return 0;
    }
  });

  return sortedSongs;
}

function clearPlaylistSongCache(playlistId: string) {
  for (const key of playlistPageCache.keys()) {
    if (key.startsWith(`${playlistId}:`)) {
      playlistPageCache.delete(key);
    }
  }

  playlistSearchCache.delete(playlistId);
}

function getNeteaseApiErrorMessage(body: { code?: number; message?: string; msg?: string }, fallback: string) {
  if (body.code === 401) {
    return "登录态无效，请重新登录网易云账号。";
  }

  if (body.code === 502) {
    return body.message ?? body.msg ?? "网易云拒绝添加，可能是歌曲已在歌单中或歌曲 ID 不可用。";
  }

  return body.message ?? body.msg ?? fallback;
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

export async function getPlaylistSongs(playlistId: string, page = 1, limit = PLAYLIST_PAGE_SIZE, keyword = "", sortMode = "default"): Promise<PlaylistSongsPage> {
  const cookie = await getCookie();
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || PLAYLIST_PAGE_SIZE));
  const normalizedKeyword = keyword.trim();
  const normalizedSortMode = normalizePlaylistSortMode(sortMode);
  const cacheKey = `${playlistId}:${safePage}:${safeLimit}:${normalizedKeyword.toLocaleLowerCase()}:${normalizedSortMode}`;
  const cached = playlistPageCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.page;
  }

  if (normalizedKeyword || normalizedSortMode !== "default") {
    const allSongs = await getAllPlaylistSongsForSearch(playlistId, cookie);
    const filteredSongs = sortPlaylistSongs(filterPlaylistSongs(allSongs, normalizedKeyword), normalizedSortMode);
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

export async function addSongToUserPlaylist(playlistId: string, songId: string) {
  const safePlaylistId = playlistId.trim();
  const safeSongId = songId.trim();

  if (!safePlaylistId) {
    throw new Error("缺少目标歌单。");
  }

  if (!safeSongId) {
    throw new Error("缺少歌曲 ID。");
  }

  const cookie = await getCookie();
  const playlists = await getUserPlaylists();
  const targetPlaylist = playlists.find((playlist) => playlist.id === safePlaylistId);

  if (!targetPlaylist) {
    throw new Error("没有找到目标歌单，请刷新歌单列表后重试。");
  }

  if (!targetPlaylist.owned) {
    throw new Error("只能添加到自己创建的网易云歌单。");
  }

  const addResponse = await playlist_tracks({
    op: "add",
    pid: safePlaylistId,
    tracks: safeSongId,
    cookie
  });
  const body = addResponse.body as { code?: number; message?: string; msg?: string };

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(getNeteaseApiErrorMessage(body, `添加到歌单失败：${body.code}`));
  }

  clearPlaylistSongCache(safePlaylistId);

  return {
    playlistId: safePlaylistId,
    playlistName: targetPlaylist.name,
    songId: safeSongId,
    addedCount: 1
  };
}

export async function removeSongsFromUserPlaylist(playlistId: string, songIds: string[]): Promise<PlaylistTrackRemoveResult> {
  const safePlaylistId = playlistId.trim();
  const safeSongIds = [...new Set(songIds.map((songId) => songId.trim()).filter(Boolean))];

  if (!safePlaylistId) {
    throw new Error("缺少目标歌单。");
  }

  if (safeSongIds.length === 0) {
    throw new Error("请先选择要移除的歌曲。");
  }

  const cookie = await getCookie();
  const playlists = await getUserPlaylists();
  const targetPlaylist = playlists.find((playlist) => playlist.id === safePlaylistId);

  if (!targetPlaylist) {
    throw new Error("没有找到目标歌单，请刷新歌单列表后重试。");
  }

  if (!targetPlaylist.owned) {
    throw new Error("只能从自己创建的网易云歌单移除歌曲。");
  }

  const removeResponse = await playlist_tracks({
    op: "del",
    pid: safePlaylistId,
    tracks: safeSongIds.join(","),
    cookie
  });
  const body = removeResponse.body as { code?: number; message?: string; msg?: string };

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(getNeteaseApiErrorMessage(body, `从歌单移除失败：${body.code}`));
  }

  clearPlaylistSongCache(safePlaylistId);

  return {
    playlistId: safePlaylistId,
    playlistName: targetPlaylist.name,
    songIds: safeSongIds,
    removedCount: safeSongIds.length
  };
}
