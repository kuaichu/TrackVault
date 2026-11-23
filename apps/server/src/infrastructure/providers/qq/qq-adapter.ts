import { mergeLyricTranslations, parseLrc } from "#audio-tags";
import {
  type AlbumDetail,
  type AlbumSummary,
  type ArtistDetail,
  type ArtistSummary,
  type ChartDetail,
  type ChartSummary,
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
} from "#shared";
import { AppError } from "../../../domain/errors.js";
import { buildDownwardQualityOrder, isQualityDowngraded } from "../../../domain/policies/quality-policy.js";
import type {
  AudioResolveTarget,
  CreatePlaylistResult,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { computeQqGtk, extractEssentialQqCookie, parseQqCookie, serializeQqCookie } from "./qq-cookie.js";
import { QqMusicHttpClient } from "./qq-http-client.js";
import {
  type RawQqComment,
  type RawQqPlaylist,
  type RawQqSong,
  mapQqComment,
  mapQqPlaylist,
  mapQqSong,
} from "./qq-mapper.js";
import { QqQrAuthManager } from "./qq-qr-auth.js";

type QqFileSpec = { prefix: string; ext: string; bitrate: number; level: QualityLevel };

const QQ_QUALITY_SPECS: Record<"hires" | "flac" | "320" | "128" | "m4a", QqFileSpec> = {
  hires: { prefix: "RS01", ext: "flac", bitrate: 1_800_000, level: "hires" },
  flac: { prefix: "F000", ext: "flac", bitrate: 950_000, level: "lossless" },
  "320": { prefix: "M800", ext: "mp3", bitrate: 320_000, level: "exhigh" },
  "128": { prefix: "M500", ext: "mp3", bitrate: 128_000, level: "standard" },
  m4a: { prefix: "C400", ext: "m4a", bitrate: 96_000, level: "standard" },
};

function levelToQqSpecs(level: QualityLevel): QqFileSpec[] {
  const ordered = buildDownwardQualityOrder(level);
  const specs: QqFileSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: QqFileSpec) => {
    if (!seen.has(spec.prefix)) {
      seen.add(spec.prefix);
      specs.push(spec);
    }
  };
  for (const item of ordered) {
    if (item === "hires" || item === "jymaster") {
      add(QQ_QUALITY_SPECS.hires);
      add(QQ_QUALITY_SPECS.flac);
    } else if (item === "lossless") {
      add(QQ_QUALITY_SPECS.flac);
    } else if (item === "exhigh" || item === "jyeffect" || item === "sky") {
      add(QQ_QUALITY_SPECS["320"]);
    } else {
      add(QQ_QUALITY_SPECS["128"]);
    }
  }
  add(QQ_QUALITY_SPECS["128"]);
  add(QQ_QUALITY_SPECS.m4a);
  return specs;
}

