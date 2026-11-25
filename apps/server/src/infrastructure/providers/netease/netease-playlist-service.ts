import type { PlaylistSummary, PlaylistTracksPage, Song } from "#shared";
import { AppError } from "../../../domain/errors.js";
import { sortAndFilterSongs } from "../../../domain/policies/playlist-query-policy.js";
import type {
  CreatePlaylistResult,
  CredentialVerificationResult,
  PlaylistScanInspection,
  PlaylistTrackQuery,
  ProviderAuthContext,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { resolveProviderCacheScope } from "../common/cache-scope.js";
import {
  type RawNeteasePlaylist,
  type RawNeteasePrivilege,
  type RawNeteaseSong,
  mapNeteasePlaylist,
  mapNeteaseSong,
} from "./netease-mapper.js";
import {
  type NeteaseRpcClient,
  SONG_DETAIL_BATCH_SIZE,
  extractNeteaseApiError,
} from "./netease-rpc-client.js";

const MAX_PLAYLIST_TRACKS_FETCH = 2000;
const MAX_PLAYLIST_SEARCH_TRACKS = 10_000;
const SONG_DETAIL_CONCURRENCY = 4;
const PLAYLIST_MUTATION_CHUNK_SIZE = 50;

interface CachedNeteasePlaylistDetail {
  scope: string;
  scopeEpoch: number;
  plVersion: number;
  summary: PlaylistSummary;
  trackIds: string[];
  songMap: Map<string, Song>;
}

export class NeteasePlaylistService {
  readonly #rpc: NeteaseRpcClient;
  readonly #verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>;
  readonly #playlistDetailCache = new ScopedLruCache<CachedNeteasePlaylistDetail>({
    maxEntries: 40,
    defaultTtlMs: 3 * 60 * 1000,
  });
  readonly #playlistMutationVersions = new Map<string, number>();
  readonly #playlistDetailInFlight = new Map<string, Promise<CachedNeteasePlaylistDetail>>();
  readonly #hydrateTrackInFlight = new Map<string, Promise<Song | undefined>>();

  constructor(
    rpc: NeteaseRpcClient,
    verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>,
  ) {
    this.#rpc = rpc;
    this.#verifyCredential = verifyCredential;
  }

  invalidateScope(scopeKey: string): void {
    this.#playlistDetailCache.invalidateScope(scopeKey);
    const prefix = `${scopeKey}\u0000`;
    for (const key of this.#playlistMutationVersions.keys()) {
      if (key.startsWith(prefix)) {
        this.#playlistMutationVersions.delete(key);
      }
    }
  }

  #getPlaylistVersion(scope: string, playlistId: string): number {
    return this.#playlistMutationVersions.get(`${scope}\u0000${playlistId}`) ?? 0;
  }

  #bumpPlaylistVersion(scope: string, playlistId: string): number {
    const key = `${scope}\u0000${playlistId}`;
    const next = (this.#playlistMutationVersions.get(key) ?? 0) + 1;
    this.#playlistMutationVersions.delete(key);
    this.#playlistMutationVersions.set(key, next);
    while (this.#playlistMutationVersions.size > 200) {
      const oldest = this.#playlistMutationVersions.keys().next().value;
      if (oldest === undefined) break;
      this.#playlistMutationVersions.delete(oldest);
    }
    return next;
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const uid = await this.#rpc.resolveUid(auth, this.#verifyCredential);
    try {
      const response = await this.#rpc.call(
        () => this.#rpc.api.user_playlist(this.#rpc.baseParams(auth, { uid, limit: 200, offset: 0 })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "获取网易云歌单列表失败");
      const raw = (response.body.playlist as RawNeteasePlaylist[] | undefined) ?? [];
      return raw
        .map((item) => mapNeteasePlaylist(item, uid))
        .filter((item): item is PlaylistSummary => item !== null);
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云歌单列表失败");
    }
  }

  async #getPlaylistDetail(
    playlistId: string,
    auth: ProviderAuthContext,
  ): Promise<CachedNeteasePlaylistDetail> {
    if (auth.signal?.aborted) {
      throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
    }

    const scope = resolveProviderCacheScope(auth);
    const cacheKey = `detail:${playlistId}`;
    const cached = this.#playlistDetailCache.get(scope, cacheKey);
    if (cached) return cached;

    const scopeEpoch = this.#playlistDetailCache.getEpoch(scope);
    const plVersion = this.#getPlaylistVersion(scope, playlistId);
    const flightKey = `${scope}\u0000${scopeEpoch}\u0000${plVersion}\u0000${cacheKey}`;

    let flight = this.#playlistDetailInFlight.get(flightKey);
    if (!flight) {
      const fetchAuth: ProviderAuthContext = { ...auth, signal: undefined };
      flight = (async () => {
        try {
          const response = await this.#rpc.call(() =>
            this.#rpc.api.playlist_detail(this.#rpc.baseParams(fetchAuth, { id: playlistId })),
          );
          this.#rpc.assertBusinessSuccess(response.body, "获取网易云歌单详情失败");
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
            fetchAuth.accountUid?.trim() ||
            (fetchAuth.cookie ? this.#rpc.getCachedUid(fetchAuth.scopeKey, fetchAuth.cookie) : undefined) ||
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
            scope,
            scopeEpoch,
            plVersion,
            summary: { ...summary, trackCount: Math.max(summary.trackCount, trackIds.length) },
            trackIds,
            songMap,
          };
          if (this.#getPlaylistVersion(scope, playlistId) === plVersion) {
            this.#playlistDetailCache.setIfEpoch(scope, cacheKey, detail, scopeEpoch);
          }
          return detail;
        } catch (error) {
          throw this.#rpc.wrapUpstreamError(error, "获取网易云歌单详情失败");
        } finally {
          this.#playlistDetailInFlight.delete(flightKey);
        }
      })();
      this.#playlistDetailInFlight.set(flightKey, flight);
    }

    return this.#rpc.raceWithSignal(flight, auth.signal);
  }

  async #hydrateTrackIds(
    playlistId: string,
    trackIds: string[],
    detail: CachedNeteasePlaylistDetail,
    auth: ProviderAuthContext,
  ): Promise<Map<string, Song>> {
    const resolvedMap = new Map<string, Song>();
    const missing: string[] = [];
    for (const id of trackIds) {
      const existing = detail.songMap.get(id);
      if (existing) {
        resolvedMap.set(id, existing);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return resolvedMap;

    if (auth.signal?.aborted) {
      throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
    }

    const { scope, scopeEpoch, plVersion } = detail;
    const flightPrefix = `${scope}\u0000${scopeEpoch}\u0000${plVersion}\u0000`;
    const needFetchIds: string[] = [];
    const waitList: Array<{ id: string; promise: Promise<Song | undefined> }> = [];

    for (const id of missing) {
      const key = `${flightPrefix}${id}`;
      const existingFlight = this.#hydrateTrackInFlight.get(key);
      if (existingFlight) {
        waitList.push({ id, promise: existingFlight });
      } else {
        needFetchIds.push(id);
      }
    }

    let cleanupWaiter: (() => void) | undefined;
    if (needFetchIds.length > 0) {
      const uniqueNeed = [...new Set(needFetchIds)];
      const batches: string[][] = [];
      for (let i = 0; i < uniqueNeed.length; i += SONG_DETAIL_BATCH_SIZE) {
        batches.push(uniqueNeed.slice(i, i + SONG_DETAIL_BATCH_SIZE));
      }

      const batchAbort = new AbortController();
      let activeWaiters = 1;
      const releaseWaiter = () => {
        if (activeWaiters <= 0) return;
        activeWaiters -= 1;
        if (activeWaiters === 0) {
          batchAbort.abort();
        }
      };
      if (auth.signal) {
        const onCallerAbort = () => releaseWaiter();
        auth.signal.addEventListener("abort", onCallerAbort, { once: true });
        cleanupWaiter = () => {
          auth.signal?.removeEventListener("abort", onCallerAbort);
          releaseWaiter();
        };
      } else {
        cleanupWaiter = releaseWaiter;
      }

      const fetchAuth: ProviderAuthContext = { ...auth, signal: batchAbort.signal };
      const fetchRun = (async () => {
        const fetchedById = new Map<string, Song>();
        for (let i = 0; i < batches.length; i += SONG_DETAIL_CONCURRENCY) {
          if (batchAbort.signal.aborted) break;
          const slice = batches.slice(i, i + SONG_DETAIL_CONCURRENCY);
          const responses = await Promise.all(
            slice.map((ids) =>
              this.#rpc.call(
                () =>
                  this.#rpc.api.song_detail(
                    this.#rpc.baseParams(fetchAuth, { ids: ids.join(",") }, batchAbort.signal),
                  ),
                batchAbort.signal,
              ),
            ),
          );
          const canCommitToCache =
            this.#playlistDetailCache.getEpoch(scope) === scopeEpoch &&
            this.#getPlaylistVersion(scope, playlistId) === plVersion;

          for (const response of responses) {
            const rawSongs = (response.body.songs as RawNeteaseSong[] | undefined) ?? [];
            const privileges = (response.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
            const privMap = new Map(
              privileges.filter((p) => p.id !== undefined).map((p) => [String(p.id), p]),
            );
            for (const rawSong of rawSongs) {
              const mapped = mapNeteaseSong(rawSong, {
                privilege: rawSong.id !== undefined ? privMap.get(String(rawSong.id)) : undefined,
              });
              if (mapped) {
                fetchedById.set(mapped.id, mapped);
                if (canCommitToCache) {
                  detail.songMap.set(mapped.id, mapped);
                }
              }
            }
          }
        }
        return fetchedById;
      })();

      fetchRun.catch(() => undefined);

      for (const id of uniqueNeed) {
        const key = `${flightPrefix}${id}`;
        const trackPromise = fetchRun
          .then((map) => map.get(id))
          .finally(() => {
            this.#hydrateTrackInFlight.delete(key);
          });
        trackPromise.catch(() => undefined);
        this.#hydrateTrackInFlight.set(key, trackPromise);
        waitList.push({ id, promise: trackPromise });
      }
    }

    try {
      const settled = await this.#rpc.raceWithSignal(
        Promise.all(waitList.map(async ({ id, promise }) => [id, await promise] as const)),
        auth.signal,
      );
      for (const [id, song] of settled) {
        if (song) {
          resolvedMap.set(id, song);
        }
      }
      return resolvedMap;
    } finally {
      cleanupWaiter?.();
    }
  }

  async inspectPlaylistTracks(
    playlistId: string,
    maxTracks: number,
    auth: ProviderAuthContext,
  ): Promise<PlaylistScanInspection> {
    const cappedMax = Math.min(MAX_PLAYLIST_SEARCH_TRACKS, Math.max(1, Math.floor(maxTracks)));
    const detail = await this.#getPlaylistDetail(playlistId, auth);
    const targetIds = detail.trackIds.slice(0, cappedMax);
    const beyondIds = detail.trackIds.slice(cappedMax);

    try {
      const hydratedMap = await this.#hydrateTrackIds(playlistId, targetIds, detail, auth);
      const songs = targetIds.map((id) => hydratedMap.get(id)).filter((s): s is Song => Boolean(s));
      const totalSlots = Math.max(detail.summary.trackCount, detail.trackIds.length);
      return {
        songs,
        totalSlots,
        scannedSlotIds: new Set(targetIds),
        beyondScanSlotIds: new Set(beyondIds),
        truncatedSlots: totalSlots > cappedMax,
      };
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云歌单曲目失败");
    }
  }

  async getAllPlaylistTracks(
    playlistId: string,
    auth: ProviderAuthContext,
    maxTracks = MAX_PLAYLIST_TRACKS_FETCH,
  ): Promise<Song[]> {
    const inspected = await this.inspectPlaylistTracks(playlistId, maxTracks, auth);
    return inspected.songs;
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

    if (!hasFilterOrSort) {
      const pageIds = detail.trackIds.slice(offset, offset + safeLimit);
      let hydratedMap: Map<string, Song>;
      try {
        hydratedMap = await this.#hydrateTrackIds(playlistId, pageIds, detail, auth);
      } catch (error) {
        throw this.#rpc.wrapUpstreamError(error, "获取网易云歌单曲目失败");
      }

      const pageSongs = pageIds.map((id) => hydratedMap.get(id)).filter((s): s is Song => Boolean(s));
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

    const targetIds = detail.trackIds.slice(0, MAX_PLAYLIST_SEARCH_TRACKS);
    let hydratedMap: Map<string, Song>;
    try {
      hydratedMap = await this.#hydrateTrackIds(playlistId, targetIds, detail, auth);
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云歌单曲目失败");
    }

    const allSongs = targetIds.map((id) => hydratedMap.get(id)).filter((s): s is Song => Boolean(s));
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

  async #mutatePlaylistTracks(
    op: "add" | "del",
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<number> {
    this.#rpc.assertAuthed(auth);
    const uniqueIds = [...new Set(trackIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) return 0;

    const actionLabel = op === "add" ? "添加" : "移除";
    const baseFailMsg = op === "add" ? "添加歌曲到歌单失败" : "从歌单移除歌曲失败";
    let completedCount = 0;

    try {
      for (let i = 0; i < uniqueIds.length; i += PLAYLIST_MUTATION_CHUNK_SIZE) {
        const chunk = uniqueIds.slice(i, i + PLAYLIST_MUTATION_CHUNK_SIZE);
        const response = await this.#rpc.call(
          () =>
            this.#rpc.api.playlist_tracks(
              this.#rpc.baseParams(auth, { op, pid: playlistId, tracks: chunk.join(",") }),
            ),
          auth.signal,
        );
        this.#rpc.assertBusinessSuccess(response.body, baseFailMsg);
        completedCount += chunk.length;
      }

      return completedCount;
    } catch (error) {
      const partialNote =
        completedCount > 0 ? `（已成功${actionLabel}前 ${completedCount}/${uniqueIds.length} 首）` : "";
      if (error instanceof AppError) {
        if (!partialNote) throw error;
        throw new AppError(error.code, `${error.message}${partialNote}`, {
          cause: error,
          details: { ...(error.details ?? {}), completedCount, totalCount: uniqueIds.length },
        });
      }
      throw new AppError("UPSTREAM_ERROR", `${extractNeteaseApiError(error, baseFailMsg)}${partialNote}`, {
        cause: error,
        details: { completedCount, totalCount: uniqueIds.length },
      });
    } finally {
      if (completedCount > 0) {
        const scope = resolveProviderCacheScope(auth);
        this.#playlistDetailCache.invalidateScope(scope, `detail:${playlistId}`);
        this.#bumpPlaylistVersion(scope, playlistId);
      }
    }
  }

  async addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }> {
    const addedCount = await this.#mutatePlaylistTracks("add", playlistId, trackIds, auth);
    return { addedCount };
  }

  async removeTracksFromPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }> {
    const removedCount = await this.#mutatePlaylistTracks("del", playlistId, trackIds, auth);
    return { removedCount };
  }

  async createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    this.#rpc.assertAuthed(auth);
    const playlistName = name.trim();
    if (!playlistName) {
      throw new AppError("VALIDATION_ERROR", "请输入新歌单名称。");
    }

    let createdId = "";
    try {
      const createRes = await this.#rpc.call(
        () => this.#rpc.api.playlist_create(this.#rpc.baseParams(auth, { name: playlistName })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(createRes.body, "创建网易云歌单失败");
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
      throw this.#rpc.wrapUpstreamError(error, "创建网易云歌单失败");
    } finally {
      if (createdId) {
        const scope = resolveProviderCacheScope(auth);
        this.#playlistDetailCache.invalidateScope(scope, `detail:${createdId}`);
        this.#bumpPlaylistVersion(scope, createdId);
      }
    }
  }
}
