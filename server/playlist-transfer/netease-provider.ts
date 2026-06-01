import { getPlaylistSongs } from "../playlist-provider.js";
import { searchProvider } from "../provider.js";
import { assertDownloadAccess } from "../task-store.js";
import type { Song } from "../types.js";
import type { ProviderTrack, TransferTrack } from "./types.js";

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
