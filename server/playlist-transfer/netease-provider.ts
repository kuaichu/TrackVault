import { createRequire } from "node:module";
import { getPlaylistSongs, getUserPlaylists } from "../playlist-provider.js";
import { searchProvider } from "../provider.js";
import { getSettings } from "../settings-store.js";
import { assertDownloadAccess } from "../task-store.js";
import type { Song } from "../types.js";
import type { NeteaseAuditSourceEntry, NeteaseRawPlaylistTrack, NeteaseRawPrivilege } from "./netease-import-audit.js";
import type { ProviderTrack, TransferTrack } from "./types.js";

const require = createRequire(import.meta.url);
const { playlist_create, playlist_track_all, playlist_tracks } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

function parseDurationSeconds(duration: string | undefined) {
  const [minutesText, secondsText] = (duration ?? "").split(":");
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return undefined;
  }

  return minutes * 60 + seconds;
}

function songToTransferTrack(song: Song): TransferTrack {
  return {
    source: "netease",
    sourceTrackId: song.id,
    title: song.title,
    artists: song.artists?.map((artist) => artist.name).filter(Boolean) ?? song.artist.split("/").map((artist) => artist.trim()).filter(Boolean),
    album: song.album,
    durationSeconds: parseDurationSeconds(song.duration)
  };
}

function songToProviderTrack(song: Song): ProviderTrack {
  return {
    provider: "netease",
    id: song.id,
    title: song.title,
    artists: song.artists?.map((artist) => artist.name).filter(Boolean) ?? song.artist.split("/").map((artist) => artist.trim()).filter(Boolean),
    album: song.album,
    durationSeconds: parseDurationSeconds(song.duration),
    raw: song
  };
}

function getNeteaseApiErrorMessage(body: { code?: number; message?: string; msg?: string }, fallback: string) {
  if (body.code === 401) {
    return "无权限操作歌单";
  }

  return body.message ?? body.msg ?? fallback;
}

export async function loadNeteasePlaylistTransferTracks(playlistId: string) {
  const tracks: TransferTrack[] = [];
  const limit = 100;
  let page = 1;

  while (page <= 100) {
    const pageData = await getPlaylistSongs(playlistId, page, limit, "");
    tracks.push(...pageData.songs.map(songToTransferTrack));
    if (!pageData.hasMore || pageData.songs.length === 0) {
      break;
    }
    page += 1;
  }

  return tracks;
}

export async function searchNeteaseProviderTracks(track: TransferTrack) {
  const query = [track.title, track.artists[0]].filter(Boolean).join(" ");
  const songs = await searchProvider(query);
  return songs.map(songToProviderTrack);
}

export async function searchNeteaseProviderTracksByTitle(track: TransferTrack) {
  const songs = await searchProvider(track.title);
  return songs.map(songToProviderTrack);
}

export async function checkNeteaseProviderTrackAvailability(candidate: { raw?: unknown }) {
  const song = candidate.raw as Song | undefined;
  if (!song?.id) {
    return null;
  }

  try {
    await assertDownloadAccess(song, "standard");
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "目标歌曲不可用";
    if (message.includes("试听片段")) {
      return { status: "trial_only" as const, reason: message };
    }
    if (message.includes("VIP") || message.includes("会员") || message.includes("权限")) {
      return { status: "vip_only" as const, reason: message };
    }
    return { status: "copyright_unavailable" as const, reason: message };
  }
}