function decodeBase64IfNeeded(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  if (raw.trim().startsWith("[")) return raw;
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
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

/**
 * Stateless QQ Music Adapter:
 * - Zero dependency on the global-singleton `qq-music-api` library.
 * - Explicit per-request cookies, dynamic g_tk, strict credential verification, and scoped LRU caches.
 */
export class QqMusicAdapter implements MusicProviderAdapter {
  readonly platform = "qq" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "qq",
    canLikeSong: false,
    canManagePlaylistTracks: false,
    canCreatePlaylist: false,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
  };

  readonly #client: QqMusicHttpClient;
  readonly #qrAuth: QqQrAuthManager;
  readonly #discoverCache = new ScopedLruCache<Song[]>({ maxEntries: 20, defaultTtlMs: 5 * 60 * 1000 });
  readonly #recommendedPlaylistsCache = new ScopedLruCache<PlaylistSummary[]>({
    maxEntries: 10,
    defaultTtlMs: 5 * 60 * 1000,
  });
  readonly #chartsCache = new ScopedLruCache<ChartSummary[]>({
    maxEntries: 10,
    defaultTtlMs: 15 * 60 * 1000,
  });
  readonly #chartDetailCache = new ScopedLruCache<ChartDetail>({
    maxEntries: 30,
    defaultTtlMs: 5 * 60 * 1000,
  });
  readonly #artistCache = new ScopedLruCache<ArtistDetail>({
    maxEntries: 60,
    defaultTtlMs: 10 * 60 * 1000,
  });
  readonly #albumCache = new ScopedLruCache<AlbumDetail>({
    maxEntries: 60,
    defaultTtlMs: 10 * 60 * 1000,
  });
  readonly #playlistCache = new ScopedLruCache<{ playlist: PlaylistSummary; songs: Song[] }>({
    maxEntries: 80,
    defaultTtlMs: 2 * 60 * 1000,
  });
  readonly #lyricCache = new ScopedLruCache<SongLyrics>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });
  readonly #songIdCache = new ScopedLruCache<string>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });

  constructor(http: SafeHttpClient) {
    this.#client = new QqMusicHttpClient(http);
    this.#qrAuth = new QqQrAuthManager(http);
  }

  invalidateScope(scopeKey: string): void {
    this.#discoverCache.invalidateScope(scopeKey);
    this.#recommendedPlaylistsCache.invalidateScope(scopeKey);
    this.#chartsCache.invalidateScope(scopeKey);
    this.#chartDetailCache.invalidateScope(scopeKey);
    this.#artistCache.invalidateScope(scopeKey);
    this.#albumCache.invalidateScope(scopeKey);
    this.#playlistCache.invalidateScope(scopeKey);
  }

  #cacheScope(auth: ProviderAuthContext, cookieMap: Record<string, string> | undefined): string {
    // C039: Authenticated QQ requests must NEVER write into the shared "public" cache scope
    return cookieMap ? auth.scopeKey : "public";
  }

  #parseCookie(auth: ProviderAuthContext): Record<string, string> | undefined {
    if (!auth.cookie?.trim()) return undefined;
    const parsed = parseQqCookie(auth.cookie);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  #requireCookie(auth: ProviderAuthContext): Record<string, string> {
    const parsed = this.#parseCookie(auth);
    if (!parsed?.uin || !(parsed.qm_keyst || parsed.qqmusic_key)) {
      throw new AppError("CREDENTIAL_REQUIRED", "请先绑定有效的 QQ 音乐账号凭证。");
    }
    return parsed;
  }

  /**
   * Real upstream credential verification (fixes v1 bug that returned ok: true on catch).
   */
  async verifyCredential(cookie: string): Promise<CredentialVerificationResult> {
    const essential = extractEssentialQqCookie(cookie);
    if (!essential.uin) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "QQ 音乐 Cookie 缺少 uin 或 wxuin。",
      };
    }
    if (!essential.qm_keyst && !essential.qqmusic_key) {
      return {
        ok: false,
        accountUid: essential.uin,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "QQ 音乐 Cookie 缺少 qm_keyst 或 qqmusic_key。",
      };
    }

    try {
      const profile = await this.#client.requestJson<{
        code?: number;
        data?: {
          creator?: {
            nick?: string;
            headpic?: string;
            uin?: string | number;
            userInfoUI?: { iconlist?: Array<{ type?: number; desc?: string }> };
            nums?: Record<string, unknown>;
          };
          vip?: { viplevel?: number; greenvip?: number; endtime?: number };
        };
      }>({
        url: "https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg",
        query: {
          cid: 205360838,
          userid: essential.uin,
          reqfrom: 1,
          format: "json",
          g_tk: computeQqGtk(essential),
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap: essential,
      });

      if (
        profile.code === 1000 ||
        profile.code === 301 ||
        (profile.code !== undefined && profile.code !== 0)
      ) {
        return {
          ok: false,
          accountUid: essential.uin,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: `QQ 音乐登录态校验失败或已过期 (code ${profile.code ?? "unknown"})。`,
        };
      }

      const creator = profile.data?.creator;
      const displayName = creator?.nick?.trim() || `QQ ${essential.uin}`;
      const avatarUrl = normalizeCoverUrl(creator?.headpic, 200) ?? null;
      // Explicit VIP path check (no recursive blind scan over arbitrary "lv"/"green" keys)
      const vipNode = profile.data?.vip;
      const vipEnabled = Boolean(
        (typeof vipNode?.greenvip === "number" && vipNode.greenvip > 0) ||
          (typeof vipNode?.viplevel === "number" && vipNode.viplevel > 0),
      );
      const rawEnd = vipNode?.endtime;
      const vipExpireAt =
        typeof rawEnd === "number" && rawEnd > 0 ? (rawEnd > 10_000_000_000 ? rawEnd : rawEnd * 1000) : null;

      return {
        ok: true,
        accountUid: essential.uin,
        displayName,
        avatarUrl,
        vipEnabled,
        vipExpireAt,
        normalizedCookie: serializeQqCookie(essential),
        message: `QQ 音乐账号验证成功：${displayName}`,
      };
    } catch (error) {
      return {
        ok: false,
        accountUid: essential.uin,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: error instanceof Error ? error.message : "QQ 音乐凭证校验请求失败。",
      };
    }
  }

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const safeLimit = Math.min(50, Math.max(1, limit));
    const cookieMap = this.#parseCookie(auth);

    const response = await this.#client.musicu<{
      req?: { data?: { body?: { song?: { list?: RawQqSong[] } } } };
    }>(
      {
        req: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: {
            query: keyword,
            search_type: 0,
            num_per_page: safeLimit,
            page_num: 1,
          },
        },
      },
      cookieMap,
      auth.signal,
    );

    const list = response.req?.data?.body?.song?.list ?? [];
    if (list.length > 0) {
      return list.map(mapQqSong).filter((song): song is Song => song !== null);
    }

    // Clean single fallback to legacy search endpoint
    const fallback = await this.#client.requestJson<{ data?: { song?: { list?: RawQqSong[] } } }>({
      url: "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
      query: {
        format: "json",
        w: keyword,
        p: 1,
        n: safeLimit,
        cr: 1,
        g_tk: cookieMap ? computeQqGtk(cookieMap) : 5381,
      },
      cookieMap,
      signal: auth.signal,
    });
    return (fallback.data?.song?.list ?? []).map(mapQqSong).filter((song): song is Song => song !== null);
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#discoverCache.get(scope, "discover");
    if (cached) return cached;

    const response = await this.#client.musicu<{
      new_song?: { data?: { songlist?: RawQqSong[] } };
    }>(
      {
        new_song: {
          module: "newsong.NewSongServer",
          method: "get_new_song_info",
          param: { type: 5 },
        },
      },
      cookieMap,
      auth.signal,
    );

    const songs = (response.new_song?.data?.songlist ?? [])
      .map(mapQqSong)
      .filter((song): song is Song => song !== null)
      .slice(0, 30);

    this.#discoverCache.set(scope, "discover", songs);
    return songs;
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const cookieMap = this.#requireCookie(auth);
    const gtk = computeQqGtk(cookieMap);

    const fetchCollectedPlaylists = async (): Promise<{
      code?: number;
      items: RawQqPlaylist[];
    }> => {
      const items: RawQqPlaylist[] = [];
      const pageSize = 50;
      for (let page = 0; page < 10; page += 1) {
        const sin = page * pageSize;
        const res = await this.#client.requestJson<{
          code?: number;
          data?: { totaldiss?: number; cdlist?: RawQqPlaylist[] };
        }>({
          url: "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
          query: {
            ct: 20,
            cid: 205360956,
            userid: cookieMap.uin,
            reqtype: 3,
            sin,
            ein: sin + pageSize - 1,
            format: "json",
            g_tk: gtk,
          },
          referer: "https://y.qq.com/portal/profile.html",
          cookieMap,
          signal: auth.signal,
        });
        if (res.code === 1000 || res.code === 301) {
          throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
        }
        if (res.code !== undefined && res.code !== 0) {
          return { code: res.code, items };
        }
        const batch = res.data?.cdlist ?? [];
        items.push(...batch);
        const total = Number(res.data?.totaldiss ?? 0);
        if (batch.length < pageSize || (total > 0 && items.length >= total)) {
          break;
        }
      }
      return { code: 0, items };
    };

    const [createdRes, collectedRes] = await Promise.allSettled([
      this.#client.requestJson<{
        code?: number;
        data?: { hostname?: string; disslist?: RawQqPlaylist[] };
      }>({
        url: "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss",
        query: {
          hostuin: cookieMap.uin,
          sin: 0,
          size: 200,
          g_tk: gtk,
          loginUin: cookieMap.uin,
          format: "json",
          inCharset: "utf8",
          outCharset: "utf-8",
          notice: 0,
          platform: "yqq.json",
          needNewCode: 0,
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap,
        signal: auth.signal,
      }),
      fetchCollectedPlaylists(),
    ]);

    // A11: Never mask expired credentials (code 1000/301) as an empty playlist list
    if (createdRes.status === "fulfilled") {
      const code = createdRes.value.code;
      if (code === 1000 || code === 301) {
        throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
      }
    }
    if (
      collectedRes.status === "rejected" &&
      collectedRes.reason instanceof AppError &&
      collectedRes.reason.code === "CREDENTIAL_INVALID"
    ) {
      throw collectedRes.reason;
    }

    const createdFailed =
      createdRes.status === "rejected" ||
      (createdRes.value.code !== undefined && createdRes.value.code !== 0);
    const collectedFailed =
      collectedRes.status === "rejected" ||
      (collectedRes.value.code !== undefined && collectedRes.value.code !== 0);

    if (createdFailed && collectedFailed) {
      if (createdRes.status === "rejected" && createdRes.reason instanceof AppError) {
        throw createdRes.reason;
      }
      const errCode = createdRes.status === "fulfilled" ? createdRes.value.code : "unknown";
      throw new AppError("UPSTREAM_ERROR", `获取 QQ 音乐歌单列表失败 (code ${errCode})。`);
    }

    const fallbackCreator =
      createdRes.status === "fulfilled" && !createdFailed
        ? createdRes.value.data?.hostname?.trim() || `QQ ${cookieMap.uin}`
        : `QQ ${cookieMap.uin}`;

    const created =
      createdRes.status === "fulfilled" && !createdFailed
        ? (createdRes.value.data?.disslist ?? [])
            .map((p) => mapQqPlaylist(p, fallbackCreator, true))
            .filter((p): p is PlaylistSummary => p !== null)
        : [];

    const collected =
      collectedRes.status === "fulfilled" && !collectedFailed
        ? collectedRes.value.items
            .map((p) => mapQqPlaylist(p, fallbackCreator, false))
            .filter((p): p is PlaylistSummary => p !== null)
        : [];

    const seen = new Set<string>();
    return [...created, ...collected].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  async #fetchPlaylistRaw(
    playlistId: string,
    auth: ProviderAuthContext,
  ): Promise<{ playlist: PlaylistSummary; songs: Song[] }> {
    const cleanId = playlistId.replace(/^qq:/i, "").trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌单 ID。");
    }

    const cookieMap = this.#parseCookie(auth);
    const cacheScope = this.#cacheScope(auth, cookieMap);
    const cached = this.#playlistCache.get(cacheScope, cleanId);
    if (cached) return cached;

    const data = await this.#client.requestJson<{
      code?: number;
      cdlist?: Array<{
        disstid?: string;
        dissname?: string;
        logo?: string;
        nickname?: string;
        uin?: string | number;
        desc?: string;
        songlist?: RawQqSong[];
      }>;
    }>({
      url: "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
      query: {
        type: 1,
        utf8: 1,
        disstid: cleanId,
        loginUin: cookieMap?.uin ?? 0,
        g_tk: cookieMap ? computeQqGtk(cookieMap) : 5381,
        format: "json",
      },
      referer: "https://y.qq.com/n/yqq/playlist",
      cookieMap,
      signal: auth.signal,
    });

    // A11: Validate business code and payload BEFORE mapping or caching
    if (data.code === 1000 || data.code === 301) {
      throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
    }
    if (data.code !== undefined && data.code !== 0) {
      throw new AppError("UPSTREAM_ERROR", `获取 QQ 音乐歌单详情失败 (code ${data.code})。`);
    }

    const cd = data.cdlist?.[0];
    if (!cd) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐歌单或无访问权限。");
    }

    const songs = (cd.songlist ?? []).map(mapQqSong).filter((s): s is Song => s !== null);
    const creatorUin = cd.uin !== undefined && cd.uin !== null ? String(cd.uin).replace(/\D/g, "") : "";
    const owned = Boolean(cookieMap?.uin && creatorUin && cookieMap.uin === creatorUin);

    const playlist: PlaylistSummary = {
      id: cleanId,
      platform: "qq",
      name: cd.dissname?.trim() || `QQ 歌单 ${cleanId}`,
      coverUrl: normalizeCoverUrl(cd.logo, 300),
      trackCount: songs.length,
      creatorName: cd.nickname?.trim() || "QQ 音乐用户",
      owned,
      description: cd.desc?.trim() || undefined,
    };

    const bundle = { playlist, songs };
    this.#playlistCache.set(cacheScope, cleanId, bundle);
    return bundle;
  }

  async getAllPlaylistTracks(
    playlistId: string,
    auth: ProviderAuthContext,
    maxTracks = 2000,
  ): Promise<Song[]> {
    const { songs } = await this.#fetchPlaylistRaw(playlistId, auth);
    return songs.slice(0, maxTracks);
  }

  async getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    const safePage = Math.max(1, Math.floor(query.page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(query.limit) || 50));
    const { playlist, songs: allSongs } = await this.#fetchPlaylistRaw(playlistId, auth);

    const filtered = sortAndFilterSongs(allSongs, query.keyword, query.sort);
    const offset = (safePage - 1) * safeLimit;
    const pageSongs = filtered.slice(offset, offset + safeLimit);

    return {
      playlist,
      songs: pageSongs,
      total: filtered.length,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + pageSongs.length < filtered.length,
    };
  }

  async createPlaylistWithTracks(
    _name: string,
    _trackMids: string[],
    _auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    throw new AppError(
      "FEATURE_UNSUPPORTED",
      "QQ 音乐暂不支持服务端自动创建歌单，请导出清单后手动导入或选择网易云作为目标平台。",
    );
  }

  async #resolveNumericSongId(songId: string, auth: ProviderAuthContext): Promise<string> {
    const clean = songId.trim();
    if (!clean) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌曲 ID。");
    }
    if (/^\d+$/.test(clean)) {
      return clean;
    }

    const cached = this.#songIdCache.get("public", clean);
    if (cached) return cached;

    const cookieMap = this.#parseCookie(auth);
    const res = await this.#client.musicu<{
      songinfo?: {
        data?: {
          track_info?: { id?: number | string };
        };
      };
    }>(
      {
        songinfo: {
          module: "music.pf_song_detail_svr",
          method: "get_song_detail_yqq",
          param: { song_mid: clean, song_type: 0 },
        },
      },
      cookieMap,
      auth.signal,
    );

    const numericId = res.songinfo?.data?.track_info?.id;
    const resolved = numericId !== undefined && numericId !== null ? String(numericId).trim() : "";
    if (!/^\d+$/.test(resolved)) {
      throw new AppError("NOT_FOUND", "无法解析该 QQ 音乐曲目的数字 songid，暂不支持加载评论。");
    }
    this.#songIdCache.set("public", clean, resolved);
    return resolved;
  }

  async getLyrics(
    songId: string,
    mediaId: string | undefined,
    auth: ProviderAuthContext,
  ): Promise<SongLyrics> {
    // BUG-13: QQ lyric API requires songmid (non-numeric songId), NOT media_mid (mediaId),
    // which differs from songmid on many tracks (e.g. 周杰伦《晴天》).
    const cleanSongId = songId.trim();
    const cleanMediaId = mediaId?.trim() ?? "";
    const targetMid =
      cleanSongId && !/^\d+$/.test(cleanSongId)
        ? cleanSongId
        : cleanMediaId && !/^\d+$/.test(cleanMediaId)
          ? cleanMediaId
          : cleanSongId;

    const cached = this.#lyricCache.get("public", targetMid);
    if (cached) return cached;

    try {
      const data = await this.#client.requestJson<{ lyric?: string; trans?: string }>({
        url: "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
        query: {
          songmid: targetMid,
          pcachetime: Date.now(),
          g_tk: 5381,
          loginUin: 0,
          hostUin: 0,
          format: "json",
          inCharset: "utf8",
          outCharset: "utf-8",
          notice: 0,
          platform: "yqq",
          needNewCode: 0,
        },
        referer: "https://y.qq.com/",
        signal: auth.signal,
      });

      const lines = mergeLyricTranslations(
        parseLrc(decodeBase64IfNeeded(data.lyric)),
        parseLrc(decodeBase64IfNeeded(data.trans)),
      );
      const result: SongLyrics = {
        songId,
        platform: "qq",
        lines,
        source: lines.length > 0 ? "qqmusic" : "none",
      };
      this.#lyricCache.set("public", targetMid, result, lines.length > 0 ? 30 * 60 * 1000 : 5 * 60 * 1000);
      return result;
    } catch {
      return { songId, platform: "qq", lines: [], source: "none" };
    }
  }

  async getComments(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage> {
    const safeId = await this.#resolveNumericSongId(songId, auth);
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));
    const cookieMap = this.#parseCookie(auth);

    const data = await this.#client.requestJson<{
      code?: number;
      comment?: { commenttotal?: number; commentlist?: RawQqComment[] };
      hot_comment?: { commentlist?: RawQqComment[] };
    }>({
      url: "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg",
      query: {
        biztype: 1,
        topid: safeId,
        loginUin: cookieMap?.uin ?? 0,
        cmd: 8,
        pagenum: safePage - 1,
        pagesize: safeLimit,
        format: "json",
      },
      cookieMap,
      signal: auth.signal,
    });

    if (data.code !== undefined && data.code !== 0) {
      throw new AppError("UPSTREAM_ERROR", `获取 QQ 音乐评论失败 (code ${data.code})。`);
    }

    const comments = (data.comment?.commentlist ?? [])
      .map(mapQqComment)
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const hotComments =
      safePage === 1
        ? (data.hot_comment?.commentlist ?? [])
            .map(mapQqComment)
            .filter((c): c is NonNullable<typeof c> => c !== null)
        : [];
    const total = Math.max(0, Number(data.comment?.commenttotal ?? 0) || comments.length);
    const offset = (safePage - 1) * safeLimit;

    return {
      songId: safeId,
      platform: "qq",
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: comments.length > 0 && offset + comments.length < total,
      hotComments,
      comments,
    };
  }

  async setCommentLiked(
    songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    const cookieMap = this.#requireCookie(auth);
    const topId = await this.#resolveNumericSongId(songId, auth);
    const res = await this.#client.requestJson<{ code?: number; msg?: string }>({
      url: "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_praise_h5.fcg",
      query: {
        g_tk: computeQqGtk(cookieMap),
        loginUin: cookieMap.uin,
        format: "json",
        inCharset: "utf8",
        outCharset: "utf-8",
        biztype: 1,
        topid: topId,
        cmd: liked ? 1 : 2,
        reqtype: 2,
        commentid: commentId.trim(),
      },
      cookieMap,
      signal: auth.signal,
    });
    if (res.code !== 0) {
      throw new AppError(
        "UPSTREAM_ERROR",
        res.msg || `QQ 音乐评论点赞失败 (code ${res.code ?? "unknown"})。`,
      );
    }
    return { liked };
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    _mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    const cookieMap = this.#parseCookie(auth);
    const songMid = target.id.trim();
    const mediaMid = (target.mediaId || songMid).trim();
    const specs = levelToQqSpecs(level);
    const guid = String(Math.floor(Math.random() * 10_000_000));

    let gotValidUpstreamResponse = false;
    let lastTransportError: AppError | null = null;
    let firstTrialFallback: ResolvedAudio | null = null;

    for (const spec of specs) {
      const filename = `${spec.prefix}${mediaMid}${spec.ext ? `.${spec.ext}` : ""}`;
      let res: {
        code?: number;
        req_0?: {
          code?: number;
          data?: {
            sip?: string[];
            midurlinfo?: Array<{
              purl?: string;
              opi30surl?: string;
              songmid?: string;
              filename?: string;
              result?: number;
            }>;
          };
        };
      };

      try {
        res = await this.#client.musicu(
          {
            req_0: {
              module: "vkey.GetVkeyServer",
              method: "CgiGetVkey",
              param: {
                filename: [filename],
                guid,
                songmid: [songMid],
                songtype: [0],
                uin: cookieMap?.uin ?? "0",
                loginflag: 1,
                platform: "20",
              },
            },
          },
          cookieMap,
          auth.signal,
        );
        gotValidUpstreamResponse = true;
      } catch (error) {
        if (error instanceof AppError && error.code === "UPSTREAM_TIMEOUT") {
          lastTransportError = error;
        } else if (error instanceof AppError) {
          lastTransportError = error;
        } else {
          lastTransportError = new AppError("UPSTREAM_ERROR", "QQ 音乐音源解析请求失败。", { cause: error });
        }
        continue;
      }

      const info = res.req_0?.data?.midurlinfo?.[0];
      const rawPurl = info?.purl?.trim() ?? "";
      const rawTrialUrl = info?.opi30surl?.trim() ?? "";
      const sipList = res.req_0?.data?.sip ?? [];
      const sip = sipList.find((s) => s.startsWith("https://")) ?? sipList[0];

      const effectivePurl = rawPurl || rawTrialUrl;
      if (!effectivePurl || !sip) continue;

      const isTrialUrl =
        !rawPurl ||
        (Boolean(rawTrialUrl) && rawPurl === rawTrialUrl) ||
        /(?:^|\/)(?:O4M0|RS02)/i.test(effectivePurl) ||
        (info?.result !== undefined && info.result !== 0);

      const fullUrl = `${sip.replace(/^http:\/\//i, "https://")}${effectivePurl}`;
      const downgraded = isQualityDowngraded(level, {
        bitrate: spec.bitrate,
        format: spec.ext,
        level: spec.level,
      });

      const candidate: ResolvedAudio = {
        url: fullUrl,
        format: spec.ext,
        bitrate: spec.bitrate,
        level: spec.level,
        durationSeconds: target.durationSeconds ?? null,
        trial: isTrialUrl,
        downgraded,
      };

      if (isTrialUrl) {
        if (!firstTrialFallback) {
          firstTrialFallback = candidate;
        }
        continue;
      }

      return candidate;
    }

    if (firstTrialFallback) {
      return firstTrialFallback;
    }

    // A12: Distinguish upstream transport failures (503/timeout) from genuine copyright unavailability
    if (!gotValidUpstreamResponse && lastTransportError) {
      throw lastTransportError;
    }

    throw new AppError(
      "COPYRIGHT_UNAVAILABLE",
      "QQ 音乐未返回可用音频链接，请检查 QQ 音乐账号绑定、绿钻权限或该曲目版权状态。",
    );
  }

  async getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    const safeLimit = Math.min(30, Math.max(1, limit));
    const cacheKey = `rec:${safeLimit}`;
    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#recommendedPlaylistsCache.get(scope, cacheKey);
    if (cached) return cached;

    const res = await this.#client.musicu<{
      rec?: {
        data?: {
          grids?: Array<{
            id?: number | string;
            title?: string;
            picurl?: string;
            creator?: { nick?: string };
          }>;
        };
      };
    }>(
      {
        rec: {
          module: "playlist.HotRecommendServer",
          method: "get_new_hot_recommend",
          param: { cmd: 0, page: 0, daily_page: 0, size: safeLimit },
        },
      },
      cookieMap,
      auth.signal,
    );

    const playlists: PlaylistSummary[] = (res.rec?.data?.grids ?? [])
      .filter((item) => item.id !== undefined && Boolean(item.title?.trim()))
      .slice(0, safeLimit)
      .map((item) => ({
        id: String(item.id),
        platform: "qq",
        name: item.title?.trim() ?? "",
        coverUrl: normalizeCoverUrl(item.picurl, 400),
        trackCount: 0,
        creatorName: item.creator?.nick?.trim() || "QQ 音乐推荐",
        owned: false,
      }));

    this.#recommendedPlaylistsCache.set(scope, cacheKey, playlists);
    return playlists;
  }

  async getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#chartsCache.get(scope, "charts");
    if (cached) return cached;

    const res = await this.#client.musicu<{
      charts?: {
        data?: {
          group?: Array<{
            toplist?: Array<{
              topId?: number;
              title?: string;
              headPicUrl?: string;
              frontPicUrl?: string;
              musichallPicUrl?: string;
              updateTime?: string;
              totalNum?: number;
              song?: Array<{ title?: string; singerName?: string }>;
            }>;
          }>;
        };
      };
    }>(
      {
        charts: {
          module: "musicToplist.ToplistInfoServer",
          method: "GetAll",
          param: {},
        },
      },
      cookieMap,
      auth.signal,
    );

    const seen = new Set<string>();
    const list: ChartSummary[] = [];
    for (const group of res.charts?.data?.group ?? []) {
      for (const item of group.toplist ?? []) {
        if (!item.topId || !item.title?.trim()) continue;
        const id = String(item.topId);
        if (seen.has(id)) continue;
        seen.add(id);
        list.push({
          id,
          platform: "qq",
          name: item.title.trim(),
          coverUrl: normalizeCoverUrl(item.headPicUrl || item.frontPicUrl || item.musichallPicUrl, 400),
          updateFrequency: item.updateTime ? `更新于 ${item.updateTime}` : undefined,
          trackCount: Math.max(0, Number(item.totalNum ?? 0) || 0),
          previewTracks: (item.song ?? [])
            .slice(0, 3)
            .map((s) => [s.title, s.singerName].filter(Boolean).join(" - "))
            .filter(Boolean),
        });
      }
    }

    const capped = list.slice(0, 36);
    this.#chartsCache.set(scope, "charts", capped);
    return capped;
  }

  async getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    const topId = Number(chartId);
    if (!Number.isFinite(topId) || topId <= 0) {
      throw new AppError("VALIDATION_ERROR", "非法的 QQ 音乐榜单 ID。");
    }

    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#chartDetailCache.get(scope, String(topId));
    if (cached) return cached;

    const res = await this.#client.musicu<{
      detail?: {
        data?: {
          data?: {
            topId?: number;
            title?: string;
            headPicUrl?: string;
            frontPicUrl?: string;
            updateTime?: string;
            totalNum?: number;
          };
          songInfoList?: RawQqSong[];
        };
      };
    }>(
      {
        detail: {
          module: "musicToplist.ToplistInfoServer",
          method: "GetDetail",
          param: { topId, offset: 0, num: 100 },
        },
      },
      cookieMap,
      auth.signal,
    );

    const info = res.detail?.data?.data;
    const songs = (res.detail?.data?.songInfoList ?? [])
      .map(mapQqSong)
      .filter((song): song is Song => song !== null);

    const result: ChartDetail = {
      chart: {
        id: String(topId),
        platform: "qq",
        name: info?.title?.trim() || `QQ 榜单 ${topId}`,
        coverUrl: normalizeCoverUrl(info?.headPicUrl || info?.frontPicUrl, 400),
        updateFrequency: info?.updateTime ? `更新于 ${info.updateTime}` : undefined,
        trackCount: Math.max(songs.length, Number(info?.totalNum ?? 0) || 0),
      },
      songs,
    };

    this.#chartDetailCache.set(scope, String(topId), result);
    return result;
  }

  async getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    const singerMid = artistId.trim();
    if (!singerMid) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌手 ID。");
    }

    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#artistCache.get(scope, singerMid);
    if (cached) return cached;

    const res = await this.#client.musicu<{
      singerInfo?: {
        data?: {
          singer_list?: Array<{
            basic_info?: { singer_mid?: string; name?: string };
            ex_info?: { desc?: string };
          }>;
        };
      };
      singerSongs?: {
        data?: {
          totalNum?: number;
          songList?: Array<{ songInfo?: RawQqSong }>;
        };
      };
      singerAlbums?: {
        data?: {
          total?: number;
          albumList?: Array<{
            albumMid?: string;
            albumName?: string;
            publishDate?: string;
            albumType?: string;
            singerName?: string;
            totalNum?: number;
          }>;
        };
      };
    }>(
      {
        singerInfo: {
          module: "music.musichallSinger.SingerInfoInter",
          method: "GetSingerDetail",
          param: {
            singer_mids: [singerMid],
            ex_singer: 1,
            wiki_singer: 1,
            group_singer: 0,
            pic: 1,
            photos: 0,
          },
        },
        singerSongs: {
          module: "music.musichallSong.SongListInter",
          method: "GetSingerSongList",
          param: { singerMid, begin: 0, num: 50, order: 1 },
        },
        singerAlbums: {
          module: "music.musichallAlbum.AlbumListServer",
          method: "GetAlbumList",
          param: { singerMid, begin: 0, num: 30, order: 0 },
        },
      },
      cookieMap,
      auth.signal,
    );

    const info = res.singerInfo?.data?.singer_list?.[0];
    const hotSongs = (res.singerSongs?.data?.songList ?? [])
      .map((item) => (item.songInfo ? mapQqSong(item.songInfo) : null))
      .filter((song): song is Song => song !== null);

    const name = info?.basic_info?.name?.trim() || hotSongs[0]?.artist.split(" / ")[0] || "";
    if (!name) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐歌手信息。");
    }

    const albums: AlbumSummary[] = (res.singerAlbums?.data?.albumList ?? [])
      .filter((a) => Boolean(a.albumMid?.trim()) && Boolean(a.albumName?.trim()))
      .map((a) => ({
        id: a.albumMid?.trim() ?? "",
        platform: "qq",
        name: a.albumName?.trim() ?? "",
        coverUrl: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${encodeURIComponent(a.albumMid?.trim() ?? "")}.jpg`,
        artistName: a.singerName?.trim() || name,
        artistId: singerMid,
        publishDate: a.publishDate?.trim() || undefined,
        trackCount: typeof a.totalNum === "number" && a.totalNum > 0 ? a.totalNum : undefined,
        albumType: a.albumType?.trim() || undefined,
      }));

    const result: ArtistDetail = {
      id: singerMid,
      platform: "qq",
      name,
      avatarUrl: `https://y.gtimg.cn/music/photo_new/T001R300x300M000${encodeURIComponent(singerMid)}.jpg`,
      briefDesc: info?.ex_info?.desc?.trim() || undefined,
      songCount: res.singerSongs?.data?.totalNum ?? hotSongs.length,
      albumCount: res.singerAlbums?.data?.total ?? albums.length,
      hotSongs,
      albums,
    };

    this.#artistCache.set(scope, singerMid, result);
    return result;
  }

  async getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    const albumMid = albumId.trim();
    if (!albumMid) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐专辑 ID。");
    }

    const cookieMap = this.#parseCookie(auth);
    const scope = this.#cacheScope(auth, cookieMap);
    const cached = this.#albumCache.get(scope, albumMid);
    if (cached) return cached;

    const res = await this.#client.musicu<{
      detail?: {
        data?: {
          basicInfo?: {
            albumMid?: string;
            albumName?: string;
            publishDate?: string;
            desc?: string;
          };
          company?: { name?: string };
          singer?: { singerList?: Array<{ mid?: string; name?: string }> };
        };
      };
      songs?: {
        data?: {
          totalNum?: number;
          songList?: Array<{ songInfo?: RawQqSong }>;
        };
      };
    }>(
      {
        detail: {
          module: "music.musichallAlbum.AlbumInfoServer",
          method: "GetAlbumDetail",
          param: { albumMid },
        },
        songs: {
          module: "music.musichallAlbum.AlbumSongList",
          method: "GetAlbumSongList",
          param: { albumMid, begin: 0, num: 100, order: 2 },
        },
      },
      cookieMap,
      auth.signal,
    );

    const basic = res.detail?.data?.basicInfo;
    if (!basic?.albumName?.trim()) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐专辑信息。");
    }

    const songs = (res.songs?.data?.songList ?? [])
      .map((item) => (item.songInfo ? mapQqSong(item.songInfo) : null))
      .filter((song): song is Song => song !== null);

    const artists = (res.detail?.data?.singer?.singerList ?? [])
      .map((s) => ({ id: s.mid?.trim() || undefined, name: s.name?.trim() ?? "" }))
      .filter((s) => Boolean(s.name));

    const result: AlbumDetail = {
      id: albumMid,
      platform: "qq",
      name: basic.albumName.trim(),
      coverUrl: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${encodeURIComponent(albumMid)}.jpg`,
      artists: artists.length > 0 ? artists : [{ name: "未知歌手" }],
      publishDate: basic.publishDate?.trim() || undefined,
      company: res.detail?.data?.company?.name?.trim() || undefined,
      description: basic.desc?.trim() || undefined,
      trackCount: Math.max(songs.length, Number(res.songs?.data?.totalNum ?? 0) || 0),
      songs,
    };

    this.#albumCache.set(scope, albumMid, result);
    return result;
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
    const searchType = type === "artist" ? 1 : type === "album" ? 2 : 3;
    const cookieMap = this.#parseCookie(auth);

    const res = await this.#client.musicu<{
      req?: {
        data?: {
          body?: {
            singer?: {
              list?: Array<{
                singerMID?: string;
                singerName?: string;
                singerPic?: string;
                songNum?: number;
                albumNum?: number;
              }>;
            };
            album?: {
              list?: Array<{
                albumMID?: string;
                albumName?: string;
                albumPic?: string;
                publicTime?: string;
                singerMID?: string;
                singerName?: string;
                song_count?: number;
              }>;
            };
            songlist?: {
              list?: Array<{
                dissid?: string | number;
                dissname?: string;
                imgurl?: string;
                song_count?: number;
                creator?: { name?: string };
              }>;
            };
          };
        };
      };
    }>(
      {
        req: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: {
            query: keyword,
            search_type: searchType,
            num_per_page: safeLimit,
            page_num: 1,
          },
        },
      },
      cookieMap,
      auth.signal,
    );

    const body = res.req?.data?.body;
    if (type === "artist") {
      return {
        artists: (body?.singer?.list ?? [])
          .filter((a) => Boolean(a.singerMID?.trim()) && Boolean(a.singerName?.trim()))
          .map((a) => ({
            id: a.singerMID?.trim() ?? "",
            platform: "qq",
            name: a.singerName?.trim() ?? "",
            avatarUrl: normalizeCoverUrl(a.singerPic, 300),
            songCount: typeof a.songNum === "number" ? a.songNum : undefined,
            albumCount: typeof a.albumNum === "number" ? a.albumNum : undefined,
          })),
      };
    }

    if (type === "album") {
      return {
        albums: (body?.album?.list ?? [])
          .filter((a) => Boolean(a.albumMID?.trim()) && Boolean(a.albumName?.trim()))
          .map((a) => ({
            id: a.albumMID?.trim() ?? "",
            platform: "qq",
            name: a.albumName?.trim() ?? "",
            coverUrl: normalizeCoverUrl(a.albumPic, 400),
            artistName: a.singerName?.trim() || "未知歌手",
            artistId: a.singerMID?.trim() || undefined,
            publishDate: a.publicTime?.trim() || undefined,
            trackCount: typeof a.song_count === "number" ? a.song_count : undefined,
          })),
      };
    }

    return {
      playlists: (body?.songlist?.list ?? [])
        .filter((p) => p.dissid !== undefined && Boolean(p.dissname?.trim()))
        .map((p) => ({
          id: String(p.dissid),
          platform: "qq",
          name: p.dissname?.trim() ?? "",
          coverUrl: normalizeCoverUrl(p.imgurl, 400),
          trackCount: Math.max(0, Number(p.song_count ?? 0) || 0),
          creatorName: p.creator?.name?.trim() || "QQ 音乐用户",
          owned: false,
        })),
    };
  }

  async startQrLogin(scopeKey: string): Promise<QrStartResult> {
    return this.#qrAuth.start(scopeKey);
  }

  async checkQrLogin(
    scopeKey: string,
    key: string,
  ): Promise<QrCheckResult & { rawCookie?: string; verification?: CredentialVerificationResult }> {
    const check = await this.#qrAuth.check(scopeKey, key);
    if (check.status === "confirmed" && check.rawCookie) {
      const verification = await this.verifyCredential(check.rawCookie);
      return { ...check, verification };
    }
    return check;
  }
}
