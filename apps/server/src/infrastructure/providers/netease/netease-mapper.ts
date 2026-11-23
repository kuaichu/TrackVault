import {
  type PlaylistSummary,
  type QualityOption,
  type Song,
  type SongComment,
  normalizeCoverUrl,
} from "#shared";
import { evaluateNeteaseAvailability } from "../../../domain/policies/song-availability.js";

export interface RawNeteaseArtist {
  id?: number | string;
  name?: string;
}

export interface RawNeteasePrivilege {
  id?: number | string;
  fee?: number | string | null;
  pl?: number | string | null;
  dl?: number | string | null;
  st?: number | string | null;
  cp?: number | string | null;
}

export interface RawNeteaseSong {
  id?: number | string;
  name?: string;
  ar?: RawNeteaseArtist[];
  artists?: RawNeteaseArtist[];
  al?: { id?: number | string; name?: string; picUrl?: string };
  album?: { id?: number | string; name?: string; picUrl?: string };
  dt?: number;
  duration?: number;
  fee?: number | string | null;
  st?: number | string | null;
  cp?: number | string | null;
  noCopyrightRcmd?: unknown;
  privilege?: RawNeteasePrivilege | null;
  hr?: unknown;
  sq?: unknown;
  h?: unknown;
  m?: unknown;
  l?: unknown;
  pc?: unknown;
}

export function truncateCodePoints(text: string, maxLength: number): string {
  const nativeFn = (text as { toWellFormed?: () => string }).toWellFormed;
  const safe = typeof nativeFn === "function" ? nativeFn.call(text) : text;
  const chars = Array.from(safe);
  if (chars.length <= maxLength) return safe;
  return maxLength > 3 ? `${chars.slice(0, maxLength - 3).join("")}...` : chars.slice(0, maxLength).join("");
}

export function formatDurationSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatNeteaseTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function deriveQualities(song: RawNeteaseSong): QualityOption[] {
  const list: QualityOption[] = [{ level: "standard", label: "128K" }];
  if (song.h || song.sq || song.hr) {
    list.push({ level: "exhigh", label: "320K" });
  }
  if (song.sq || song.hr) {
    list.push({ level: "lossless", label: "FLAC" });
  }
  if (song.hr) {
    list.push({ level: "hires", label: "Hi-Res" });
  }
  return list;
}

/**
 * Single canonical Netease Song mapper (replaces 7 drifted copies in v1).
 */
export function mapNeteaseSong(
  raw: RawNeteaseSong,
  options?: { privilege?: RawNeteasePrivilege | null; isCloud?: boolean },
): Song | null {
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : "";
  const rawTitle = raw.name?.trim() ?? "";
  if (!id || !rawTitle) return null;
  const title = truncateCodePoints(rawTitle, 500);

  const rawArtists = (raw.ar ?? raw.artists ?? []).slice(0, 100);
  const artists = rawArtists
    .map((artist) => ({
      id:
        artist.id !== undefined && artist.id !== null && String(artist.id) !== "0"
          ? String(artist.id)
          : undefined,
      name: truncateCodePoints(artist.name?.trim() ?? "", 200),
    }))
    .filter((artist) => Boolean(artist.name));

  const fullArtistText = artists.map((a) => a.name).join(" / ") || "未知歌手";
  const artistText = truncateCodePoints(fullArtistText, 900);
  const albumObj = raw.al ?? raw.album;
  const album = truncateCodePoints(albumObj?.name?.trim() || "未知专辑", 500);
  const albumId =
    albumObj?.id !== undefined && albumObj.id !== null && String(albumObj.id) !== "0"
      ? String(albumObj.id)
      : undefined;

  const durationMs = Number(raw.dt ?? raw.duration ?? 0);
  const durationSeconds = Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : 0;
  const availableQualities = deriveQualities(raw);
  const topQuality = availableQualities[availableQualities.length - 1]?.label ?? "128K";

  const privilege = options?.privilege ?? raw.privilege ?? null;
  const isCloud = Boolean(options?.isCloud || raw.pc);

  const availability = evaluateNeteaseAvailability({
    fee: privilege?.fee ?? raw.fee,
    pl: privilege?.pl,
    dl: privilege?.dl,
    st: privilege?.st ?? raw.st,
    cp: privilege?.cp ?? raw.cp,
    noCopyrightRcmd: raw.noCopyrightRcmd,
    isCloud,
  });

  return {
    id,
    platform: "netease",
    providerSongId: id,
    title,
    artist: artistText,
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : undefined,
    album,
    albumId,
    coverUrl: normalizeCoverUrl(albumObj?.picUrl, 400),
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    quality: topQuality,
    availableQualities,
    availability,
    isCloud: isCloud || undefined,
  };
}

export interface RawNeteasePlaylist {
  id?: number | string;
  name?: string;
  coverImgUrl?: string;
  trackCount?: number;
  description?: string | null;
  creator?: { userId?: number | string; nickname?: string };
}

export function mapNeteasePlaylist(raw: RawNeteasePlaylist, currentUid?: string): PlaylistSummary | null {
  const id = raw.id !== undefined && raw.id !== null ? String(raw.id).trim() : "";
  const name = raw.name?.trim() ?? "";
  if (!id || !name) return null;

  const creatorUid = raw.creator?.userId !== undefined ? String(raw.creator.userId) : "";
  return {
    id,
    platform: "netease",
    name,
    coverUrl: normalizeCoverUrl(raw.coverImgUrl, 300),
    trackCount: Math.max(0, Number(raw.trackCount ?? 0) || 0),
    creatorName: raw.creator?.nickname?.trim() || "网易云用户",
    owned: Boolean(currentUid && creatorUid && currentUid === creatorUid),
    description: raw.description?.trim() || undefined,
  };
}

export interface RawNeteaseComment {
  commentId?: number | string;
  user?: { userId?: number | string; nickname?: string; avatarUrl?: string };
  content?: string;
  time?: number;
  timeStr?: string;
  liked?: boolean;
  likedCount?: number;
  replyCount?: number;
}

export function mapNeteaseComment(raw: RawNeteaseComment): SongComment | null {
  const id = raw.commentId !== undefined && raw.commentId !== null ? String(raw.commentId).trim() : "";
  const content = raw.content?.trim() ?? "";
  if (!id || !content) return null;

  return {
    id,
    userId: raw.user?.userId !== undefined ? String(raw.user.userId) : "",
    nickname: raw.user?.nickname?.trim() || "网易云用户",
    avatarUrl: normalizeCoverUrl(raw.user?.avatarUrl, 120),
    content,
    timeText: raw.time ? formatNeteaseTime(raw.time) : (raw.timeStr?.trim() ?? ""),
    time: typeof raw.time === "number" ? raw.time : undefined,
    liked: Boolean(raw.liked),
    likedCount: Math.max(0, Number(raw.likedCount ?? 0) || 0),
    replyCount: Math.max(0, Number(raw.replyCount ?? 0) || 0),
  };
}