export async function createNeteasePlaylistFromTrackIds(name: string, trackIds: string[]) {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("创建网易云歌单需要有效 Cookie。");
  }

  if (trackIds.length === 0) {
    throw new Error("没有可导入网易云的已匹配歌曲。");
  }

  const createResponse = await playlist_create({
    name,
    privacy: 0,
    cookie
  });
  const body = createResponse.body as { code?: number; message?: string; msg?: string; id?: number | string; playlist?: { id?: number | string } };
  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(getNeteaseApiErrorMessage(body, `网易云歌单创建失败：${body.code}`));
  }

  const playlistId = String(body.id ?? body.playlist?.id ?? "");
  if (!playlistId) {
    throw new Error("网易云歌单创建成功但未返回歌单 ID。");
  }

  const addedCount = await addTrackIdsToNeteasePlaylist(playlistId, trackIds, cookie, `网易云已创建歌单 ${playlistId}，但添加歌曲失败`);

  return {
    playlistId,
    playlistName: name,
    playlistUrl: `https://music.163.com/#/playlist?id=${encodeURIComponent(playlistId)}`,
    addedCount
  };
}

async function addTrackIdsToNeteasePlaylist(playlistId: string, trackIds: string[], cookie: string, failurePrefix = "网易云拒绝添加歌曲") {
  const batchSize = 500;
  for (let index = 0; index < trackIds.length; index += batchSize) {
    const batch = trackIds.slice(index, index + batchSize);
    const addResponse = await playlist_tracks({
      op: "add",
      pid: playlistId,
      tracks: batch.join(","),
      cookie
    });
    const addBody = addResponse.body as { code?: number; message?: string; msg?: string };
    if (typeof addBody.code === "number" && addBody.code !== 200) {
      const message = getNeteaseApiErrorMessage(addBody, `网易云拒绝添加歌曲：${addBody.code}`);
      throw new Error(`${failurePrefix}：${message}。请复制正常可播文字歌单导入。`);
    }
  }

  return trackIds.length;
}

export async function addNeteaseTrackIdsToExistingPlaylist(playlistId: string, trackIds: string[]) {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("导入网易云歌单需要有效 Cookie。");
  }

  if (trackIds.length === 0) {
    throw new Error("没有可导入网易云的已匹配歌曲。");
  }

  const safePlaylistId = playlistId.trim();
  if (!safePlaylistId) {
    throw new Error("请选择要导入的网易云目标歌单。");
  }

  const playlists = await getUserPlaylists();
  const targetPlaylist = playlists.find((playlist) => playlist.id === safePlaylistId);
  if (!targetPlaylist) {
    throw new Error("没有找到目标网易云歌单，请刷新歌单列表后重试。");
  }

  if (!targetPlaylist.owned) {
    throw new Error("只能导入到自己创建的网易云歌单。");
  }

  const addedCount = await addTrackIdsToNeteasePlaylist(safePlaylistId, trackIds, cookie);

  return {
    playlistId: safePlaylistId,
    playlistName: targetPlaylist.name,
    playlistUrl: `https://music.163.com/#/playlist?id=${encodeURIComponent(safePlaylistId)}`,
    addedCount
  };
}

export async function loadNeteasePlaylistAuditEntries(playlistId: string, maxTracks = 300): Promise<NeteaseAuditSourceEntry[]> {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("扫描网易云导入歌单需要有效 Cookie。");
  }

  const safeMaxTracks = Math.min(1000, Math.max(1, Math.trunc(maxTracks) || 300));
  const entries: NeteaseAuditSourceEntry[] = [];
  const batchSize = Math.min(300, safeMaxTracks);
  let offset = 0;

  while (entries.length < safeMaxTracks) {
    const response = await playlist_track_all({
      id: playlistId,
      limit: Math.min(batchSize, safeMaxTracks - entries.length),
      offset,
      cookie
    });
    const body = response.body as {
      songs?: NeteaseRawPlaylistTrack[];
      privileges?: NeteaseRawPrivilege[];
    };
    const songs = body.songs ?? [];
    const privileges = new Map((body.privileges ?? []).map((privilege) => [String(privilege.id), privilege]));

    for (const track of songs) {
      entries.push({
        track,
        privilege: privileges.get(String(track.id))
      });
    }

    if (songs.length === 0 || songs.length < batchSize) {
      break;
    }

    offset += songs.length;
  }

  return entries;
}
