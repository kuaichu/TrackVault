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
  type PlaylistSummary,
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
  PlaylistTrackQuery,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { resolveProviderCacheScope } from "../common/cache-scope.js";
import {
  type RawNeteaseComment,
  type RawNeteasePlaylist,
  type RawNeteasePrivilege,
  type RawNeteaseSong,
  mapNeteaseComment,
  mapNeteasePlaylist,
  mapNeteaseSong,
} from "./netease-mapper.js";
import {
  type NeteaseRpcClient,
  getNeteaseErrorCode,
  isNeteaseCancellationError,
} from "./netease-rpc-client.js";

const MAX_CLOUD_PAGES = 20;

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

export class NeteaseCatalogService {
  readonly #rpc: NeteaseRpcClient;
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
  readonly #lyricCache = new ScopedLruCache<SongLyrics>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });

  constructor(rpc: NeteaseRpcClient) {
    this.#rpc = rpc;
  }

  invalidateScope(scopeKey: string): void {
    this.#discoverCache.invalidateScope(scopeKey);
    this.#recommendedPlaylistsCache.invalidateScope(scopeKey);
    this.#artistCache.invalidateScope(scopeKey);
    this.#albumCache.invalidateScope(scopeKey);
  }

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 30): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const safeLimit = Math.min(50, Math.max(1, limit));

    try {
      const response = await this.#rpc.call(
        () =>
          this.#rpc.api.cloudsearch(
            this.#rpc.baseParams(auth, { keywords: keyword, type: 1, limit: safeLimit, offset: 0 }),
          ),
        auth.signal,
      );
      const result = response.body.result as { songs?: RawNeteaseSong[] } | undefined;
      const rawSongs = (result?.songs ?? []).slice(0, safeLimit);
      return this.#rpc.hydrateAndMapNeteaseSongs(rawSongs, auth);
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "网易云搜索失败");
    }
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const scope = resolveProviderCacheScope(auth);
    const cached = this.#discoverCache.get(scope, "discover");
    if (cached) return cached;

    const scopeEpoch = this.#discoverCache.getEpoch(scope);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.personalized_newsong(this.#rpc.baseParams(auth, { limit: 30 })),
        auth.signal,
      );
      const items = (response.body.result as Array<{ id?: number; song?: RawNeteaseSong }> | undefined) ?? [];
      const ids = items.map((item) => String(item.song?.id ?? item.id ?? "")).filter(Boolean);
      if (ids.length === 0) return [];

      const detail = await this.#rpc.call(
        () => this.#rpc.api.song_detail(this.#rpc.baseParams(auth, { ids: ids.join(",") })),
        auth.signal,
      );
      const rawSongs = (detail.body.songs as RawNeteaseSong[] | undefined) ?? [];
      const privileges = (detail.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
      const songs = await this.#rpc.hydrateAndMapNeteaseSongs(rawSongs, auth, { privileges });

      this.#discoverCache.setIfEpoch(scope, "discover", songs, scopeEpoch);
      return songs;
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云发现音乐失败");
    }
  }

  async getDailyRecommendTracks(auth: ProviderAuthContext): Promise<Song[]> {
    this.#rpc.assertAuthed(auth);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.recommend_songs(this.#rpc.baseParams(auth)),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "获取每日推荐失败");
      const data = response.body.data as
        | { dailySongs?: RawNeteaseSong[]; privileges?: RawNeteasePrivilege[] }
        | undefined;
      const privileges =
        data?.privileges ?? (response.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
      return this.#rpc.hydrateAndMapNeteaseSongs(data?.dailySongs ?? [], auth, { privileges });
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取每日推荐失败");
    }
  }

  async getPersonalFm(auth: ProviderAuthContext): Promise<Song[]> {
    this.#rpc.assertAuthed(auth);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.personal_fm(this.#rpc.baseParams(auth, { timestamp: Date.now() })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "获取私人 FM 失败");
      const raw = (response.body.data as RawNeteaseSong[] | undefined) ?? [];
      return this.#rpc.hydrateAndMapNeteaseSongs(raw, auth);
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取私人 FM 失败");
    }
  }

  async getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    const safeLimit = Math.min(30, Math.max(1, limit));
    const cacheKey = `rec:${safeLimit}`;
    const scope = resolveProviderCacheScope(auth);
    const cached = this.#recommendedPlaylistsCache.get(scope, cacheKey);
    if (cached) return cached;

    const scopeEpoch = this.#recommendedPlaylistsCache.getEpoch(scope);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.personalized(this.#rpc.baseParams(auth, { limit: safeLimit })),
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

      this.#recommendedPlaylistsCache.setIfEpoch(scope, cacheKey, playlists, scopeEpoch);
      return playlists;
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取推荐歌单失败");
    }
  }

  async getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    const cached = this.#chartsCache.get("public", "charts");
    if (cached) return cached;

    try {
      // Public endpoint: strip user private cookies before populating shared "public" cache
      const response = await this.#rpc.call(
        () => this.#rpc.api.toplist(this.#rpc.baseParams(undefined, {}, auth.signal)),
        auth.signal,
      );
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
      throw this.#rpc.wrapUpstreamError(error, "获取网易云排行榜失败");
    }
  }

  async getChartDetail(
    chartId: string,
    auth: ProviderAuthContext,
    getPlaylistTracks: (
      id: string,
      q: PlaylistTrackQuery,
      a: ProviderAuthContext,
    ) => Promise<{
      playlist: PlaylistSummary;
      songs: Song[];
      total: number;
    }>,
  ): Promise<ChartDetail> {
    const page = await getPlaylistTracks(chartId, { page: 1, limit: 100, sort: "default" }, auth);
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

  async getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    const cleanId = artistId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少歌手 ID。");
    }

    const scope = resolveProviderCacheScope(auth);
    const cached = this.#artistCache.get(scope, cleanId);
    if (cached) return cached;

    const scopeEpoch = this.#artistCache.getEpoch(scope);
    try {
      const [artistRes, albumsRes, detailRes] = await Promise.allSettled([
        this.#rpc.call(() => this.#rpc.api.artists(this.#rpc.baseParams(auth, { id: cleanId })), auth.signal),
        this.#rpc.call(
          () => this.#rpc.api.artist_album(this.#rpc.baseParams(auth, { id: cleanId, limit: 30, offset: 0 })),
          auth.signal,
        ),
        this.#rpc.call(
          () => this.#rpc.api.artist_detail(this.#rpc.baseParams(auth, { id: cleanId })),
          auth.signal,
        ),
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

      // PP-08: Hydrate missing per-account privileges for artist hot songs
      const hotSongs = await this.#rpc.hydrateAndMapNeteaseSongs(body.hotSongs ?? [], auth);

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

      this.#artistCache.setIfEpoch(scope, cleanId, result, scopeEpoch);
      return result;
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云歌手详情失败");
    }
  }

  async getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    const cleanId = albumId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少专辑 ID。");
    }

    const scope = resolveProviderCacheScope(auth);
    const cached = this.#albumCache.get(scope, cleanId);
    if (cached) return cached;

    const scopeEpoch = this.#albumCache.getEpoch(scope);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.album(this.#rpc.baseParams(auth, { id: cleanId })),
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

      const songs = await this.#rpc.hydrateAndMapNeteaseSongs(body.songs ?? [], auth, {
        privileges: body.privileges,
      });

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

      this.#albumCache.setIfEpoch(scope, cleanId, result, scopeEpoch);
      return result;
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云专辑详情失败");
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
      const response = await this.#rpc.call(
        () =>
          this.#rpc.api.cloudsearch(
            this.#rpc.baseParams(auth, { keywords: keyword, type: typeCode, limit: safeLimit, offset: 0 }),
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
      throw this.#rpc.wrapUpstreamError(error, "网易云检索失败");
    }
  }

  async getCloudTracksPage(
    auth: ProviderAuthContext,
    options?: { offset?: number; limit?: number },
  ): Promise<CloudTracksPage> {
    this.#rpc.assertAuthed(auth);
    const safeOffset = Math.max(0, Math.floor(options?.offset ?? 0) || 0);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 100) || 100));

    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.user_cloud(this.#rpc.baseParams(auth, { limit: safeLimit, offset: safeOffset })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "获取网易云云盘歌曲失败");

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
      throw this.#rpc.wrapUpstreamError(error, "获取网易云云盘歌曲失败");
    }
  }

  async getCloudTracks(auth: ProviderAuthContext): Promise<Song[]> {
    this.#rpc.assertAuthed(auth);
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

  async getLyrics(
    songId: string,
    _mediaId: string | undefined,
    auth: ProviderAuthContext,
  ): Promise<SongLyrics> {
    if (auth.signal?.aborted) {
      throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
    }

    const cached = this.#lyricCache.get("public", songId);
    if (cached) return cached;

    const tryEndpoint = async (kind: "netease_new" | "netease_legacy") => {
      const fn = kind === "netease_new" ? this.#rpc.api.lyric_new : this.#rpc.api.lyric;
      const response = await this.#rpc.call(
        () => fn(this.#rpc.baseParams(undefined, { id: songId }, auth.signal)),
        auth.signal,
      );
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
        const legacy = await tryEndpoint("netease_legacy").catch((err) => {
          if (isNeteaseCancellationError(err)) throw err;
          return null;
        });
        if (legacy && legacy.lines.length > 0) {
          result = legacy;
        }
      }
    } catch (error) {
      if (isNeteaseCancellationError(error)) throw error;
      try {
        result = await tryEndpoint("netease_legacy");
        succeeded = true;
      } catch (legacyErr) {
        if (isNeteaseCancellationError(legacyErr)) throw legacyErr;
        result = {
          songId,
          platform: "netease" as const,
          lines: [],
          source: "none" as const,
        };
      }
    }

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
      const response = await this.#rpc.call(
        () =>
          this.#rpc.api.comment_music(
            this.#rpc.baseParams(auth, { id: songId, limit: safeLimit, offset: (safePage - 1) * safeLimit }),
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
      throw this.#rpc.wrapUpstreamError(error, "获取网易云评论失败");
    }
  }

  async setCommentLiked(
    songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    this.#rpc.assertAuthed(auth);
    try {
      const response = await this.#rpc.call(
        () =>
          this.#rpc.api.comment_like(
            this.#rpc.baseParams(auth, { id: songId, cid: commentId, t: liked ? 1 : 0, type: 0 }),
          ),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "评论点赞失败");
      return { liked };
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "评论点赞操作失败");
    }
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    this.#rpc.assertAuthed(auth);
    const order = buildDownwardQualityOrder(level, target.availableLevels);
    const apiFn = mode === "download" ? this.#rpc.api.song_download_url_v1 : this.#rpc.api.song_url_v1;
    let lastUpstreamError: AppError | null = null;
    let sawEmptyUrl = false;
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
          const response = await this.#rpc.call(
            () => apiFn(this.#rpc.baseParams(auth, variantParams)),
            auth.signal,
          );
          const bodyCode =
            response.body.code !== undefined && response.body.code !== null
              ? Number(response.body.code)
              : 200;
          if (bodyCode === 301 || bodyCode === 401) {
            throw new AppError(
              "CREDENTIAL_INVALID",
              this.#rpc.wrapUpstreamError({ body: response.body }, "网易云音乐登录态已失效，请重新绑定。")
                .message,
            );
          }

          const rawData = response.body.data;
          const item = (Array.isArray(rawData) ? rawData[0] : rawData) as
            | {
                code?: number | string | null;
                url?: string | null;
                type?: string | null;
                br?: number | string | null;
                level?: string | null;
                time?: number | null;
                freeTrialInfo?: { start?: number; end?: number } | null;
              }
            | undefined;

          const itemCode = item?.code !== undefined && item.code !== null ? Number(item.code) : 200;
          if (itemCode === 301 || itemCode === 401) {
            throw new AppError("CREDENTIAL_INVALID", "网易云音乐登录态已失效，请重新绑定。");
          }

          if (!item?.url) {
            sawEmptyUrl = true;
            continue;
          }

          const format = (item.type ?? "mp3").replace(/^\./, "").toLowerCase();
          const bitrate = Number(item.br ?? 0) > 0 ? Number(item.br) : null;
          const durationSeconds =
            item.time && Number(item.time) > 0 ? Math.round(Number(item.time) / 1000) : null;
          const hasTrialFlag = Boolean(item.freeTrialInfo && Number(item.freeTrialInfo.end ?? 0) > 0);
          const trial = isTrialDuration(target.durationSeconds, durationSeconds, hasTrialFlag);
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

          if (trial) {
            if (!firstTrialFallback) {
              firstTrialFallback = candidate;
            }
            continue;
          }

          return candidate;
        } catch (error) {
          if (
            error instanceof AppError &&
            (error.code === "CREDENTIAL_INVALID" ||
              error.code === "CREDENTIAL_REQUIRED" ||
              error.code === "UPSTREAM_TIMEOUT")
          ) {
            throw error;
          }
          if (isNeteaseCancellationError(error)) {
            throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。", { cause: error });
          }
          const rawErrCode = getNeteaseErrorCode(error);
          if (rawErrCode === 301 || rawErrCode === 401) {
            throw this.#rpc.wrapUpstreamError(error, "网易云音乐登录态已失效，请重新绑定。");
          }
          lastUpstreamError = this.#rpc.wrapUpstreamError(error, "解析网易云音源失败");
        }
      }
    }

    if (firstTrialFallback) return firstTrialFallback;
    if (lastUpstreamError) throw lastUpstreamError;
    if (sawEmptyUrl) {
      throw new AppError("COPYRIGHT_UNAVAILABLE", "网易云未返回该音质的可用音频链接。");
    }
    throw new AppError("UPSTREAM_ERROR", "未能获取到可用的网易云音频流。");
  }
}
