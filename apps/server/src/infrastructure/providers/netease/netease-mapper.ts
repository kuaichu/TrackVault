import {
  type PlaylistSummary,
  type QualityOption,
  type Song,
  type SongComment,
  formatDurationSeconds,
  formatTimestampText,
  normalizeCoverUrl,
  truncateCodePoints,
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
  maxbr?: number | string | null;
  playMaxbr?: number | string | null;
  maxBrLevel?: string | null;
  playMaxBrLevel?: string | null;
  plLevel?: string | null;
  dlLevel?: string | null;
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
  privilege?: RawNeteasePrivilege | null;
  hr?: unknown;
  hrMusic?: unknown;
  sq?: unknown;
  sqMusic?: unknown;
  h?: unknown;
  hMusic?: unknown;
  m?: unknown;
  mMusic?: unknown;
  l?: unknown;
  lMusic?: unknown;
  pc?: unknown;
}

export const formatNeteaseTime = formatTimestampText;

const EXHIGH_PRIVILEGE_LEVELS = new Set([
  "exhigh",
  "lossless",
  "hires",
  "jyeffect",
  "vivid",
  "dolby",
  "sky",
  "jymaster",
]);
const LOSSLESS_PRIVILEGE_LEVELS = new Set(["lossless", "hires", "jymaster"]);
const HIRES_PRIVILEGE_LEVELS = new Set(["hires", "jymaster"]);

function hasQualityDescriptor(value: unknown): boolean {
  if (!value) return false;
  if (typeof value !== "object") return Boolean(value);
  const record = value as { br?: unknown; size?: unknown };
  if (typeof record.size === "number") return record.size > 0;
  if (typeof record.br === "number") return record.br > 0;
  return true;
}

function deriveQualities(
  song: RawNeteaseSong,
  privilege: RawNeteasePrivilege | null,
  isCloud: boolean,
): QualityOption[] {
  const maxBr = Math.max(Number(privilege?.maxbr ?? 0) || 0, Number(privilege?.playMaxbr ?? 0) || 0);
  const privLevels = [
    privilege?.maxBrLevel,
    privilege?.playMaxBrLevel,
    privilege?.plLevel,
    privilege?.dlLevel,
  ]
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase() : ""))
    .filter(Boolean);

  const hasHires =
    hasQualityDescriptor(song.hr) ||
    hasQualityDescriptor(song.hrMusic) ||
    privLevels.some((level) => HIRES_PRIVILEGE_LEVELS.has(level));
  const hasLossless =
    hasHires ||
    hasQualityDescriptor(song.sq) ||
    hasQualityDescriptor(song.sqMusic) ||
    maxBr >= 700_000 ||
    privLevels.some((level) => LOSSLESS_PRIVILEGE_LEVELS.has(level));
  const hasExhigh =
    hasLossless ||
    isCloud ||
    hasQualityDescriptor(song.h) ||
    hasQualityDescriptor(song.hMusic) ||
    maxBr >= 256_000 ||
    privLevels.some((level) => EXHIGH_PRIVILEGE_LEVELS.has(level));
  const hasHigher =
    !hasExhigh &&
    (hasQualityDescriptor(song.m) ||
      hasQualityDescriptor(song.mMusic) ||
      (maxBr >= 160_000 && maxBr < 256_000) ||
      privLevels.includes("higher"));

  const list: QualityOption[] = [{ level: "standard", label: "128K" }];
  if (hasHigher) {
    list.push({ level: "higher", label: "192K" });
  }
  if (hasExhigh) {
    list.push({ level: "exhigh", label: "320K" });
  }
  if (hasLossless) {
    list.push({ level: "lossless", label: "FLAC" });
  }
  if (hasHires) {
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
  const privilege = options?.privilege ?? raw.privilege ?? null;
  const isCloud = Boolean(options?.isCloud || raw.pc);
  const availableQualities = deriveQualities(raw, privilege, isCloud);
  const topQuality = availableQualities[availableQualities.length - 1]?.label ?? "128K";

  const availability = evaluateNeteaseAvailability({
    fee: privilege?.fee ?? raw.fee,
    pl: privilege?.pl,
    dl: privilege?.dl,
    st: privilege?.st ?? raw.st,
    cp: privilege?.cp ?? raw.cp,
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
    timeText: raw.time ? formatTimestampText(raw.time) : (raw.timeStr?.trim() ?? ""),
    time: typeof raw.time === "number" ? raw.time : undefined,
    liked: Boolean(raw.liked),
    likedCount: Math.max(0, Number(raw.likedCount ?? 0) || 0),
    replyCount: Math.max(0, Number(raw.replyCount ?? 0) || 0),
  };
}
