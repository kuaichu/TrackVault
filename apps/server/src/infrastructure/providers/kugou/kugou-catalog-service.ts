import { parseLrc } from "#audio-tags";
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
import { parseKugouAuthCookie } from "./kugou-cookie.js";
import {
  KUGOU_EDITION_CONFIGS,
  decodeKrcContent,
  parseKrcLyrics,
  signKugouParamsKey,
} from "./kugou-crypto.js";
import type { KugouHttpClient } from "./kugou-http-client.js";
import {
  type RawKugouAlbumItem,
  type RawKugouArtistInfo,
  type RawKugouComment,
  type RawKugouEntityAuthor,
  type RawKugouEntitySpecial,
  type RawKugouKmrSong,
  type RawKugouRankItem,
  type RawKugouRecommendedPlaylist,
  type RawKugouSearchSong,
  mapKugouAlbumDetail,
  mapKugouArtistDetail,
  mapKugouChartDetail,
  mapKugouCharts,
  mapKugouComment,
  mapKugouKmrSong,
  mapKugouRecommendedPlaylists,
  mapKugouSearchAlbums,
  mapKugouSearchArtists,
  mapKugouSearchPlaylists,
  mapKugouSearchSong,
  parseKugouMediaId,
} from "./kugou-mapper.js";

const SONG_COMMENT_CODE = "fc4be23b4e972707f36b8a828a93ba8a";

