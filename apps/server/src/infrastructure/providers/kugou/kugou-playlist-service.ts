import { type PlaylistSummary, type PlaylistTracksPage, type Song, normalizeCoverUrl } from "#shared";
import { AppError } from "../../../domain/errors.js";
import { sortAndFilterSongs } from "../../../domain/policies/playlist-query-policy.js";
import type {
  CreatePlaylistResult,
  PlaylistTrackQuery,
  ProviderAuthContext,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { resolveProviderCacheScope } from "../common/cache-scope.js";
import { type KugouCookieMap, parseKugouAuthCookie, requireKugouAuthCookie } from "./kugou-cookie.js";
import { KUGOU_EDITION_CONFIGS } from "./kugou-crypto.js";
import type { KugouHttpClient } from "./kugou-http-client.js";
import { type RawKugouPlaylistSong, mapKugouPlaylistSong } from "./kugou-mapper.js";

const MAX_SCAN_TRACKS = 10_000;
const PUBSONGS_PAGE_SIZE = 100;

interface RawKugouUserPlaylistItem {
  global_collection_id?: string;
  list_create_gid?: string;
  listid?: number | string;
  list_create_userid?: number | string;
  list_create_username?: string;
  name?: string;
  count?: number;
  pic?: string;
  intro?: string;
  is_def?: number;
}

interface RawKugouPublicListInfo {
  global_collection_id?: string;
  listid?: number | string;
  list_create_userid?: number | string;
  list_create_username?: string;
  name?: string;
  count?: number;
  pic?: string;
  intro?: string;
}

interface CachedPlaylistMeta {
  summary: PlaylistSummary;
  listid?: number;
}

export class KugouPlaylistService {
  readonly #client: KugouHttpClient;
  readonly #metaCache = new ScopedLruCache<CachedPlaylistMeta>({
    maxEntries: 100,
    defaultTtlMs: 2 * 60 * 1000,
  });

  constructor(client: KugouHttpClient) {
    this.#client = client;
  }

  invalidateScope(scopeKey: string): void {
    this.#metaCache.invalidateScope(scopeKey);
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const cookieMap = requireKugouAuthCookie(auth);
    const edition = cookieMap.kg_edition;
    const uid = cookieMap.userid;

    const res = await this.#client.request<{
      status?: number;
      error_code?: number;
      data?: { info?: RawKugouUserPlaylistItem[] };
    }>({
      path: "/v7/get_all_list",
      method: "POST",
      params: { plat: 1, userid: Number(uid), token: cookieMap.token },
      data: {
        userid: uid,
        token: cookieMap.token,
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 100,
      },
      headers: { "x-router": "cloudlist.service.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    if (res.status === 0) {
      throw new AppError("UPSTREAM_ERROR", `获取酷狗歌单列表失败 (code ${res.error_code ?? "unknown"})。`);
    }

    const out: PlaylistSummary[] = [];
    const seen = new Set<string>();
    for (const item of res.data?.info ?? []) {
      const name = item.name?.trim() ?? "";
      // Skip internal system/history pseudo-lists (`默认收藏` / `我喜欢` has is_def === 2, history/local have is_def === 1)
      if (!name || item.is_def === 1) continue;
      const gid = (item.global_collection_id || item.list_create_gid || "").trim();
      const rawListId = item.listid !== undefined ? String(item.listid).trim() : "";
      const id = gid || (rawListId ? `listid_${rawListId}` : "");
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const creatorUid = item.list_create_userid !== undefined ? String(item.list_create_userid).trim() : "";
      const owned = !creatorUid || creatorUid === uid || item.is_def === 2;
      const summary: PlaylistSummary = {
        id,
        platform: "kugou",
        name,
        coverUrl: normalizeCoverUrl(item.pic, 300),
        trackCount: Math.max(0, Number(item.count ?? 0) || 0),
        creatorName: item.list_create_username?.trim() || (owned ? `酷狗 ${uid}` : "酷狗用户"),
        owned,
        description: item.intro?.trim() || undefined,
      };
      out.push(summary);

      const numericListId = Number(rawListId);
      this.#metaCache.set(auth.scopeKey, id, {
        summary,
        ...(Number.isFinite(numericListId) && numericListId > 0 ? { listid: numericListId } : {}),
      });
    }

    return out;
  }

  async #resolvePlaylistMeta(
    playlistId: string,
    cookieMap: KugouCookieMap | null,
    auth: ProviderAuthContext,
  ): Promise<CachedPlaylistMeta> {
    const cleanId = playlistId.trim();
    const cacheScope = resolveProviderCacheScope(auth, Boolean(cookieMap));
    const cached = this.#metaCache.get(cacheScope, cleanId);
    if (cached) return cached;

    if (cleanId.startsWith("listid_") || /^\d+$/.test(cleanId)) {
      const listid = Number(cleanId.replace(/^listid_/, ""));
      if (cookieMap) {
        await this.getUserPlaylists(auth).catch(() => undefined);
        const afterSync = this.#metaCache.get(auth.scopeKey, cleanId);
        if (afterSync) return afterSync;
      }
      const fallback: CachedPlaylistMeta = {
        summary: {
          id: cleanId,
          platform: "kugou",
          name: `酷狗歌单 ${listid || cleanId}`,
          trackCount: 0,
          creatorName: cookieMap ? `酷狗 ${cookieMap.userid}` : "酷狗用户",
          owned: Boolean(cookieMap),
        },
        ...(Number.isFinite(listid) && listid > 0 ? { listid } : {}),
      };
      return fallback;
    }

    const edition = cookieMap?.kg_edition ?? "lite";
    const infoRes = await this.#client.request<{ data?: RawKugouPublicListInfo[] }>({
      path: "/v3/get_list_info",
      method: "POST",
      data: {
        data: [{ global_collection_id: cleanId }],
        userid: cookieMap?.userid ? Number(cookieMap.userid) : 0,
        token: cookieMap?.token ?? "",
      },
      headers: { "x-router": "pubsongs.kugou.com" },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const info = infoRes.data?.[0];
    const creatorUid = info?.list_create_userid !== undefined ? String(info.list_create_userid) : "";
    const owned = Boolean(cookieMap?.userid && creatorUid && cookieMap.userid === creatorUid);
    const listidNum = Number(info?.listid ?? 0);

    const meta: CachedPlaylistMeta = {
      summary: {
        id: cleanId,
        platform: "kugou",
        name: info?.name?.trim() || `酷狗歌单 ${cleanId.slice(0, 12)}`,
        coverUrl: normalizeCoverUrl(info?.pic, 400),
        trackCount: Math.max(0, Number(info?.count ?? 0) || 0),
        creatorName: info?.list_create_username?.trim() || "酷狗用户",
        owned,
        description: info?.intro?.trim() || undefined,
      },
      ...(owned && Number.isFinite(listidNum) && listidNum > 0 ? { listid: listidNum } : {}),
    };
    this.#metaCache.set(cacheScope, cleanId, meta);
    return meta;
  }

  async #fetchPlaylistSongsSlice(
    playlistId: string,
    meta: CachedPlaylistMeta,
    beginIdx: number,
    pageSize: number,
    cookieMap: KugouCookieMap | null,
    auth: ProviderAuthContext,
  ): Promise<{ total: number; songs: Song[]; rawItems: RawKugouPlaylistSong[] }> {
    const cleanId = playlistId.trim();
    const edition = cookieMap?.kg_edition ?? "lite";
    const isLite = edition === "lite";

    if ((cleanId.startsWith("listid_") || /^\d+$/.test(cleanId)) && meta.listid && cookieMap) {
      const page = Math.floor(beginIdx / pageSize) + 1;
      const res = await this.#client.request<{
        data?: { count?: number; info?: RawKugouPlaylistSong[]; songs?: RawKugouPlaylistSong[] };
      }>({
        path: "/v4/get_list_all_file_v3",
        method: "POST",
        data: {
          listid: meta.listid,
          userid: cookieMap.userid,
          type: 0,
          page,
          pagesize: pageSize,
          area_code: 1,
          allplatform: 1,
          show_cover: 1,
          token: cookieMap.token,
        },
        headers: { "x-router": "cloudlist.service.kugou.com" },
        cookieMap,
        edition,
        signal: auth.signal,
      });

      const rawItems = res.data?.songs ?? res.data?.info ?? [];
      const songs = rawItems
        .map((item) => mapKugouPlaylistSong(item, { vipEnabled: auth.vipEnabled, isLite }))
        .filter((s): s is Song => s !== null);
      const total = Math.max(songs.length, Number(res.data?.count ?? meta.summary.trackCount) || 0);
      return { total, songs, rawItems };
    }

    const res = await this.#client.request<{
      data?: { count?: number; songs?: RawKugouPlaylistSong[]; info?: RawKugouPlaylistSong[] };
    }>({
      path: "/pubsongs/v2/get_other_list_file_nofilt",
      method: "GET",
      params: {
        area_code: 1,
        begin_idx: beginIdx,
        plat: 1,
        type: 1,
        mode: 1,
        personal_switch: 1,
        extend_fields: "abtags,hot_cmt,popularization",
        pagesize: pageSize,
        global_collection_id: cleanId,
      },
      cookieMap,
      edition,
      signal: auth.signal,
    });

    const rawItems = res.data?.songs ?? res.data?.info ?? [];
    const songs = rawItems
      .map((item) => mapKugouPlaylistSong(item, { vipEnabled: auth.vipEnabled, isLite }))
      .filter((s): s is Song => s !== null);
    const total = Math.max(songs.length, Number(res.data?.count ?? meta.summary.trackCount) || 0);
    return { total, songs, rawItems };
  }

  async getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    const cleanId = playlistId.trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "歌单 ID 不能为空。");
    }

    const cookieMap = parseKugouAuthCookie(auth);
    const meta = await this.#resolvePlaylistMeta(cleanId, cookieMap, auth);
    const page = Math.max(1, Math.floor(query.page));
    const limit = Math.min(200, Math.max(1, Math.floor(query.limit)));
    const keyword = query.keyword?.trim() ?? "";
    const sort = query.sort ?? "default";

    if (!keyword && sort === "default") {
      const beginIdx = (page - 1) * limit;
      const slice = await this.#fetchPlaylistSongsSlice(cleanId, meta, beginIdx, limit, cookieMap, auth);
      const playlist: PlaylistSummary = { ...meta.summary, trackCount: slice.total };
      return {
        playlist,
        songs: slice.songs,
        total: slice.total,
        page,
        limit,
        hasMore: beginIdx + slice.rawItems.length < slice.total && slice.rawItems.length > 0,
      };
    }

    const allSongs = await this.getAllPlaylistTracks(cleanId, auth, MAX_SCAN_TRACKS);
    const rawTotal = Math.max(meta.summary.trackCount, allSongs.length);
    const truncated = rawTotal > MAX_SCAN_TRACKS;
    const filtered = sortAndFilterSongs(allSongs, keyword, sort);
    const start = (page - 1) * limit;
    const pageSongs = filtered.slice(start, start + limit);

    return {
      playlist: { ...meta.summary, trackCount: rawTotal },
      songs: pageSongs,
      total: filtered.length,
      page,
      limit,
      hasMore: start + pageSongs.length < filtered.length,
      ...(truncated ? { truncated: true, scannedTotal: allSongs.length } : {}),
    };
  }

  async getAllPlaylistTracks(
    playlistId: string,
    auth: ProviderAuthContext,
    maxTracks = 2000,
  ): Promise<Song[]> {
    const cleanId = playlistId.trim();
    if (!cleanId) return [];

    const cookieMap = parseKugouAuthCookie(auth);
    const meta = await this.#resolvePlaylistMeta(cleanId, cookieMap, auth);
    const cap = Math.max(1, Math.floor(maxTracks));
    const collected: Song[] = [];
    let beginIdx = 0;

    while (collected.length < cap) {
      const batchSize = Math.min(PUBSONGS_PAGE_SIZE, cap - collected.length);
      const slice = await this.#fetchPlaylistSongsSlice(cleanId, meta, beginIdx, batchSize, cookieMap, auth);
      if (slice.rawItems.length === 0) break;
      collected.push(...slice.songs);
      beginIdx += slice.rawItems.length;
      if (beginIdx >= slice.total || slice.rawItems.length < batchSize) {
        break;
      }
    }

    return collected.slice(0, cap);
  }

  async #resolveOwnedListId(
    playlistId: string,
    cookieMap: KugouCookieMap,
    auth: ProviderAuthContext,
  ): Promise<number> {
    const meta = await this.#resolvePlaylistMeta(playlistId, cookieMap, auth);
    if (meta.listid) return meta.listid;
    await this.getUserPlaylists(auth);
    const refreshed = this.#metaCache.get(auth.scopeKey, playlistId.trim());
    if (refreshed?.listid) return refreshed.listid;
    throw new AppError("VALIDATION_ERROR", "仅支持修改当前酷狗账号自建的歌单。");
  }

  async createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    const cookieMap = requireKugouAuthCookie(auth);
    const cleanName = name.trim();
    const clienttime = Math.floor(Date.now() / 1000);

    const createRes = await this.#client.request<{
      status?: number;
      error_code?: number;
      data?: {
        info?: {
          listid?: number | string;
          global_collection_id?: string;
        };
      };
    }>({
      path: "/cloudlist.service/v5/add_list",
      method: "POST",
      params: {
        last_time: clienttime,
        last_area: "gztx",
        userid: cookieMap.userid,
        token: cookieMap.token,
      },
      data: {
        userid: cookieMap.userid,
        token: cookieMap.token,
        total_ver: 0,
        name: cleanName,
        type: 0,
        source: 1,
        is_pri: 0,
        from_shupinmv: 0,
      },
      cookieMap,
      edition: cookieMap.kg_edition,
      signal: auth.signal,
    });

    const info = createRes.data?.info;
    const listid = Number(info?.listid ?? 0);
    if (createRes.status === 0 || !Number.isFinite(listid) || listid <= 0) {
      throw new AppError("UPSTREAM_ERROR", `创建酷狗歌单失败 (code ${createRes.error_code ?? "unknown"})。`);
    }

    const gid = info?.global_collection_id?.trim() || `listid_${listid}`;
    this.#metaCache.invalidateScope(auth.scopeKey);
    this.#metaCache.set(auth.scopeKey, gid, {
      summary: {
        id: gid,
        platform: "kugou",
        name: cleanName,
        trackCount: 0,
        creatorName: `酷狗 ${cookieMap.userid}`,
        owned: true,
      },
      listid,
    });

    let addedCount = 0;
    if (trackIds.length > 0) {
      const added = await this.addTracksToPlaylist(gid, trackIds, auth);
      addedCount = added.addedCount;
    }

    return {
      playlistId: gid,
      playlistName: cleanName,
      playlistUrl: `https://www.kugou.com/yy/special/single/${encodeURIComponent(gid)}.html`,
      addedCount,
    };
  }

  async addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }> {
    const cookieMap = requireKugouAuthCookie(auth);
    const listid = await this.#resolveOwnedListId(playlistId, cookieMap, auth);
    const hashes = [...new Set(trackIds.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (hashes.length === 0) return { addedCount: 0 };

    const conf = KUGOU_EDITION_CONFIGS[cookieMap.kg_edition];
    const privRes = await this.#client.request<{
      data?: Array<{
        hash?: string;
        name?: string;
        album_id?: number | string;
        album_audio_id?: number | string;
      }>;
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
        resource: hashes.map((hash) => ({ type: "audio", page_id: 0, hash, album_id: 0 })),
        qualities: ["128"],
      },
      headers: { "x-router": "media.store.kugou.com" },
      cookieMap,
      edition: cookieMap.kg_edition,
      signal: auth.signal,
    });

    const metaByHash = new Map<string, { name: string; album_id: number; mixsongid: number }>();
    for (const item of privRes.data ?? []) {
      const h = (item.hash ?? "").toLowerCase();
      if (!h) continue;
      metaByHash.set(h, {
        name: item.name?.trim() || h.toUpperCase(),
        album_id: Number(item.album_id ?? 0) || 0,
        mixsongid: Number(item.album_audio_id ?? 0) || 0,
      });
    }

    const resources = hashes.map((hash) => {
      const m = metaByHash.get(hash);
      return {
        number: 1,
        name: m?.name || hash.toUpperCase(),
        hash: hash.toUpperCase(),
        size: 0,
        sort: 0,
        timelen: 0,
        bitrate: 0,
        album_id: m?.album_id ?? 0,
        mixsongid: m?.mixsongid ?? 0,
      };
    });

    const clienttime = Math.floor(Date.now() / 1000);
    const addRes = await this.#client.request<{ status?: number; error_code?: number }>({
      path: "/cloudlist.service/v6/add_song",
      method: "POST",
      params: {
        last_time: clienttime,
        last_area: "gztx",
        userid: cookieMap.userid,
        token: cookieMap.token,
      },
      data: {
        userid: cookieMap.userid,
        token: cookieMap.token,
        listid,
        list_ver: 0,
        type: 0,
        slow_upload: 1,
        scene: "false;null",
        data: resources,
      },
      cookieMap,
      edition: cookieMap.kg_edition,
      signal: auth.signal,
    });

    if (addRes.status === 0) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `向酷狗歌单添加歌曲失败 (code ${addRes.error_code ?? "unknown"})。`,
      );
    }

    this.#metaCache.invalidateScope(auth.scopeKey);
    return { addedCount: resources.length };
  }

  async removeTracksFromPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }> {
    const cookieMap = requireKugouAuthCookie(auth);
    const listid = await this.#resolveOwnedListId(playlistId, cookieMap, auth);
    const targetHashes = new Set(trackIds.map((id) => id.trim().toUpperCase()).filter(Boolean));
    if (targetHashes.size === 0) return { removedCount: 0 };

    const listRes = await this.#client.request<{
      data?: {
        songs?: Array<{ hash?: string; fileid?: number }>;
        info?: Array<{ hash?: string; fileid?: number }>;
      };
    }>({
      path: "/v4/get_list_all_file_v3",
      method: "POST",
      data: {
        listid,
        userid: cookieMap.userid,
        type: 0,
        page: 1,
        pagesize: 1000,
        area_code: 1,
        allplatform: 1,
        show_cover: 0,
        token: cookieMap.token,
      },
      headers: { "x-router": "cloudlist.service.kugou.com" },
      cookieMap,
      edition: cookieMap.kg_edition,
      signal: auth.signal,
    });

    const rawSongs = listRes.data?.songs ?? listRes.data?.info ?? [];
    const fileIds = rawSongs
      .filter((s) => s.hash && targetHashes.has(s.hash.trim().toUpperCase()) && typeof s.fileid === "number")
      .map((s) => ({ fileid: s.fileid as number }));

    if (fileIds.length === 0) return { removedCount: 0 };

    const delRes = await this.#client.request<{ status?: number; error_code?: number }>({
      path: "/v4/delete_songs",
      method: "POST",
      data: {
        listid,
        userid: cookieMap.userid,
        data: fileIds,
        type: 0,
        token: cookieMap.token,
        list_ver: 0,
      },
      headers: { "x-router": "cloudlist.service.kugou.com" },
      cookieMap,
      edition: cookieMap.kg_edition,
      signal: auth.signal,
    });

    if (delRes.status === 0) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `从酷狗歌单移除歌曲失败 (code ${delRes.error_code ?? "unknown"})。`,
      );
    }

    this.#metaCache.invalidateScope(auth.scopeKey);
    return { removedCount: fileIds.length };
  }
}
