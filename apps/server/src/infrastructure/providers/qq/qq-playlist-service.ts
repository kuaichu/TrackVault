import type { PlaylistSummary, PlaylistTracksPage, Song } from "#shared";
import { AppError } from "../../../domain/errors.js";
import { sortAndFilterSongs } from "../../../domain/policies/playlist-query-policy.js";
import type { PlaylistTrackQuery, ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { resolveProviderCacheScope } from "../common/cache-scope.js";
import {
  QQ_COLLECTED_PLAYLISTS_URL,
  QQ_CREATED_PLAYLISTS_URL,
  QQ_LYRIC_CID,
  QQ_PLAYLIST_DETAIL_URL,
  type RawQqCollectedPlaylistsResponse,
  type RawQqCreatedPlaylistsResponse,
  type RawQqPlaylistDetailResponse,
  isQqAuthInvalidCode,
} from "./qq-cgi-endpoints.js";
import { computeQqGtk, parseQqAuthCookie, requireQqAuthCookie } from "./qq-cookie.js";
import type { QqMusicHttpClient } from "./qq-http-client.js";
import { type RawQqPlaylist, mapQqPlaylist, mapQqPlaylistDetail } from "./qq-mapper.js";

export class QqPlaylistService {
  readonly #client: QqMusicHttpClient;
  readonly #playlistCache = new ScopedLruCache<{ playlist: PlaylistSummary; songs: Song[] }>({
    maxEntries: 80,
    defaultTtlMs: 2 * 60 * 1000,
  });

  constructor(client: QqMusicHttpClient) {
    this.#client = client;
  }

  invalidateScope(scopeKey: string): void {
    this.#playlistCache.invalidateScope(scopeKey);
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const cookieMap = requireQqAuthCookie(auth);
    const gtk = computeQqGtk(cookieMap);

    const fetchCollectedPlaylists = async (): Promise<{
      code?: number;
      items: RawQqPlaylist[];
    }> => {
      const items: RawQqPlaylist[] = [];
      const pageSize = 50;
      for (let page = 0; page < 10; page += 1) {
        const sin = page * pageSize;
        const res = await this.#client.requestJson<RawQqCollectedPlaylistsResponse>({
          url: QQ_COLLECTED_PLAYLISTS_URL,
          query: {
            ct: 20,
            cid: QQ_LYRIC_CID,
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
        if (isQqAuthInvalidCode(res.code)) {
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
      this.#client.requestJson<RawQqCreatedPlaylistsResponse>({
        url: QQ_CREATED_PLAYLISTS_URL,
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

    if (
      createdRes.status === "rejected" &&
      createdRes.reason instanceof AppError &&
      createdRes.reason.code === "CREDENTIAL_INVALID"
    ) {
      throw createdRes.reason;
    }
    if (createdRes.status === "fulfilled" && isQqAuthInvalidCode(createdRes.value.code)) {
      throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
    }
    if (
      collectedRes.status === "rejected" &&
      collectedRes.reason instanceof AppError &&
      collectedRes.reason.code === "CREDENTIAL_INVALID"
    ) {
      throw collectedRes.reason;
    }
    if (collectedRes.status === "fulfilled" && isQqAuthInvalidCode(collectedRes.value.code)) {
      throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
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

    const cookieMap = parseQqAuthCookie(auth);
    const cacheScope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#playlistCache.get(cacheScope, cleanId);
    if (cached) return cached;

    const data = await this.#client.requestJson<RawQqPlaylistDetailResponse>({
      url: QQ_PLAYLIST_DETAIL_URL,
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

    if (isQqAuthInvalidCode(data.code)) {
      throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
    }
    if (data.code !== undefined && data.code !== 0) {
      throw new AppError("UPSTREAM_ERROR", `获取 QQ 音乐歌单详情失败 (code ${data.code})。`);
    }

    const cd = data.cdlist?.[0];
    if (!cd) {
      throw new AppError("NOT_FOUND", "未找到该 QQ 音乐歌单或无访问权限。");
    }

    const bundle = mapQqPlaylistDetail(cleanId, cd, {
      currentUin: cookieMap?.uin,
      vipEnabled: auth.vipEnabled,
    });
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
}
