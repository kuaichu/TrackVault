import crypto from "node:crypto";
import { createRequire } from "node:module";
import { mergeLyricTranslations, parseLrc, parseYrc } from "#audio-tags";
import {
  type AlbumDetail,
  type AlbumSummary,
  type ArtistDetail,
  type ArtistSummary,
  type ChartDetail,
  type ChartSummary,
  type CloudTracksPage,
  type EntitySearchType,
  type PlaylistSort,
  type PlaylistSummary,
  type PlaylistTracksPage,
  type ProviderCapabilities,
  type QrCheckResult,
  type QrStartResult,
  type QualityLevel,
  type Song,
  type SongCommentsPage,
  type SongLyrics,
  normalizeCoverUrl,
  normalizeQualityLevel,
} from "#shared";
import { AppError } from "../../../domain/errors.js";
import {
  buildDownwardQualityOrder,
  isQualityDowngraded,
  isTrialDuration,
} from "../../../domain/policies/quality-policy.js";
import type {
  AudioResolveTarget,
  CreatePlaylistResult,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import {
  type RawNeteaseComment,
  type RawNeteasePlaylist,
  type RawNeteasePrivilege,
  type RawNeteaseSong,
  mapNeteaseComment,
  mapNeteasePlaylist,
  mapNeteaseSong,
} from "./netease-mapper.js";

type NeteaseCall = (params: Record<string, unknown>) => Promise<{ body: Record<string, unknown> }>;

interface NeteaseApiModule {
  login_status: NeteaseCall;
  vip_info: NeteaseCall;
  vip_info_v2: NeteaseCall;
  login_qr_key: NeteaseCall;
  login_qr_create: NeteaseCall;
  login_qr_check: NeteaseCall;
  cloudsearch: NeteaseCall;
  song_detail: NeteaseCall;
  personalized_newsong: NeteaseCall;
  personalized: NeteaseCall;
  personal_fm: NeteaseCall;
  toplist: NeteaseCall;
  artists: NeteaseCall;
  artist_album: NeteaseCall;
  artist_detail: NeteaseCall;
  album: NeteaseCall;
  recommend_songs: NeteaseCall;
  user_cloud: NeteaseCall;
  user_playlist: NeteaseCall;
  playlist_detail: NeteaseCall;
  playlist_track_all: NeteaseCall;
  playlist_tracks: NeteaseCall;
  playlist_create: NeteaseCall;
  lyric_new: NeteaseCall;
  lyric: NeteaseCall;
  comment_music: NeteaseCall;
  comment_like: NeteaseCall;
  likelist: NeteaseCall;
  like: NeteaseCall;
  song_url_v1: NeteaseCall;
  song_download_url_v1: NeteaseCall;
}

const require = createRequire(import.meta.url);
const neteaseApi = require("NeteaseCloudMusicApi") as NeteaseApiModule;

const MAX_PLAYLIST_TRACKS_FETCH = 2000;
const MAX_PLAYLIST_SEARCH_TRACKS = 10_000;
const SONG_DETAIL_BATCH_SIZE = 500;
const SONG_DETAIL_CONCURRENCY = 4;
const MAX_CLOUD_PAGES = 20;
const QR_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_QR_SESSIONS = 100;

interface CachedNeteasePlaylistDetail {
  summary: PlaylistSummary;
  trackIds: string[];
  songMap: Map<string, Song>;
}

const SET_COOKIE_ATTRS = new Set([
  "max-age",
  "expires",
  "path",
  "domain",
  "httponly",
  "secure",
  "samesite",
  "priority",
]);

/**
 * Strips leading "Cookie:" header prefixes, line breaks, and Set-Cookie metadata attributes
 * (Max-Age, Expires, Path, HttpOnly, etc.) and ensures a consistent mobile client identity so
 * NeteaseCloudMusicApi v4.34+ eapi requests do not mismatch os=pc with iPhone UA (-460).
 */
export function normalizeNeteaseCookie(rawCookie: string, options?: { ensureClientOs?: boolean }): string {
  const cleanedRaw = rawCookie
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^cookie\s*:\s*/i, ""))
    .filter(Boolean)
    .join("; ");

  const entries = new Map<string, string>();
  for (const part of cleanedRaw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || !value || SET_COOKIE_ATTRS.has(key.toLowerCase())) continue;
    entries.set(key, value);
  }

  if (options?.ensureClientOs !== false && entries.size > 0) {
    const currentOs = entries.get("os")?.toLowerCase();
    if (!currentOs || currentOs === "pc") {
      entries.set("os", "android");
    }
  }

  return [...entries.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractApiError(error: unknown, fallback: string): string {
  if (error instanceof AppError) return error.message;
  if (error && typeof error === "object") {
    const rec = error as { message?: unknown; body?: { message?: unknown; msg?: unknown; code?: unknown } };
    const msg =
      (typeof rec.body?.message === "string" && rec.body.message.trim()) ||
      (typeof rec.body?.msg === "string" && rec.body.msg.trim()) ||
      (typeof rec.message === "string" && rec.message.trim());
    if (msg) return msg;
    if (typeof rec.body?.code === "number") return `${fallback} (code ${rec.body.code})`;
  }
  return fallback;
}

function sortAndFilterSongs(songs: Song[], keyword?: string, sort?: PlaylistSort): Song[] {
  const needle = keyword?.trim().toLowerCase() ?? "";
  let list = needle
    ? songs.filter(
        (s) =>
          s.title.toLowerCase().includes(needle) ||
          s.artist.toLowerCase().includes(needle) ||
          s.album.toLowerCase().includes(needle),
      )
    : [...songs];

  switch (sort) {
    case "title-asc":
      list = list.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      break;
    case "title-desc":
      list = list.sort((a, b) => b.title.localeCompare(a.title, "zh-CN"));
      break;
    case "artist-asc":
      list = list.sort((a, b) => a.artist.localeCompare(b.artist, "zh-CN"));
      break;
    case "duration-desc":
      list = list.sort((a, b) => b.durationSeconds - a.durationSeconds);
      break;
    case "duration-asc":
      list = list.sort((a, b) => a.durationSeconds - b.durationSeconds);
      break;
    default:
      break;
  }
  return list;
}

function extractVipExpireAt(body: Record<string, unknown>): number | null {
  const data = (body.data ?? body) as Record<string, unknown>;
  const candidates = [
    (data.associator as { expireTime?: number } | undefined)?.expireTime,
    (data.redplus as { expireTime?: number } | undefined)?.expireTime,
    (data.musicPackage as { expireTime?: number } | undefined)?.expireTime,
  ];
  const valid = candidates.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

function formatPublishDate(ms: number | undefined): string | undefined {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export class NeteaseAdapter implements MusicProviderAdapter {
  readonly platform = "netease" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "netease",
    canLikeSong: true,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: true,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    shareUrlTemplate: "https://music.163.com/#/song?id={id}",
  };

  readonly #realIp?: string;
  readonly #timeoutMs?: number;
  readonly #api: NeteaseApiModule;
  readonly #qrSessions = new Map<string, { scopeKey: string; createdAt: number }>();
  readonly #discoverCache = new ScopedLruCache<Song[]>({ maxEntries: 50, defaultTtlMs: 5 * 60 * 1000 });
  readonly #recommendedPlaylistsCache = new ScopedLruCache<PlaylistSummary[]>({
    maxEntries: 20,
    defaultTtlMs: 5 * 60 * 1000,
  });
  readonly #chartsCache = new ScopedLruCache<ChartSummary[]>({
    maxEntries: 10,
    defaultTtlMs: 15 * 60 * 1000,
  });
  readonly #artistCache = new ScopedLruCache<ArtistDetail>({
    maxEntries: 80,
    defaultTtlMs: 10 * 60 * 1000,
  });
  readonly #albumCache = new ScopedLruCache<AlbumDetail>({
    maxEntries: 80,
    defaultTtlMs: 10 * 60 * 1000,
  });
  readonly #playlistDetailCache = new ScopedLruCache<CachedNeteasePlaylistDetail>({
    maxEntries: 40,
    defaultTtlMs: 3 * 60 * 1000,
  });
  readonly #lyricCache = new ScopedLruCache<SongLyrics>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });
  readonly #likeSetCache = new ScopedLruCache<{ set: Set<string>; readStartEpoch: number }>({
    maxEntries: 50,
    defaultTtlMs: 2 * 60 * 1000,
  });
  readonly #recentLikeMutations = new ScopedLruCache<Map<string, { liked: boolean; epoch: number }>>({
    maxEntries: 50,
    defaultTtlMs: 5 * 60 * 1000,
  });
  #likeMutationEpoch = 0;
  #likeReadSeq = 0;
  readonly #inFlightLikeReads = new Map<number, { scopeKey: string; startEpoch: number }>();
  readonly #uidCache = new ScopedLruCache<string>({ maxEntries: 50, defaultTtlMs: 10 * 60 * 1000 });

  constructor(options?: { realIp?: string; timeoutMs?: number; apiOverride?: Partial<NeteaseApiModule> }) {
    this.#realIp = options?.realIp;
    this.#timeoutMs = options?.timeoutMs;
    this.#api = options?.apiOverride ? { ...neteaseApi, ...options.apiOverride } : neteaseApi;
  }

  #cleanupQrSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.#qrSessions.entries()) {
      if (now - session.createdAt > QR_SESSION_TTL_MS) {
        this.#qrSessions.delete(key);
      }
    }
    while (this.#qrSessions.size >= MAX_QR_SESSIONS) {
      const oldest = this.#qrSessions.keys().next().value;
      if (!oldest) break;
      this.#qrSessions.delete(oldest);
    }
  }

  #call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return fn();
    if (signal.aborted) {
      return Promise.reject(new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      fn().then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  #assertBusinessSuccess(body: Record<string, unknown>, fallback: string): void {
    const outerCode = body.code !== undefined && body.code !== null ? Number(body.code) : 200;
    const nested = body.body as { code?: unknown; message?: unknown; msg?: unknown } | undefined;
    const innerCode = nested?.code !== undefined && nested.code !== null ? Number(nested.code) : 200;

    const failedCode = outerCode !== 200 ? outerCode : innerCode !== 200 ? innerCode : 200;
    if (failedCode === 200) return;

    const msg =
      (typeof nested?.message === "string" && nested.message.trim()) ||
      (typeof nested?.msg === "string" && nested.msg.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      (typeof body.msg === "string" && body.msg.trim()) ||
      `${fallback} (code ${failedCode})`;

    if (failedCode === 301 || failedCode === 401) {
      throw new AppError("CREDENTIAL_INVALID", msg);
    }
    throw new AppError("UPSTREAM_ERROR", msg);
  }

  invalidateScope(scopeKey: string): void {
    this.#discoverCache.invalidateScope(scopeKey);
    this.#recommendedPlaylistsCache.invalidateScope(scopeKey);
    this.#artistCache.invalidateScope(scopeKey);
    this.#albumCache.invalidateScope(scopeKey);
    this.#playlistDetailCache.invalidateScope(scopeKey);
    this.#likeSetCache.invalidateScope(scopeKey);
    this.#recentLikeMutations.invalidateScope(scopeKey);
    this.#uidCache.invalidateScope(scopeKey);
  }

  #getMinInFlightLikeEpoch(scopeKey: string): number {
    let min = Number.POSITIVE_INFINITY;
    for (const entry of this.#inFlightLikeReads.values()) {
      if (entry.scopeKey === scopeKey && entry.startEpoch < min) {
        min = entry.startEpoch;
      }
    }
    return min;
  }

  #cookieCacheKey(cookie: string): string {
    const normalized = normalizeNeteaseCookie(cookie);
    const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return `uid:${digest}`;
  }

  #baseParams(auth?: ProviderAuthContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const normalizedCookie = auth?.cookie ? normalizeNeteaseCookie(auth.cookie) : "";
    return {
      ...extra,
      ...(normalizedCookie ? { cookie: normalizedCookie } : {}),
      ...(this.#realIp ? { realIP: this.#realIp } : {}),
      ...(this.#timeoutMs && this.#timeoutMs > 0 ? { timeout: this.#timeoutMs } : {}),
    };
  }

  #assertAuthed(auth: ProviderAuthContext): string {
    if (!auth.cookie?.trim()) {
      throw new AppError("CREDENTIAL_REQUIRED", "该操作需要先绑定网易云音乐账号。");
    }
    return auth.cookie.trim();
  }

  async #resolveUid(auth: ProviderAuthContext): Promise<string> {
    if (auth.accountUid?.trim()) {
      return auth.accountUid.trim();
    }
    const cookie = this.#assertAuthed(auth);
    const uidKey = this.#cookieCacheKey(cookie);
    const cached = this.#uidCache.get(auth.scopeKey, uidKey);
    if (cached) return cached;

    const verified = await this.verifyCredential(cookie);
    if (!verified.ok || !verified.accountUid) {
      throw new AppError("CREDENTIAL_INVALID", "网易云登录态已失效，请重新绑定。");
    }
    this.#uidCache.set(auth.scopeKey, uidKey, verified.accountUid);
    return verified.accountUid;
  }

  async verifyCredential(cookie: string): Promise<CredentialVerificationResult> {
    const trimmed = normalizeNeteaseCookie(cookie.trim());
    if (!trimmed) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "请提供网易云登录态 Cookie。",
      };
    }

    try {
      const response = await this.#api.login_status(this.#baseParams(undefined, { cookie: trimmed }));
      const body = response.body as {
        data?: {
          account?: { id?: number; vipType?: number } | null;
          profile?: { userId?: number; nickname?: string; avatarUrl?: string; vipType?: number } | null;
        };
      };
      const uid = body.data?.account?.id ?? body.data?.profile?.userId;
      const nickname = body.data?.profile?.nickname?.trim();
      if (!uid && !nickname) {
        return {
          ok: false,
          accountUid: null,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: "网易云 Cookie 无效或已过期。",
        };
      }

      const vipType = body.data?.profile?.vipType ?? body.data?.account?.vipType ?? 0;
      const vipEnabled = typeof vipType === "number" && vipType > 0;
      let vipExpireAt: number | null = null;

      if (uid) {
        const vipRes = await this.#api
          .vip_info_v2(this.#baseParams(undefined, { uid, cookie: trimmed }))
          .catch(() => this.#api.vip_info(this.#baseParams(undefined, { uid, cookie: trimmed })))
          .catch(() => null);
        if (vipRes?.body) {
          vipExpireAt = extractVipExpireAt(vipRes.body);
        }
      }

      const accountUid = uid ? String(uid) : null;
      const displayName = nickname || (accountUid ? `UID ${accountUid}` : "网易云用户");
      return {
        ok: true,
        accountUid,
        displayName,
        avatarUrl: normalizeCoverUrl(body.data?.profile?.avatarUrl, 200) ?? null,
        vipEnabled,
        vipExpireAt,
        normalizedCookie: trimmed,
        message: `网易云账号验证成功：${displayName}`,
      };
    } catch (error) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: extractApiError(error, "网易云 Cookie 验证失败"),
      };
    }
  }

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 30): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const safeLimit = Math.min(50, Math.max(1, limit));

    try {
      const response = await this.#call(
        () =>
          this.#api.cloudsearch(
            this.#baseParams(auth, { keywords: keyword, type: 1, limit: safeLimit, offset: 0 }),
          ),
        auth.signal,
      );
      const result = response.body.result as { songs?: RawNeteaseSong[] } | undefined;
      const rawSongs = result?.songs ?? [];
      if (rawSongs.length === 0) return [];

      // Fetch accurate privilege signals for the returned IDs
      const ids = rawSongs
        .map((s) => (s.id !== undefined ? String(s.id) : ""))
        .filter(Boolean)
        .slice(0, safeLimit);

      const privilegeMap = new Map<string, RawNeteasePrivilege>();
      if (ids.length > 0) {
        const detail = await this.#call(
          () => this.#api.song_detail(this.#baseParams(auth, { ids: ids.join(",") })),
          auth.signal,
        ).catch(() => null);
        const privileges = (detail?.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
        for (const priv of privileges) {
          if (priv.id !== undefined) privilegeMap.set(String(priv.id), priv);
        }
      }

      return rawSongs
        .map((song) => {
          const priv = song.id !== undefined ? privilegeMap.get(String(song.id)) : undefined;
          return mapNeteaseSong(song, { privilege: priv });
        })
        .filter((song): song is Song => song !== null);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "网易云搜索失败"), { cause: error });
    }
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const cached = this.#discoverCache.get(auth.scopeKey, "discover");
    if (cached) return cached;

    try {
      const response = await this.#call(
        () => this.#api.personalized_newsong(this.#baseParams(auth, { limit: 30 })),
        auth.signal,
      );
      const items = (response.body.result as Array<{ id?: number; song?: RawNeteaseSong }> | undefined) ?? [];
      const ids = items.map((item) => String(item.song?.id ?? item.id ?? "")).filter(Boolean);
      if (ids.length === 0) return [];

      const detail = await this.#call(
        () => this.#api.song_detail(this.#baseParams(auth, { ids: ids.join(",") })),
        auth.signal,
      );
      const rawSongs = (detail.body.songs as RawNeteaseSong[] | undefined) ?? [];
      const privileges = (detail.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
      const privMap = new Map(privileges.filter((p) => p.id !== undefined).map((p) => [String(p.id), p]));

      const songs = rawSongs
        .map((song) =>
          mapNeteaseSong(song, {
            privilege: song.id !== undefined ? privMap.get(String(song.id)) : undefined,
          }),
        )
        .filter((song): song is Song => song !== null);

      this.#discoverCache.set(auth.scopeKey, "discover", songs);
      return songs;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云发现音乐失败"), {
        cause: error,
      });
    }
  }

  async getDailyRecommendTracks(auth: ProviderAuthContext): Promise<Song[]> {
    this.#assertAuthed(auth);
    try {
      const response = await this.#call(() => this.#api.recommend_songs(this.#baseParams(auth)), auth.signal);
      this.#assertBusinessSuccess(response.body, "获取每日推荐失败");
      const data = response.body.data as
        | { dailySongs?: RawNeteaseSong[]; privileges?: RawNeteasePrivilege[] }
        | undefined;
      const privileges =
        data?.privileges ?? (response.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
      const privMap = new Map(privileges.filter((p) => p.id !== undefined).map((p) => [String(p.id), p]));

      return (data?.dailySongs ?? [])
        .map((song) =>
          mapNeteaseSong(song, {
            privilege:
              song.id !== undefined ? (privMap.get(String(song.id)) ?? song.privilege) : song.privilege,
          }),
        )
        .filter((song): song is Song => song !== null);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取每日推荐失败"), { cause: error });
    }
  }

  async getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    const safeLimit = Math.min(30, Math.max(1, limit));
    const cacheKey = `rec:${safeLimit}`;
    const cached = this.#recommendedPlaylistsCache.get(auth.scopeKey, cacheKey);
    if (cached) return cached;

    try {
      const response = await this.#call(
        () => this.#api.personalized(this.#baseParams(auth, { limit: safeLimit })),
        auth.signal,
      );
      const raw =
        (response.body.result as
          | Array<{
              id?: number | string;
              name?: string;
              picUrl?: string;
              trackCount?: number;
              copywriter?: string;
            }>
          | undefined) ?? [];

      const playlists: PlaylistSummary[] = raw
        .filter((item) => item.id !== undefined && Boolean(item.name?.trim()))
        .map((item) => ({
          id: String(item.id),
          platform: "netease",
          name: item.name?.trim() ?? "",
          coverUrl: normalizeCoverUrl(item.picUrl, 400),
          trackCount: Math.max(0, Number(item.trackCount ?? 0) || 0),
          creatorName: item.copywriter?.trim() || "网易云编辑推荐",
          owned: false,
        }));

      this.#recommendedPlaylistsCache.set(auth.scopeKey, cacheKey, playlists);
      return playlists;
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取推荐歌单失败"), { cause: error });
    }
  }

  async getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    const cached = this.#chartsCache.get("public", "charts");
    if (cached) return cached;

    try {
      const response = await this.#call(() => this.#api.toplist(this.#baseParams(auth)), auth.signal);
      const raw =
        (response.body.list as
          | Array<{
              id?: number | string;
              name?: string;
              coverImgUrl?: string;
              updateFrequency?: string;
              trackCount?: number;
            }>
          | undefined) ?? [];

      const charts: ChartSummary[] = raw
        .filter((item) => item.id !== undefined && Boolean(item.name?.trim()))
        .slice(0, 36)
        .map((item) => ({
          id: String(item.id),
          platform: "netease",
          name: item.name?.trim() ?? "",
          coverUrl: normalizeCoverUrl(item.coverImgUrl, 400),
          updateFrequency: item.updateFrequency?.trim() || undefined,
          trackCount: Math.max(0, Number(item.trackCount ?? 0) || 0),
        }));

      this.#chartsCache.set("public", "charts", charts);
      return charts;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云排行榜失败"), { cause: error });
    }
  }

  async getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    const page = await this.getPlaylistTracks(chartId, { page: 1, limit: 100, sort: "default" }, auth);
    return {
      chart: {
        id: page.playlist.id,
        platform: "netease",
        name: page.playlist.name,
        coverUrl: page.playlist.coverUrl,
        trackCount: page.total,
      },
      songs: page.songs,
    };
  }

  async getPersonalFm(auth: ProviderAuthContext): Promise<Song[]> {
    this.#assertAuthed(auth);
    try {
      const response = await this.#call(
        () => this.#api.personal_fm(this.#baseParams(auth, { timestamp: Date.now() })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "获取私人 FM 失败");
      const raw = (response.body.data as RawNeteaseSong[] | undefined) ?? [];
      return raw.map((song) => mapNeteaseSong(song)).filter((song): song is Song => song !== null);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取私人 FM 失败"), { cause: error });
    }
  }

  async getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    const cleanId = artistId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少歌手 ID。");
    }

    const cached = this.#artistCache.get(auth.scopeKey, cleanId);
    if (cached) return cached;

    try {
      const [artistRes, albumsRes, detailRes] = await Promise.allSettled([
        this.#call(() => this.#api.artists(this.#baseParams(auth, { id: cleanId })), auth.signal),
        this.#call(
          () => this.#api.artist_album(this.#baseParams(auth, { id: cleanId, limit: 30, offset: 0 })),
          auth.signal,
        ),
        this.#call(() => this.#api.artist_detail(this.#baseParams(auth, { id: cleanId })), auth.signal),
      ]);

      if (artistRes.status === "rejected") {
        throw artistRes.reason;
      }

      const body = artistRes.value.body as {
        artist?: {
          id?: number | string;
          name?: string;
          alias?: string[];
          picUrl?: string;
          img1v1Url?: string;
          briefDesc?: string;
          musicSize?: number;
          albumSize?: number;
        };
        hotSongs?: RawNeteaseSong[];
      };

      const rawArtist = body.artist;
      if (!rawArtist?.name) {
        throw new AppError("NOT_FOUND", "未找到该歌手信息。");
      }

      const detailArtist =
        detailRes.status === "fulfilled"
          ? ((
              detailRes.value.body.data as {
                artist?: { cover?: string; avatar?: string; briefDesc?: string };
              }
            )?.artist ?? undefined)
          : undefined;

      const hotSongs = (body.hotSongs ?? [])
        .map((song) => mapNeteaseSong(song))
        .filter((song): song is Song => song !== null);

      const rawAlbums =
        albumsRes.status === "fulfilled"
          ? ((albumsRes.value.body.hotAlbums as
              | Array<{
                  id?: number | string;
                  name?: string;
                  picUrl?: string;
                  publishTime?: number;
                  size?: number;
                  type?: string;
                }>
              | undefined) ?? [])
          : [];

      const albums: AlbumSummary[] = rawAlbums
        .filter((a) => a.id !== undefined && Boolean(a.name?.trim()))
        .map((a) => ({
          id: String(a.id),
          platform: "netease",
          name: a.name?.trim() ?? "",
          coverUrl: normalizeCoverUrl(a.picUrl, 400),
          artistName: rawArtist.name?.trim() ?? "",
          artistId: cleanId,
          publishDate: formatPublishDate(a.publishTime),
          trackCount: Math.max(0, Number(a.size ?? 0) || 0),
          albumType: a.type?.trim() || undefined,
        }));

      const result: ArtistDetail = {
        id: cleanId,
        platform: "netease",
        name: rawArtist.name.trim(),
        alias: rawArtist.alias?.filter(Boolean),
        avatarUrl: normalizeCoverUrl(
          detailArtist?.avatar || detailArtist?.cover || rawArtist.picUrl || rawArtist.img1v1Url,
          500,
        ),
        briefDesc: (detailArtist?.briefDesc || rawArtist.briefDesc)?.trim() || undefined,
        songCount: typeof rawArtist.musicSize === "number" ? rawArtist.musicSize : hotSongs.length,
        albumCount: typeof rawArtist.albumSize === "number" ? rawArtist.albumSize : albums.length,
        hotSongs,
        albums,
      };

      this.#artistCache.set(auth.scopeKey, cleanId, result);
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌手详情失败"), {
        cause: error,
      });
    }
  }

  async getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    const cleanId = albumId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少专辑 ID。");
    }

    const cached = this.#albumCache.get(auth.scopeKey, cleanId);
    if (cached) return cached;

    try {
      const response = await this.#call(
        () => this.#api.album(this.#baseParams(auth, { id: cleanId })),
        auth.signal,
      );
      const body = response.body as {
        album?: {
          id?: number | string;
          name?: string;
          picUrl?: string;
          publishTime?: number;
          company?: string;
          description?: string;
          briefDesc?: string;
          size?: number;
          artist?: { id?: number | string; name?: string };
          artists?: Array<{ id?: number | string; name?: string }>;
        };
        songs?: RawNeteaseSong[];
        privileges?: RawNeteasePrivilege[];
      };

      const rawAlbum = body.album;
      if (!rawAlbum?.name) {
        throw new AppError("NOT_FOUND", "未找到该专辑信息。");
      }

      const rawSongs = body.songs ?? [];
      const privMap = new Map<string, RawNeteasePrivilege>();
      for (const priv of body.privileges ?? []) {
        if (priv.id !== undefined) privMap.set(String(priv.id), priv);
      }

      // Enrich missing per-account privileges (C040) when album endpoint omits top-level/embedded privileges
      const missingPrivIds = rawSongs
        .filter((s) => s.id !== undefined && !privMap.has(String(s.id)) && !s.privilege)
        .map((s) => String(s.id));
      if (missingPrivIds.length > 0) {
        const detailRes = await this.#call(
          () =>
            this.#api.song_detail(this.#baseParams(auth, { ids: missingPrivIds.slice(0, 200).join(",") })),
          auth.signal,
        ).catch(() => null);
        const fetchedPrivs = (detailRes?.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
        for (const priv of fetchedPrivs) {
          if (priv.id !== undefined) privMap.set(String(priv.id), priv);
        }
      }

      const songs = rawSongs
        .map((song) =>
          mapNeteaseSong(song, {
            privilege:
              song.id !== undefined ? (privMap.get(String(song.id)) ?? song.privilege) : song.privilege,
          }),
        )
        .filter((song): song is Song => song !== null);

      const rawArtists = rawAlbum.artists?.length
        ? rawAlbum.artists
        : rawAlbum.artist
          ? [rawAlbum.artist]
          : [];
      const artists = rawArtists
        .map((a) => ({
          id: a.id !== undefined && String(a.id) !== "0" ? String(a.id) : undefined,
          name: a.name?.trim() ?? "",
        }))
        .filter((a) => Boolean(a.name));

      const result: AlbumDetail = {
        id: cleanId,
        platform: "netease",
        name: rawAlbum.name.trim(),
        coverUrl: normalizeCoverUrl(rawAlbum.picUrl, 500),
        artists: artists.length > 0 ? artists : [{ name: "未知歌手" }],
        publishDate: formatPublishDate(rawAlbum.publishTime),
        company: rawAlbum.company?.trim() || undefined,
        description: (rawAlbum.description || rawAlbum.briefDesc)?.trim() || undefined,
        trackCount: Math.max(songs.length, Number(rawAlbum.size ?? 0) || 0),
        songs,
      };

      this.#albumCache.set(auth.scopeKey, cleanId, result);
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云专辑详情失败"), {
        cause: error,
      });
    }
  }

  async searchEntities(
    query: string,
    type: EntitySearchType,
    auth: ProviderAuthContext,
    limit = 20,
  ): Promise<{ artists?: ArtistSummary[]; albums?: AlbumSummary[]; playlists?: PlaylistSummary[] }> {
    const keyword = query.trim();
    if (!keyword) return {};
    const safeLimit = Math.min(40, Math.max(1, limit));
    const typeCode = type === "artist" ? 100 : type === "album" ? 10 : 1000;

    try {
      const response = await this.#call(
        () =>
          this.#api.cloudsearch(
            this.#baseParams(auth, { keywords: keyword, type: typeCode, limit: safeLimit, offset: 0 }),
          ),
        auth.signal,
      );
      const result = response.body.result as Record<string, unknown> | undefined;

      if (type === "artist") {
        const raw =
          (result?.artists as
            | Array<{
                id?: number | string;
                name?: string;
                picUrl?: string;
                img1v1Url?: string;
                musicSize?: number;
                albumSize?: number;
              }>
            | undefined) ?? [];
        return {
          artists: raw
            .filter((a) => a.id !== undefined && Boolean(a.name?.trim()))
            .map((a) => ({
              id: String(a.id),
              platform: "netease",
              name: a.name?.trim() ?? "",
              avatarUrl: normalizeCoverUrl(a.picUrl || a.img1v1Url, 300),
              songCount: typeof a.musicSize === "number" ? a.musicSize : undefined,
              albumCount: typeof a.albumSize === "number" ? a.albumSize : undefined,
            })),
        };
      }

      if (type === "album") {
        const raw =
          (result?.albums as
            | Array<{
                id?: number | string;
                name?: string;
                picUrl?: string;
                publishTime?: number;
                size?: number;
                artist?: { id?: number | string; name?: string };
              }>
            | undefined) ?? [];
        return {
          albums: raw
            .filter((a) => a.id !== undefined && Boolean(a.name?.trim()))
            .map((a) => ({
              id: String(a.id),
              platform: "netease",
              name: a.name?.trim() ?? "",
              coverUrl: normalizeCoverUrl(a.picUrl, 400),
              artistName: a.artist?.name?.trim() || "未知歌手",
              artistId: a.artist?.id !== undefined ? String(a.artist.id) : undefined,
              publishDate: formatPublishDate(a.publishTime),
              trackCount: Math.max(0, Number(a.size ?? 0) || 0),
            })),
        };
      }

      const raw = (result?.playlists as RawNeteasePlaylist[] | undefined) ?? [];
      return {
        playlists: raw
          .map((item) => mapNeteasePlaylist(item))
          .filter((item): item is PlaylistSummary => item !== null),
      };
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "网易云检索失败"), { cause: error });
    }
  }

  async getCloudTracksPage(
    auth: ProviderAuthContext,
    options?: { offset?: number; limit?: number },
  ): Promise<CloudTracksPage> {
    this.#assertAuthed(auth);
    const safeOffset = Math.max(0, Math.floor(options?.offset ?? 0) || 0);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 100) || 100));

    try {
      const response = await this.#call(
        () => this.#api.user_cloud(this.#baseParams(auth, { limit: safeLimit, offset: safeOffset })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "获取网易云云盘歌曲失败");

      const rows =
        (response.body.data as
          | Array<{
              simpleSong?: RawNeteaseSong;
              songId?: number;
              songName?: string;
              artist?: string;
              album?: string;
            }>
          | undefined) ?? [];

      const songs: Song[] = [];
      for (const row of rows) {
        const base: RawNeteaseSong = row.simpleSong ?? {
          id: row.songId,
          name: row.songName,
          ar: row.artist ? [{ name: row.artist }] : [],
          al: { name: row.album },
        };
        const mapped = mapNeteaseSong(base, { isCloud: true });
        if (mapped) songs.push(mapped);
      }

      // A10 + B03: Drive pagination using upstream `count` rather than unreliable/missing `hasMore`.
      const rawCount =
        response.body.count !== undefined && response.body.count !== null
          ? Number(response.body.count)
          : Number.NaN;
      const hasValidCount = Number.isFinite(rawCount) && rawCount >= 0;
      const total = hasValidCount ? Math.max(rawCount, safeOffset + songs.length) : safeOffset + songs.length;
      const hasMore =
        rows.length === 0
          ? false
          : hasValidCount
            ? safeOffset + rows.length < rawCount
            : Boolean(response.body.hasMore) || rows.length >= safeLimit;

      const nextOffset = safeOffset + (rows.length > 0 ? rows.length : songs.length);

      return {
        songs,
        total,
        offset: safeOffset,
        nextOffset,
        limit: safeLimit,
        hasMore,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云云盘歌曲失败"), {
        cause: error,
      });
    }
  }

  async getCloudTracks(auth: ProviderAuthContext): Promise<Song[]> {
    this.#assertAuthed(auth);
    const allSongs: Song[] = [];
    const pageSize = 100;
    let offset = 0;

    for (let page = 0; page < MAX_CLOUD_PAGES; page += 1) {
      const result = await this.getCloudTracksPage(auth, { offset, limit: pageSize });
      allSongs.push(...result.songs);
      const next = result.nextOffset ?? offset + pageSize;
      if (!result.hasMore || next <= offset) break;
      offset = next;
    }
    return allSongs;
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const uid = await this.#resolveUid(auth);
    try {
      const response = await this.#call(
        () => this.#api.user_playlist(this.#baseParams(auth, { uid, limit: 200, offset: 0 })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "获取网易云歌单列表失败");
      const raw = (response.body.playlist as RawNeteasePlaylist[] | undefined) ?? [];
      return raw
        .map((item) => mapNeteasePlaylist(item, uid))
        .filter((item): item is PlaylistSummary => item !== null);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌单列表失败"), {
        cause: error,
      });
    }
  }

  async #getPlaylistDetail(
    playlistId: string,
    auth: ProviderAuthContext,
  ): Promise<CachedNeteasePlaylistDetail> {
    const cacheKey = `detail:${playlistId}`;
    const cached = this.#playlistDetailCache.get(auth.scopeKey, cacheKey);
    if (cached) return cached;

    try {
      const response = await this.#call(
        () => this.#api.playlist_detail(this.#baseParams(auth, { id: playlistId })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "获取网易云歌单详情失败");
      const rawPlaylist = response.body.playlist as
        | (RawNeteasePlaylist & {
            tracks?: RawNeteaseSong[];
            trackIds?: Array<{ id?: number | string }>;
          })
        | undefined;

      if (!rawPlaylist) {
        throw new AppError("NOT_FOUND", "未找到该网易云歌单或无访问权限。");
      }

      const currentUid =
        auth.accountUid?.trim() ||
        (auth.cookie ? this.#uidCache.get(auth.scopeKey, this.#cookieCacheKey(auth.cookie)) : undefined) ||
        undefined;
      const summary = mapNeteasePlaylist(rawPlaylist, currentUid) ?? {
        id: playlistId,
        platform: "netease" as const,
        name: `歌单 ${playlistId}`,
        trackCount: 0,
        creatorName: "网易云用户",
        owned: false,
      };

      const privileges = (response.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
      const privMap = new Map(privileges.filter((p) => p.id !== undefined).map((p) => [String(p.id), p]));

      const songMap = new Map<string, Song>();
      for (const rawSong of rawPlaylist.tracks ?? []) {
        const mapped = mapNeteaseSong(rawSong, {
          privilege: rawSong.id !== undefined ? privMap.get(String(rawSong.id)) : undefined,
        });
        if (mapped) songMap.set(mapped.id, mapped);
      }

      const rawTrackIds = (rawPlaylist.trackIds ?? [])
        .map((item) => (item.id !== undefined && item.id !== null ? String(item.id) : ""))
        .filter(Boolean);
      const trackIds = rawTrackIds.length > 0 ? rawTrackIds : [...songMap.keys()];

      const detail: CachedNeteasePlaylistDetail = {
        summary: { ...summary, trackCount: Math.max(summary.trackCount, trackIds.length) },
        trackIds,
        songMap,
      };
      this.#playlistDetailCache.set(auth.scopeKey, cacheKey, detail);
      return detail;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌单详情失败"), {
        cause: error,
      });
    }
  }

  async #hydrateTrackIds(
    trackIds: string[],
    songMap: Map<string, Song>,
    auth: ProviderAuthContext,
  ): Promise<void> {
    const missing = trackIds.filter((id) => !songMap.has(id));
    if (missing.length === 0) return;

    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += SONG_DETAIL_BATCH_SIZE) {
      batches.push(missing.slice(i, i + SONG_DETAIL_BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i += SONG_DETAIL_CONCURRENCY) {
      const slice = batches.slice(i, i + SONG_DETAIL_CONCURRENCY);
      const responses = await Promise.all(
        slice.map((ids) =>
          this.#call(
            () => this.#api.song_detail(this.#baseParams(auth, { ids: ids.join(",") })),
            auth.signal,
          ),
        ),
      );
      for (const response of responses) {
        const rawSongs = (response.body.songs as RawNeteaseSong[] | undefined) ?? [];
        const privileges = (response.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
        const privMap = new Map(privileges.filter((p) => p.id !== undefined).map((p) => [String(p.id), p]));
        for (const rawSong of rawSongs) {
          const mapped = mapNeteaseSong(rawSong, {
            privilege: rawSong.id !== undefined ? privMap.get(String(rawSong.id)) : undefined,
          });
          if (mapped) songMap.set(mapped.id, mapped);
        }
      }
    }
  }

  async getAllPlaylistTracks(
    playlistId: string,
    auth: ProviderAuthContext,
    maxTracks = MAX_PLAYLIST_TRACKS_FETCH,
  ): Promise<Song[]> {
    // T11: Default calls remain capped at 2,000, while explicit deep-scan callers (e.g. selectedSourceTrackIds) may scan up to 10,000
    const cappedMax = Math.min(MAX_PLAYLIST_SEARCH_TRACKS, Math.max(1, Math.floor(maxTracks)));
    const detail = await this.#getPlaylistDetail(playlistId, auth);
    const targetIds = detail.trackIds.slice(0, cappedMax);

    try {
      await this.#hydrateTrackIds(targetIds, detail.songMap, auth);
      return targetIds.map((id) => detail.songMap.get(id)).filter((s): s is Song => Boolean(s));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌单曲目失败"), {
        cause: error,
      });
    }
  }

  async getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    const safePage = Math.max(1, Math.floor(query.page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(query.limit) || 50));
    const detail = await this.#getPlaylistDetail(playlistId, auth);
    const offset = (safePage - 1) * safeLimit;
    const hasFilterOrSort = Boolean(query.keyword?.trim()) || Boolean(query.sort && query.sort !== "default");

    // True on-demand pagination: only hydrate the requested page's track IDs (0 extra calls for tracks 1-1000)
    if (!hasFilterOrSort) {
      const pageIds = detail.trackIds.slice(offset, offset + safeLimit);
      try {
        await this.#hydrateTrackIds(pageIds, detail.songMap, auth);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌单曲目失败"), {
          cause: error,
        });
      }

      const pageSongs = pageIds.map((id) => detail.songMap.get(id)).filter((s): s is Song => Boolean(s));
      const total = detail.trackIds.length;
      return {
        playlist: detail.summary,
        songs: pageSongs,
        total,
        page: safePage,
        limit: safeLimit,
        hasMore: offset + safeLimit < total,
      };
    }

    // A09: For search/sort, concurrently hydrate full playlist (up to 10,000 tracks) into cached detail.songMap
    const targetIds = detail.trackIds.slice(0, MAX_PLAYLIST_SEARCH_TRACKS);
    try {
      await this.#hydrateTrackIds(targetIds, detail.songMap, auth);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云歌单曲目失败"), {
        cause: error,
      });
    }

    const allSongs = targetIds.map((id) => detail.songMap.get(id)).filter((s): s is Song => Boolean(s));
    const filtered = sortAndFilterSongs(allSongs, query.keyword, query.sort);
    const pageSongs = filtered.slice(offset, offset + safeLimit);
    const truncated = detail.trackIds.length > targetIds.length;

    return {
      playlist: detail.summary,
      songs: pageSongs,
      total: filtered.length,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + pageSongs.length < filtered.length,
      truncated,
      scannedTotal: targetIds.length,
    };
  }

  async addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }> {
    this.#assertAuthed(auth);
    const uniqueIds = [...new Set(trackIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return { addedCount: 0 };

    let completedCount = 0;
    try {
      const chunkSize = 50;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const response = await this.#call(
          () =>
            this.#api.playlist_tracks(
              this.#baseParams(auth, { op: "add", pid: playlistId, tracks: chunk.join(",") }),
            ),
          auth.signal,
        );
        this.#assertBusinessSuccess(response.body, "添加歌曲到歌单失败");
        completedCount += chunk.length;
      }

      return { addedCount: completedCount };
    } catch (error) {
      const partialNote =
        completedCount > 0 ? `（已成功添加前 ${completedCount}/${uniqueIds.length} 首）` : "";
      if (error instanceof AppError) {
        if (!partialNote) throw error;
        throw new AppError(error.code, `${error.message}${partialNote}`, {
          cause: error,
          details: { ...(error.details ?? {}), completedCount, totalCount: uniqueIds.length },
        });
      }
      throw new AppError("UPSTREAM_ERROR", `${extractApiError(error, "添加歌曲到歌单失败")}${partialNote}`, {
        cause: error,
        details: { completedCount, totalCount: uniqueIds.length },
      });
    } finally {
      // A02: Invalidate playlist detail cache whenever at least one batch succeeded
      if (completedCount > 0) {
        this.#playlistDetailCache.invalidateScope(auth.scopeKey, `detail:${playlistId}`);
      }
    }
  }

  async removeTracksFromPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }> {
    this.#assertAuthed(auth);
    const uniqueIds = [...new Set(trackIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return { removedCount: 0 };

    let completedCount = 0;
    try {
      const chunkSize = 50;
      for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const response = await this.#call(
          () =>
            this.#api.playlist_tracks(
              this.#baseParams(auth, { op: "del", pid: playlistId, tracks: chunk.join(",") }),
            ),
          auth.signal,
        );
        this.#assertBusinessSuccess(response.body, "从歌单移除歌曲失败");
        completedCount += chunk.length;
      }

      return { removedCount: completedCount };
    } catch (error) {
      const partialNote =
        completedCount > 0 ? `（已成功移除前 ${completedCount}/${uniqueIds.length} 首）` : "";
      if (error instanceof AppError) {
        if (!partialNote) throw error;
        throw new AppError(error.code, `${error.message}${partialNote}`, {
          cause: error,
          details: { ...(error.details ?? {}), completedCount, totalCount: uniqueIds.length },
        });
      }
      throw new AppError("UPSTREAM_ERROR", `${extractApiError(error, "从歌单移除歌曲失败")}${partialNote}`, {
        cause: error,
        details: { completedCount, totalCount: uniqueIds.length },
      });
    } finally {
      // A02: Invalidate playlist detail cache whenever at least one batch succeeded
      if (completedCount > 0) {
        this.#playlistDetailCache.invalidateScope(auth.scopeKey, `detail:${playlistId}`);
      }
    }
  }

  async createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    this.#assertAuthed(auth);
    const playlistName = name.trim();
    if (!playlistName) {
      throw new AppError("VALIDATION_ERROR", "请输入新歌单名称。");
    }

    let createdId = "";
    try {
      const createRes = await this.#call(
        () => this.#api.playlist_create(this.#baseParams(auth, { name: playlistName })),
        auth.signal,
      );
      this.#assertBusinessSuccess(createRes.body, "创建网易云歌单失败");
      createdId = String(
        createRes.body.id ?? (createRes.body.playlist as { id?: number } | undefined)?.id ?? "",
      );
      if (!createdId) {
        throw new AppError("UPSTREAM_ERROR", "创建网易云歌单失败，未返回歌单 ID。");
      }

      const { addedCount } = await this.addTracksToPlaylist(createdId, trackIds, auth);
      return {
        playlistId: createdId,
        playlistName,
        playlistUrl: `https://music.163.com/#/playlist?id=${encodeURIComponent(createdId)}`,
        addedCount,
      };
    } catch (error) {
      if (error instanceof AppError) {
        if (createdId) {
          throw new AppError(
            error.code,
            `歌单「${playlistName}」已创建，但写入曲目未全部完成：${error.message}`,
            {
              cause: error,
              details: { ...(error.details ?? {}), playlistId: createdId },
            },
          );
        }
        throw error;
      }
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "创建网易云歌单失败"), { cause: error });
    } finally {
      if (createdId) {
        this.#playlistDetailCache.invalidateScope(auth.scopeKey, `detail:${createdId}`);
      }
    }
  }

  async getLyrics(
    songId: string,
    _mediaId: string | undefined,
    auth: ProviderAuthContext,
  ): Promise<SongLyrics> {
    const cached = this.#lyricCache.get("public", songId);
    if (cached) return cached;

    const tryEndpoint = async (kind: "netease_new" | "netease_legacy") => {
      const fn = kind === "netease_new" ? this.#api.lyric_new : this.#api.lyric;
      const response = await this.#call(() => fn(this.#baseParams(auth, { id: songId })), auth.signal);
      const body = response.body as {
        lrc?: { lyric?: string };
        tlyric?: { lyric?: string };
        yrc?: { lyric?: string };
      };
      const baseLines = parseLrc(body.lrc?.lyric);
      const yrcLines = baseLines.length === 0 ? parseYrc(body.yrc?.lyric) : [];
      const primary = baseLines.length > 0 ? baseLines : yrcLines;
      const lines = mergeLyricTranslations(primary, parseLrc(body.tlyric?.lyric));
      return {
        songId,
        platform: "netease" as const,
        lines,
        source: lines.length > 0 ? kind : ("none" as const),
      };
    };

    let result: SongLyrics;
    let succeeded = false;
    try {
      result = await tryEndpoint("netease_new");
      succeeded = true;
      if (result.lines.length === 0) {
        const legacy = await tryEndpoint("netease_legacy").catch(() => null);
        if (legacy && legacy.lines.length > 0) {
          result = legacy;
        }
      }
    } catch {
      try {
        result = await tryEndpoint("netease_legacy");
        succeeded = true;
      } catch {
        result = {
          songId,
          platform: "netease" as const,
          lines: [],
          source: "none" as const,
        };
      }
    }

    // Only cache genuine upstream results (avoid poisoning cache with transient network failures)
    if (succeeded) {
      this.#lyricCache.set(
        "public",
        songId,
        result,
        result.lines.length > 0 ? 30 * 60 * 1000 : 5 * 60 * 1000,
      );
    }
    return result;
  }

  async getComments(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage> {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));

    try {
      const response = await this.#call(
        () =>
          this.#api.comment_music(
            this.#baseParams(auth, { id: songId, limit: safeLimit, offset: (safePage - 1) * safeLimit }),
          ),
        auth.signal,
      );
      const hotComments =
        safePage === 1
          ? ((response.body.hotComments as RawNeteaseComment[] | undefined) ?? [])
              .map(mapNeteaseComment)
              .filter((c): c is NonNullable<typeof c> => c !== null)
          : [];
      const comments = ((response.body.comments as RawNeteaseComment[] | undefined) ?? [])
        .map(mapNeteaseComment)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      const total = Math.max(0, Number(response.body.total ?? comments.length) || 0);

      return {
        songId,
        platform: "netease",
        total,
        page: safePage,
        limit: safeLimit,
        hasMore: Boolean(response.body.more),
        hotComments,
        comments,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云评论失败"), { cause: error });
    }
  }

  async setCommentLiked(
    songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    this.#assertAuthed(auth);
    try {
      const response = await this.#call(
        () =>
          this.#api.comment_like(
            this.#baseParams(auth, { id: songId, cid: commentId, t: liked ? 1 : 0, type: 0 }),
          ),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "评论点赞失败");
      return { liked };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "评论点赞操作失败"), { cause: error });
    }
  }

  async #getLikeSet(auth: ProviderAuthContext): Promise<Set<string>> {
    const startEpoch = this.#likeMutationEpoch;
    const readId = ++this.#likeReadSeq;
    this.#inFlightLikeReads.set(readId, { scopeKey: auth.scopeKey, startEpoch });

    try {
      const uid = await this.#resolveUid(auth);
      const cacheKey = `likes:${uid}`;
      const cached = this.#likeSetCache.get(auth.scopeKey, cacheKey);
      if (cached) return new Set(cached.set);

      const response = await this.#call(
        () => this.#api.likelist(this.#baseParams(auth, { uid })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "获取网易云红心列表失败");
      const ids = ((response.body.ids as Array<number | string> | undefined) ?? []).map(String);
      const set = new Set(ids);

      // P06: Reconcile any toggleSongLike mutations that completed after this read began (`entry.epoch > startEpoch`)
      // without prematurely deleting entries still required by an older overlapping in-flight GET.
      const recentMutations = this.#recentLikeMutations.get(auth.scopeKey, "mutations");
      if (recentMutations) {
        for (const [mutSongId, entry] of recentMutations.entries()) {
          if (entry.epoch > startEpoch) {
            if (entry.liked) set.add(mutSongId);
            else set.delete(mutSongId);
          }
        }
      }

      // P06: Monotonic read-generation publish guard — an older GET finishing after a newer GET must never clobber cache
      const currentCached = this.#likeSetCache.get(auth.scopeKey, cacheKey);
      if (currentCached && currentCached.readStartEpoch > startEpoch) {
        return new Set(currentCached.set);
      }

      this.#likeSetCache.set(auth.scopeKey, cacheKey, {
        set: new Set(set),
        readStartEpoch: startEpoch,
      });
      return set;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "获取网易云红心列表失败"), {
        cause: error,
      });
    } finally {
      this.#inFlightLikeReads.delete(readId);
      const recentMutations = this.#recentLikeMutations.get(auth.scopeKey, "mutations");
      if (recentMutations && recentMutations.size > 0) {
        const minActiveEpoch = this.#getMinInFlightLikeEpoch(auth.scopeKey);
        for (const [mutSongId, entry] of recentMutations.entries()) {
          if (entry.epoch <= startEpoch && entry.epoch <= minActiveEpoch) {
            recentMutations.delete(mutSongId);
          }
        }
      }
    }
  }

  async getLikedSongIds(auth: ProviderAuthContext): Promise<string[]> {
    if (!auth.cookie?.trim()) return [];
    const set = await this.#getLikeSet(auth);
    return [...set];
  }

  async isSongLiked(songId: string, auth: ProviderAuthContext): Promise<boolean> {
    if (!auth.cookie?.trim()) return false;
    const set = await this.#getLikeSet(auth);
    return set.has(songId);
  }

  async toggleSongLike(
    songId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    const cookie = this.#assertAuthed(auth);
    try {
      // BUG-01: NeteaseCloudMusicApi/module/like.js checks `query.like == 'false' ? false : true`;
      // passing boolean `false` evaluates `false == 'false'` -> false -> likes the song instead of unliking!
      const response = await this.#call(
        () => this.#api.like(this.#baseParams(auth, { id: songId, like: String(liked) })),
        auth.signal,
      );
      this.#assertBusinessSuccess(response.body, "红心操作失败");

      const mutationEpoch = ++this.#likeMutationEpoch;
      let scopeMutations = this.#recentLikeMutations.get(auth.scopeKey, "mutations");
      if (!scopeMutations) {
        scopeMutations = new Map();
      }
      if (scopeMutations.has(songId)) {
        scopeMutations.delete(songId);
      }
      scopeMutations.set(songId, { liked, epoch: mutationEpoch });
      while (scopeMutations.size > 200) {
        const oldestKey = scopeMutations.keys().next().value;
        if (!oldestKey) break;
        scopeMutations.delete(oldestKey);
      }
      this.#recentLikeMutations.set(auth.scopeKey, "mutations", scopeMutations);

      const uid = auth.accountUid?.trim() || this.#uidCache.get(auth.scopeKey, this.#cookieCacheKey(cookie));
      if (uid) {
        const cacheKey = `likes:${uid}`;
        const existing = this.#likeSetCache.get(auth.scopeKey, cacheKey);
        if (existing) {
          const next = new Set(existing.set);
          if (liked) next.add(songId);
          else next.delete(songId);
          this.#likeSetCache.set(auth.scopeKey, cacheKey, {
            set: next,
            readStartEpoch: Math.max(existing.readStartEpoch, mutationEpoch),
          });
        }
      } else {
        this.#likeSetCache.invalidateScope(auth.scopeKey);
      }
      return { liked };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", extractApiError(error, "红心操作失败"), { cause: error });
    }
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    this.#assertAuthed(auth);
    const order = buildDownwardQualityOrder(level);
    const apiFn = mode === "download" ? this.#api.song_download_url_v1 : this.#api.song_url_v1;
    let lastError: AppError | null = null;
    let firstTrialFallback: ResolvedAudio | null = null;

    for (const candidateLevel of order) {
      const variants: Array<Record<string, unknown>> =
        mode === "playback"
          ? [
              { id: target.id, level: candidateLevel },
              { id: target.id, level: candidateLevel, crypto: "weapi" },
            ]
          : [{ id: target.id, level: candidateLevel }];

      for (const variantParams of variants) {
        try {
          const response = await this.#call(() => apiFn(this.#baseParams(auth, variantParams)), auth.signal);
          const rawData = response.body.data;
          const item = (Array.isArray(rawData) ? rawData[0] : rawData) as
            | {
                url?: string | null;
                type?: string | null;
                br?: number | string | null;
                level?: string | null;
                time?: number | null;
                freeTrialInfo?: { start?: number; end?: number } | null;
              }
            | undefined;

          if (!item?.url) {
            lastError = new AppError("COPYRIGHT_UNAVAILABLE", "网易云未返回该音质的可用音频链接。");
            continue;
          }

          const format = (item.type ?? "mp3").replace(/^\./, "").toLowerCase();
          const bitrate = Number(item.br ?? 0) > 0 ? Number(item.br) : null;
          const durationSeconds =
            item.time && Number(item.time) > 0 ? Math.round(Number(item.time) / 1000) : null;
          const hasTrialFlag = Boolean(item.freeTrialInfo && Number(item.freeTrialInfo.end ?? 0) > 0);
          const trial = isTrialDuration(target.durationSeconds, durationSeconds, hasTrialFlag);
          // A14: Safely map upstream level (including vivid/dolby or unknown bitrate-inferred tiers)
          const actualLevel = normalizeQualityLevel(item.level, candidateLevel, { bitrate, format });
          const downgraded = isQualityDowngraded(level, { bitrate, format, level: actualLevel });

          const candidate: ResolvedAudio = {
            url: item.url.replace(/^http:\/\//i, "https://"),
            format,
            bitrate,
            level: actualLevel,
            durationSeconds,
            trial,
            downgraded,
          };

          // A06: Keep trial as last-resort fallback while continuing downward to find a full playable track
          if (trial) {
            if (!firstTrialFallback) {
              firstTrialFallback = candidate;
            }
            continue;
          }

          return candidate;
        } catch (error) {
          if (error instanceof AppError && error.code === "UPSTREAM_TIMEOUT") {
            throw error;
          }
          lastError = new AppError("UPSTREAM_ERROR", extractApiError(error, "解析网易云音源失败"), {
            cause: error,
          });
        }
      }
    }

    if (firstTrialFallback) {
      return firstTrialFallback;
    }

    throw lastError ?? new AppError("UPSTREAM_ERROR", "未能获取到可用的网易云音频流。");
  }

  async startQrLogin(scopeKey: string): Promise<QrStartResult> {
    this.#cleanupQrSessions();
    const keyRes = await this.#api.login_qr_key(this.#baseParams(undefined, { timestamp: Date.now() }));
    const key = (keyRes.body.data as { unikey?: string } | undefined)?.unikey;
    if (!key) {
      throw new AppError("UPSTREAM_ERROR", "网易云二维码登录初始化失败。");
    }

    const qrRes = await this.#api.login_qr_create(
      this.#baseParams(undefined, { key, platform: "web", qrimg: true, timestamp: Date.now() }),
    );
    const data = qrRes.body.data as { qrimg?: string; qrurl?: string } | undefined;
    if (!data?.qrimg) {
      throw new AppError("UPSTREAM_ERROR", "网易云二维码生成失败。");
    }

    this.#qrSessions.set(key, { scopeKey, createdAt: Date.now() });
    return { key, qrImage: data.qrimg, qrUrl: data.qrurl };
  }

  async checkQrLogin(
    scopeKey: string,
    key: string,
  ): Promise<QrCheckResult & { rawCookie?: string; verification?: CredentialVerificationResult }> {
    this.#cleanupQrSessions();
    const trimmedKey = key.trim();
    const session = this.#qrSessions.get(trimmedKey);
    if (!session || session.scopeKey !== scopeKey) {
      return { status: "expired", code: 800, message: "二维码已过期或不属于当前账号，请重新生成。" };
    }

    const response = await this.#api.login_qr_check(
      this.#baseParams(undefined, { key: trimmedKey, noCookie: true, timestamp: Date.now() }),
    );
    const code = Number(response.body.code ?? 0);
    const message = typeof response.body.message === "string" ? response.body.message : "";
    const rawCookie = typeof response.body.cookie === "string" ? response.body.cookie : undefined;

    if (code === 800) {
      this.#qrSessions.delete(trimmedKey);
      return { status: "expired", code, message: message || "二维码已过期，请刷新。" };
    }
    if (code === 801) return { status: "waiting", code, message: message || "等待网易云 App 扫码。" };
    if (code === 802) return { status: "scanned", code, message: message || "已扫码，请在手机确认。" };
    if (code === 803 && rawCookie) {
      this.#qrSessions.delete(trimmedKey);
      const verification = await this.verifyCredential(rawCookie);
      return {
        status: "confirmed",
        code,
        message: verification.message,
        rawCookie,
        verification,
      };
    }

    return { status: "error", code, message: message || "二维码登录状态异常。" };
  }
}