export class KugouCatalogService {
  readonly #client: KugouHttpClient;
  readonly #discoverCache = new ScopedLruCache<Song[]>({ maxEntries: 20, defaultTtlMs: 5 * 60 * 1000 });
  readonly #chartsCache = new ScopedLruCache<ChartSummary[]>({
    maxEntries: 10,
    defaultTtlMs: 10 * 60 * 1000,
  });
  readonly #lyricsCache = new ScopedLruCache<SongLyrics>({
    maxEntries: 200,
    defaultTtlMs: 30 * 60 * 1000,
  });

  constructor(client: KugouHttpClient) {
    this.#client = client;
  }

  invalidateScope(scopeKey: string): void {
    this.#discoverCache.invalidateScope(scopeKey);
    this.#chartsCache.invalidateScope(scopeKey);
    this.#lyricsCache.invalidateScope(scopeKey);
  }

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";

    const res = await this.#client.request<{
      status?: number;
      data?: { lists?: RawKugouSearchSong[] };
    }>({
      path: "/v2/search/song",
      method: "GET",
      params: {
        keyword,
        page: 1,
        pagesize: Math.min(50, Math.max(1, limit)),
        platform: "AndroidFilter",
        iscorrection: 1,
        privilegefilter: 0,
        area_code: 1,
        dopicfull: 1,
        ...(isLite ? { clientver: 201 } : {}),
      },
      headers: { "x-router": "complexsearch.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    return (res.data?.lists ?? [])
      .map((item) => mapKugouSearchSong(item, { vipEnabled: auth.vipEnabled, isLite }))
      .filter((s): s is Song => s !== null)
      .slice(0, limit);
  }

  async searchEntities(
    query: string,
    type: EntitySearchType,
    auth: ProviderAuthContext,
    limit = 20,
  ): Promise<{
    artists?: ReturnType<typeof mapKugouSearchArtists>;
    albums?: ReturnType<typeof mapKugouSearchAlbums>;
    playlists?: ReturnType<typeof mapKugouSearchPlaylists>;
  }> {
    const keyword = query.trim();
    if (!keyword) return {};

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";
    const pagesize = Math.min(40, Math.max(1, limit));

    if (type === "artist") {
      const res = await this.#client.request<{ data?: { lists?: RawKugouEntityAuthor[] } }>({
        path: "/v1/search/author",
        method: "GET",
        params: {
          albumhide: 0,
          iscorrection: 1,
          keyword,
          nocollect: 0,
          page: 1,
          pagesize,
          platform: "AndroidFilter",
        },
        headers: { "x-router": "complexsearch.kugou.com" },
        cookieMap,
        edition,
        signal: auth.signal,
      });
      return { artists: mapKugouSearchArtists(res.data?.lists ?? []).slice(0, limit) };
    }

    if (type === "album") {
      const res = await this.#client.request<{ data?: { lists?: RawKugouAlbumItem[] } }>({
        path: "/v1/search/album",
        method: "GET",
        params: {
          keyword,
          page: 1,
          pagesize,
          platform: "AndroidFilter",
          iscorrection: 1,
          category: "1",
          sorttype: 0,
          searchsong: 0,
          ...(isLite ? { clientver: 201 } : {}),
        },
        headers: { "x-router": "complexsearch.kugou.com" },
        cookieMap,
        edition,
        signal: auth.signal,
      });
      return { albums: mapKugouSearchAlbums(res.data?.lists ?? []).slice(0, limit) };
    }

    const res = await this.#client.request<{ data?: { lists?: RawKugouEntitySpecial[] } }>({
      path: "/v1/search/special",
      method: "GET",
      params: {
        albumhide: 0,
        iscorrection: 1,
        keyword,
        nocollect: 0,
        page: 1,
        pagesize,
        platform: "AndroidFilter",
      },
      headers: { "x-router": "complexsearch.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });
    return { playlists: mapKugouSearchPlaylists(res.data?.lists ?? []).slice(0, limit) };
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";
    const cacheScope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cacheKey = `discover:${edition}:${auth.vipEnabled ?? "u"}`;
    const cached = this.#discoverCache.get(cacheScope, cacheKey);
    if (cached) return cached;

    const res = await this.#client.request<{
      status?: number;
      data?: { songlist?: RawKugouKmrSong[] };
    }>({
      path: "/openapi/kmr/v2/rank/audio",
      method: "POST",
      data: {
        show_portrait_mv: 1,
        show_type_total: 1,
        filter_original_remarks: 1,
        area_code: 1,
        pagesize: 30,
        rank_cid: 0,
        type: 1,
        page: 1,
        rank_id: 8888,
      },
      headers: { "kg-tid": "369" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const songs = (res.data?.songlist ?? [])
      .map((item) => mapKugouKmrSong(item, { vipEnabled: auth.vipEnabled, isLite }))
      .filter((s): s is Song => s !== null);

    if (songs.length > 0) {
      this.#discoverCache.set(cacheScope, cacheKey, songs);
    }
    return songs;
  }

  async getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const clienttime = String(Math.floor(Date.now() / 1000));

    const res = await this.#client.request<{
      status?: number;
      data?: {
        special_list?: RawKugouRecommendedPlaylist[];
        special_recommend?: RawKugouRecommendedPlaylist[];
        list?: RawKugouRecommendedPlaylist[];
      };
    }>({
      path: "/v2/special_recommend",
      method: "POST",
      data: {
        appid: conf.appid,
        mid: this.#client.deviceMid,
        clientver: conf.clientver,
        platform: "android",
        clienttime,
        userid: cookieMap?.userid ? Number(cookieMap.userid) : 0,
        module_id: 1,
        page: 1,
        pagesize: Math.max(10, limit),
        key: signKugouParamsKey(clienttime, edition),
        special_recommend: {
          withtag: 1,
          withsong: 1,
          sort: 1,
          ugc: 1,
          is_selected: 0,
          withrecommend: 1,
          area_code: 1,
          categoryid: 0,
        },
        req_multi: 1,
        retrun_min: 5,
        return_special_falg: 1,
      },
      headers: { "x-router": "specialrec.service.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const rawList = res.data?.special_list ?? res.data?.special_recommend ?? res.data?.list ?? [];
    return mapKugouRecommendedPlaylists(rawList, limit);
  }

  async getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const cacheScope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#chartsCache.get(cacheScope, "charts");
    if (cached) return cached;

    const res = await this.#client.request<{ data?: { info?: RawKugouRankItem[] } }>({
      path: "/ocean/v6/rank/list",
      method: "GET",
      params: { plat: 2, withsong: 1, parentid: 0 },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const charts = mapKugouCharts(res.data?.info ?? []);
    if (charts.length > 0) {
      this.#chartsCache.set(cacheScope, "charts", charts);
    }
    return charts;
  }

  async getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    const cleanId = chartId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "排行榜 ID 不能为空。");
    }

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";
    const numericId = Number(cleanId);
    const rankIdParam = Number.isFinite(numericId) ? numericId : cleanId;

    const [infoRes, songsRes] = await Promise.allSettled([
      this.#client.request<{ data?: RawKugouRankItem }>({
        path: "/ocean/v6/rank/info",
        method: "GET",
        params: { rank_cid: 0, rankid: rankIdParam, with_album_img: 1, zone: "" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
      this.#client.request<{ data?: { total?: number; songlist?: RawKugouKmrSong[] } }>({
        path: "/openapi/kmr/v2/rank/audio",
        method: "POST",
        data: {
          show_portrait_mv: 1,
          show_type_total: 1,
          filter_original_remarks: 1,
          area_code: 1,
          pagesize: 100,
          rank_cid: 0,
          type: 1,
          page: 1,
          rank_id: rankIdParam,
        },
        headers: { "kg-tid": "369" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
    ]);

    if (songsRes.status === "rejected") {
      throw songsRes.reason instanceof Error
        ? songsRes.reason
        : new AppError("UPSTREAM_ERROR", "获取酷狗排行榜曲目失败。");
    }

    const songs = (songsRes.value.data?.songlist ?? [])
      .map((item) => mapKugouKmrSong(item, { vipEnabled: auth.vipEnabled, isLite }))
      .filter((s): s is Song => s !== null);

    const info = infoRes.status === "fulfilled" ? infoRes.value.data : undefined;
    return mapKugouChartDetail(cleanId, info, songs, songsRes.value.data?.total);
  }

  async getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    const cleanId = artistId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "歌手 ID 不能为空。");
    }

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const clienttime = Math.floor(Date.now() / 1000);
    const idVal = /^\d+$/.test(cleanId) ? Number(cleanId) : cleanId;

    const [infoRes, songsRes, albumsRes] = await Promise.allSettled([
      this.#client.request<{ data?: RawKugouArtistInfo }>({
        path: "/kmr/v3/author",
        method: "POST",
        data: { author_id: idVal },
        headers: { "x-router": "openapi.kugou.com", "kg-tid": "36" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
      this.#client.request<{ data?: RawKugouKmrSong[] }>({
        baseUrl: "https://openapi.kugou.com",
        path: "/kmr/v1/audio_group/author",
        method: "POST",
        data: {
          appid: conf.appid,
          clientver: conf.clientver,
          mid: this.#client.deviceMid,
          clienttime,
          key: signKugouParamsKey(clienttime, edition),
          author_id: idVal,
          pagesize: 50,
          page: 1,
          sort: 1,
          area_code: "all",
        },
        headers: { "x-router": "openapi.kugou.com", "kg-tid": "220" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
      this.#client.request<{ data?: RawKugouAlbumItem[] }>({
        path: "/kmr/v1/author/albums",
        method: "POST",
        data: {
          author_id: idVal,
          pagesize: 30,
          page: 1,
          sort: 3,
          category: 1,
          area_code: "all",
        },
        headers: { "x-router": "openapi.kugou.com", "kg-tid": "36" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
    ]);

    const hotSongs =
      songsRes.status === "fulfilled"
        ? (songsRes.value.data ?? [])
            .map((item) => mapKugouKmrSong(item, { vipEnabled: auth.vipEnabled, isLite }))
            .filter((s): s is Song => s !== null)
        : [];
    const albums = albumsRes.status === "fulfilled" ? (albumsRes.value.data ?? []) : [];
    const info = infoRes.status === "fulfilled" ? infoRes.value.data : undefined;

    const detail = mapKugouArtistDetail(cleanId, info, hotSongs, albums);
    if (!detail) {
      throw new AppError("NOT_FOUND", "未找到该酷狗歌手详情。");
    }
    return detail;
  }

  async getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    const cleanId = albumId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "专辑 ID 不能为空。");
    }

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";
    const idVal = /^\d+$/.test(cleanId) ? Number(cleanId) : cleanId;

    const [infoRes, songsRes] = await Promise.allSettled([
      this.#client.request<{ data?: RawKugouAlbumItem[] }>({
        path: "/kmr/v2/albums",
        method: "POST",
        data: {
          data: [{ album_id: idVal }],
          is_buy: 0,
          fields:
            "album_id,album_name,publish_date,sizable_cover,intro,language,is_publish,heat,type,quality,authors,exclusive,author_name,trans_param",
        },
        headers: { "x-router": "openapi.kugou.com", "kg-tid": "255" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
      this.#client.request<{ data?: { total?: number; songs?: RawKugouKmrSong[] } }>({
        path: "/v1/album_audio/lite",
        method: "POST",
        data: { album_id: idVal, is_buy: "", page: 1, pagesize: 100 },
        headers: { "x-router": "openapi.kugou.com", "kg-tid": "255" },
        cookieMap,
        edition,
        signal: auth.signal,
      }),
    ]);

    const songs =
      songsRes.status === "fulfilled"
        ? (songsRes.value.data?.songs ?? [])
            .map((item) => mapKugouKmrSong(item, { vipEnabled: auth.vipEnabled, isLite }))
            .filter((s): s is Song => s !== null)
        : [];
    const info = infoRes.status === "fulfilled" ? infoRes.value.data?.[0] : undefined;
    const total = songsRes.status === "fulfilled" ? songsRes.value.data?.total : undefined;

    const detail = mapKugouAlbumDetail(cleanId, info, songs, total);
    if (!detail) {
      throw new AppError("NOT_FOUND", "未找到该酷狗专辑详情。");
    }
    return detail;
  }

  async getLyrics(
    songId: string,
    mediaId: string | undefined,
    auth: ProviderAuthContext,
  ): Promise<SongLyrics> {
    const cleanHash = songId.trim().toUpperCase();
    const cached = this.#lyricsCache.get("public", cleanHash);
    if (cached) return cached;

    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const { mixSongId } = parseKugouMediaId(mediaId);

    const searchRes = await this.#client.request<{
      candidates?: Array<{ id?: string | number; accesskey?: string }>;
    }>({
      baseUrl: "https://lyrics.kugou.com",
      path: "/v1/search",
      method: "GET",
      params: {
        album_audio_id: mixSongId,
        appid: conf.appid,
        clientver: conf.clientver,
        duration: 0,
        hash: cleanHash,
        keyword: "",
        lrctxt: 1,
        man: "no",
      },
      clearDefaultParams: true,
      edition,
      signal: auth.signal,
    });

    const candidate = searchRes.candidates?.[0];
    if (!candidate?.id || !candidate.accesskey) {
      return { songId, platform: "kugou", lines: [], source: "none" };
    }

    // Prefer KRC (carries bilingual translation layer); fall back to LRC if needed
    const dlKrc = await this.#client.request<{ content?: string; contenttype?: number }>({
      baseUrl: "https://lyrics.kugou.com",
      path: "/download",
      method: "GET",
      params: {
        ver: 1,
        client: "android",
        id: String(candidate.id),
        accesskey: candidate.accesskey,
        fmt: "krc",
        charset: "utf8",
      },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    if (dlKrc.content) {
      const lines =
        Number(dlKrc.contenttype ?? 0) === 0
          ? parseKrcLyrics(decodeKrcContent(dlKrc.content))
          : parseLrc(Buffer.from(dlKrc.content, "base64").toString("utf8"));
      if (lines.length > 0) {
        const result: SongLyrics = { songId, platform: "kugou", lines, source: "kugou" };
        this.#lyricsCache.set("public", cleanHash, result);
        return result;
      }
    }

    const dlLrc = await this.#client.request<{ content?: string }>({
      baseUrl: "https://lyrics.kugou.com",
      path: "/download",
      method: "GET",
      params: {
        ver: 1,
        client: "android",
        id: String(candidate.id),
        accesskey: candidate.accesskey,
        fmt: "lrc",
        charset: "utf8",
      },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const lrcLines = dlLrc.content ? parseLrc(Buffer.from(dlLrc.content, "base64").toString("utf8")) : [];
    const result: SongLyrics = {
      songId,
      platform: "kugou",
      lines: lrcLines,
      source: lrcLines.length > 0 ? "kugou" : "none",
    };
    if (lrcLines.length > 0) {
      this.#lyricsCache.set("public", cleanHash, result);
    }
    return result;
  }

  async #resolveMixSongIdFromHash(hash: string, auth: ProviderAuthContext): Promise<string | null> {
    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];

    const res = await this.#client.request<{
      data?: Array<{ album_audio_id?: number | string }>;
    }>({
      path: "/v2/get_res_privilege/lite",
      method: "POST",
      data: {
        appid: conf.appid,
        area_code: 1,
        behavior: "play",
        clientver: conf.clientver,
        need_hash_offset: 1,
        relate: 1,
        support_verify: 1,
        resource: [{ type: "audio", page_id: 0, hash: hash.toLowerCase(), album_id: 0 }],
        qualities: ["128"],
      },
      headers: { "x-router": "media.store.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const mixId = res.data?.[0]?.album_audio_id;
    return mixId && String(mixId) !== "0" ? String(mixId) : null;
  }

  async getComments(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage> {
    const cleanId = songId.trim();
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(50, Math.max(5, Math.floor(limit)));
    const cookieMap = parseKugouAuthCookie(auth);
    const edition = cookieMap?.kg_edition ?? "lite";

    let mixSongId = /^\d+$/.test(cleanId) ? cleanId : null;
    if (!mixSongId && /^[0-9a-fA-F]{32}$/.test(cleanId)) {
      mixSongId = await this.#resolveMixSongIdFromHash(cleanId, auth);
    }
    if (!mixSongId) {
      return {
        songId,
        platform: "kugou",
        total: 0,
        page: safePage,
        limit: safeLimit,
        hasMore: false,
        hotComments: [],
        comments: [],
      };
    }

    const res = await this.#client.request<{
      count?: number;
      weight_list?: RawKugouComment[];
      list?: RawKugouComment[];
    }>({
      path: "/mcomment/v1/cmtlist",
      method: "POST",
      params: {
        ver: 6,
        mixsongid: mixSongId,
        need_show_image: 1,
        p: safePage,
        pagesize: safeLimit,
        show_classify: 1,
        show_hotword_list: 1,
        extdata: "0",
        code: SONG_COMMENT_CODE,
      },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const total = Math.max(0, Number(res.count ?? 0) || 0);
    const hotComments =
      safePage === 1
        ? (res.weight_list ?? []).map(mapKugouComment).filter((c): c is NonNullable<typeof c> => c !== null)
        : [];
    const comments = (res.list ?? [])
      .map(mapKugouComment)
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return {
      songId,
      platform: "kugou",
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: safePage * safeLimit < total && comments.length > 0,
      hotComments,
      comments,
    };
  }
}
