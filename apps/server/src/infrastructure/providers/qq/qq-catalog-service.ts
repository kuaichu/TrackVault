import { mergeLyricTranslations, parseLrc } from "#audio-tags";
import type {
  AlbumDetail,
  ArtistDetail,
  ChartDetail,
  ChartSummary,
  EntitySearchType,
  PlaylistSummary,
  Song,
  SongCommentsPage,
  SongLyrics,
} from "#shared";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { resolveProviderCacheScope } from "../common/cache-scope.js";
import {
  QQ_COMMENT_LIST_URL,
  QQ_COMMENT_PRAISE_URL,
  QQ_LEGACY_SEARCH_URL,
  QQ_LYRIC_URL,
  type RawQqAlbumDetailResponse,
  type RawQqArtistDetailResponse,
  type RawQqChartDetailResponse,
  type RawQqChartsResponse,
  type RawQqCommentPraiseResponse,
  type RawQqCommentsResponse,
  type RawQqDiscoverResponse,
  type RawQqEntitySearchResponse,
  type RawQqLegacySearchResponse,
  type RawQqLyricResponse,
  type RawQqRecommendedPlaylistsResponse,
  type RawQqSearchResponse,
  type RawQqSongInfoResponse,
  buildQqAlbumDetailPayload,
  buildQqArtistDetailPayload,
  buildQqChartDetailPayload,
  buildQqChartsPayload,
  buildQqDiscoverPayload,
  buildQqEntitySearchPayload,
  buildQqRecommendedPlaylistsPayload,
  buildQqSearchPayload,
  buildQqSongDetailPayload,
} from "./qq-cgi-endpoints.js";
import { computeQqGtk, parseQqAuthCookie, requireQqAuthCookie } from "./qq-cookie.js";
import type { QqMusicHttpClient } from "./qq-http-client.js";
import {
  mapQqAlbumDetail,
  mapQqArtistDetail,
  mapQqChartDetail,
  mapQqCharts,
  mapQqComment,
  mapQqEntitySearchResult,
  mapQqRecommendedPlaylists,
  mapQqSong,
} from "./qq-mapper.js";

function decodeBase64IfNeeded(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  if (raw.trim().startsWith("[")) return raw;
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

export class QqCatalogService {
  readonly #client: QqMusicHttpClient;
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
  readonly #lyricCache = new ScopedLruCache<SongLyrics>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });
  readonly #songIdCache = new ScopedLruCache<string>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });

  constructor(client: QqMusicHttpClient) {
    this.#client = client;
  }

  invalidateScope(scopeKey: string): void {
    this.#discoverCache.invalidateScope(scopeKey);
    this.#recommendedPlaylistsCache.invalidateScope(scopeKey);
    this.#chartsCache.invalidateScope(scopeKey);
    this.#chartDetailCache.invalidateScope(scopeKey);
    this.#artistCache.invalidateScope(scopeKey);
    this.#albumCache.invalidateScope(scopeKey);
  }

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const safeLimit = Math.min(50, Math.max(1, limit));
    const cookieMap = parseQqAuthCookie(auth);

    const response = await this.#client.musicu<RawQqSearchResponse>(
      buildQqSearchPayload(keyword, 0, safeLimit),
      cookieMap,
      auth.signal,
    );

    const list = response.req?.data?.body?.song?.list ?? [];
    if (list.length > 0) {
      return list
        .map((item) => mapQqSong(item, { vipEnabled: auth.vipEnabled }))
        .filter((song): song is Song => song !== null);
    }

    const fallback = await this.#client.requestJson<RawQqLegacySearchResponse>({
      url: QQ_LEGACY_SEARCH_URL,
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
    return (fallback.data?.song?.list ?? [])
      .map((item) => mapQqSong(item, { vipEnabled: auth.vipEnabled }))
      .filter((song): song is Song => song !== null);
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#discoverCache.get(scope, "discover");
    if (cached) return cached;

    const response = await this.#client.musicu<RawQqDiscoverResponse>(
      buildQqDiscoverPayload(),
      cookieMap,
      auth.signal,
    );

    const songs = (response.new_song?.data?.songlist ?? [])
      .map((item) => mapQqSong(item, { vipEnabled: auth.vipEnabled }))
      .filter((song): song is Song => song !== null)
      .slice(0, 30);

    this.#discoverCache.set(scope, "discover", songs);
    return songs;
  }

  async #resolveNumericSongId(songId: string, auth: ProviderAuthContext): Promise<string> {
    const clean = songId.trim();
    if (!clean) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌曲 ID。");
    }
    if (/^\d+$/.test(clean)) return clean;

    const cached = this.#songIdCache.get("public", clean);
    if (cached) return cached;

    const cookieMap = parseQqAuthCookie(auth);
    const res = await this.#client.musicu<RawQqSongInfoResponse>(
      buildQqSongDetailPayload(clean),
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
    if (auth.signal?.aborted) {
      throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
    }

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
      const data = await this.#client.requestJson<RawQqLyricResponse>({
        url: QQ_LYRIC_URL,
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
    } catch (error) {
      // PP-08: Never swallow AbortSignal / UPSTREAM_TIMEOUT / credential errors as empty lyrics
      if (
        auth.signal?.aborted ||
        (error instanceof AppError &&
          (error.code === "UPSTREAM_TIMEOUT" || error.code === "CREDENTIAL_INVALID")) ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
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
    const cookieMap = parseQqAuthCookie(auth);

    const data = await this.#client.requestJson<RawQqCommentsResponse>({
      url: QQ_COMMENT_LIST_URL,
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
    const cookieMap = requireQqAuthCookie(auth);
    const topId = await this.#resolveNumericSongId(songId, auth);
    const res = await this.#client.requestJson<RawQqCommentPraiseResponse>({
      url: QQ_COMMENT_PRAISE_URL,
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

  async getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    const safeLimit = Math.min(30, Math.max(1, limit));
    const cacheKey = `rec:${safeLimit}`;
    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#recommendedPlaylistsCache.get(scope, cacheKey);
    if (cached) return cached;

    const res = await this.#client.musicu<RawQqRecommendedPlaylistsResponse>(
      buildQqRecommendedPlaylistsPayload(safeLimit),
      cookieMap,
      auth.signal,
    );

    const playlists = mapQqRecommendedPlaylists(res.rec?.data?.grids ?? [], safeLimit);
    this.#recommendedPlaylistsCache.set(scope, cacheKey, playlists);
    return playlists;
  }

  async getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#chartsCache.get(scope, "charts");
    if (cached) return cached;

    const res = await this.#client.musicu<RawQqChartsResponse>(
      buildQqChartsPayload(),
      cookieMap,
      auth.signal,
    );

    const charts = mapQqCharts(res.charts?.data?.group ?? []);
    this.#chartsCache.set(scope, "charts", charts);
    return charts;
  }

  async getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    const topId = Number(chartId);
    if (!Number.isFinite(topId) || topId <= 0) {
      throw new AppError("VALIDATION_ERROR", "非法的 QQ 音乐榜单 ID。");
    }

    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#chartDetailCache.get(scope, String(topId));
    if (cached) return cached;

    const res = await this.#client.musicu<RawQqChartDetailResponse>(
      buildQqChartDetailPayload(topId),
      cookieMap,
      auth.signal,
    );

    const result = mapQqChartDetail(topId, res, { vipEnabled: auth.vipEnabled });
    this.#chartDetailCache.set(scope, String(topId), result);
    return result;
  }

  async getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    const singerMid = artistId.trim();
    if (!singerMid) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌手 ID。");
    }

    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#artistCache.get(scope, singerMid);
    if (cached) return cached;

    const res = await this.#client.musicu<RawQqArtistDetailResponse>(
      buildQqArtistDetailPayload(singerMid),
      cookieMap,
      auth.signal,
    );

    const result = mapQqArtistDetail(singerMid, res, { vipEnabled: auth.vipEnabled });
    if (!result) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐歌手信息。");
    }

    this.#artistCache.set(scope, singerMid, result);
    return result;
  }

  async getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    const albumMid = albumId.trim();
    if (!albumMid) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐专辑 ID。");
    }

    const cookieMap = parseQqAuthCookie(auth);
    const scope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#albumCache.get(scope, albumMid);
    if (cached) return cached;

    const res = await this.#client.musicu<RawQqAlbumDetailResponse>(
      buildQqAlbumDetailPayload(albumMid),
      cookieMap,
      auth.signal,
    );

    const result = mapQqAlbumDetail(albumMid, res, { vipEnabled: auth.vipEnabled });
    if (!result) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐专辑信息。");
    }

    this.#albumCache.set(scope, albumMid, result);
    return result;
  }

  async searchEntities(query: string, type: EntitySearchType, auth: ProviderAuthContext, limit = 20) {
    const keyword = query.trim();
    if (!keyword) return {};
    const safeLimit = Math.min(40, Math.max(1, limit));
    const cookieMap = parseQqAuthCookie(auth);

    const res = await this.#client.musicu<RawQqEntitySearchResponse>(
      buildQqEntitySearchPayload(keyword, type, safeLimit),
      cookieMap,
      auth.signal,
    );

    return mapQqEntitySearchResult(type, res);
  }
}
