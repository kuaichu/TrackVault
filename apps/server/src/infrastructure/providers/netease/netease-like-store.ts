import type {
  CredentialVerificationResult,
  ProviderAuthContext,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import type { NeteaseRpcClient } from "./netease-rpc-client.js";

/**
 * Isolated Netease red-heart (like) state machine preserving monotonic read/write
 * reconciliation across overlapping GETs, reversed ACKs, and account rebind epochs.
 */
export class NeteaseLikeStore {
  readonly #rpc: NeteaseRpcClient;
  readonly #likeSetCache = new ScopedLruCache<{
    set: Set<string>;
    readStartEpoch: number;
    readSeq: number;
  }>({
    maxEntries: 50,
    defaultTtlMs: 2 * 60 * 1000,
  });
  readonly #recentLikeMutations = new ScopedLruCache<
    Map<string, { liked: boolean; epoch: number; writeStartSeq: number }>
  >({
    maxEntries: 50,
    defaultTtlMs: 5 * 60 * 1000,
  });
  #likeMutationEpoch = 0;
  #likeReadSeq = 0;
  #likeWriteSeq = 0;
  readonly #inFlightLikeReads = new Map<
    number,
    { scopeKey: string; scopeEpoch: number; startEpoch: number }
  >();
  readonly #inFlightLikeWrites = new Map<number, { scopeKey: string; scopeEpoch: number; songId: string }>();

  constructor(rpc: NeteaseRpcClient) {
    this.#rpc = rpc;
  }

  invalidateScope(scopeKey: string): void {
    this.#likeSetCache.invalidateScope(scopeKey);
    this.#recentLikeMutations.invalidateScope(scopeKey);
  }

  #mutationCacheKey(uid: string | null | undefined, mutEpoch: number): string {
    return uid ? `mutations:${uid}` : `mutations:epoch:${mutEpoch}`;
  }

  #getMinInFlightLikeEpoch(scopeKey: string, scopeEpoch: number): number {
    let min = Number.POSITIVE_INFINITY;
    for (const entry of this.#inFlightLikeReads.values()) {
      if (entry.scopeKey === scopeKey && entry.scopeEpoch === scopeEpoch && entry.startEpoch < min) {
        min = entry.startEpoch;
      }
    }
    return min;
  }

  #hasInFlightLikeWrite(scopeKey: string, scopeEpoch: number, songId: string): boolean {
    for (const entry of this.#inFlightLikeWrites.values()) {
      if (entry.scopeKey === scopeKey && entry.scopeEpoch === scopeEpoch && entry.songId === songId) {
        return true;
      }
    }
    return false;
  }

  async #getLikeSet(
    auth: ProviderAuthContext,
    verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>,
  ): Promise<Set<string>> {
    const scope = auth.scopeKey;
    const scopeEpoch = this.#likeSetCache.getEpoch(scope);
    const mutEpoch = this.#recentLikeMutations.getEpoch(scope);
    const startEpoch = this.#likeMutationEpoch;
    const readId = ++this.#likeReadSeq;
    this.#inFlightLikeReads.set(readId, { scopeKey: scope, scopeEpoch, startEpoch });

    try {
      const uid = await this.#rpc.resolveUid(auth, verifyCredential);
      const cacheKey = `likes:${uid}`;
      const epochStillValid =
        this.#likeSetCache.getEpoch(scope) === scopeEpoch &&
        this.#recentLikeMutations.getEpoch(scope) === mutEpoch;
      if (epochStillValid) {
        const cached = this.#likeSetCache.get(scope, cacheKey);
        if (cached) return new Set(cached.set);
      }

      const response = await this.#rpc.call(
        () => this.#rpc.api.likelist(this.#rpc.baseParams(auth, { uid })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "获取网易云红心列表失败");
      const ids = ((response.body.ids as Array<number | string> | undefined) ?? []).map(String);
      const set = new Set(ids);

      if (
        this.#likeSetCache.getEpoch(scope) !== scopeEpoch ||
        this.#recentLikeMutations.getEpoch(scope) !== mutEpoch
      ) {
        return set;
      }

      for (const mutKey of [this.#mutationCacheKey(uid, mutEpoch), this.#mutationCacheKey(null, mutEpoch)]) {
        const recentMutations = this.#recentLikeMutations.get(scope, mutKey);
        if (recentMutations) {
          for (const [mutSongId, entry] of recentMutations.entries()) {
            if (entry.epoch > startEpoch) {
              if (entry.liked) set.add(mutSongId);
              else set.delete(mutSongId);
            }
          }
        }
      }

      const currentCached = this.#likeSetCache.get(scope, cacheKey);
      if (currentCached && (currentCached.readStartEpoch > startEpoch || currentCached.readSeq > readId)) {
        return new Set(currentCached.set);
      }

      this.#likeSetCache.setIfEpoch(
        scope,
        cacheKey,
        {
          set: new Set(set),
          readStartEpoch: startEpoch,
          readSeq: readId,
        },
        scopeEpoch,
      );
      return set;
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "获取网易云红心列表失败");
    } finally {
      this.#inFlightLikeReads.delete(readId);
      if (this.#recentLikeMutations.getEpoch(scope) === mutEpoch) {
        const minActiveEpoch = this.#getMinInFlightLikeEpoch(scope, scopeEpoch);
        const uidHint =
          auth.accountUid?.trim() || (auth.cookie ? this.#rpc.getCachedUid(scope, auth.cookie) : undefined);
        const candidateKeys = uidHint
          ? [this.#mutationCacheKey(uidHint, mutEpoch), this.#mutationCacheKey(null, mutEpoch)]
          : [this.#mutationCacheKey(null, mutEpoch)];
        for (const mutKey of candidateKeys) {
          const recentMutations = this.#recentLikeMutations.get(scope, mutKey);
          if (recentMutations && recentMutations.size > 0) {
            for (const [mutSongId, entry] of recentMutations.entries()) {
              if (
                entry.epoch <= startEpoch &&
                entry.epoch <= minActiveEpoch &&
                !this.#hasInFlightLikeWrite(scope, scopeEpoch, mutSongId)
              ) {
                recentMutations.delete(mutSongId);
              }
            }
          }
        }
      }
    }
  }

  async getLikedSongIds(
    auth: ProviderAuthContext,
    verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>,
  ): Promise<string[]> {
    if (!auth.cookie?.trim()) return [];
    const set = await this.#getLikeSet(auth, verifyCredential);
    return [...set];
  }

  async toggleSongLike(
    songId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    const cookie = this.#rpc.assertAuthed(auth);
    const scope = auth.scopeKey;
    const scopeEpoch = this.#likeSetCache.getEpoch(scope);
    const mutEpoch = this.#recentLikeMutations.getEpoch(scope);
    const uidHint = auth.accountUid?.trim() || this.#rpc.getCachedUid(scope, cookie) || null;
    const writeStartSeq = ++this.#likeWriteSeq;
    this.#inFlightLikeWrites.set(writeStartSeq, { scopeKey: scope, scopeEpoch, songId });

    try {
      // NeteaseCloudMusicApi/module/like.js checks `query.like == 'false' ? false : true`
      const response = await this.#rpc.call(
        () => this.#rpc.api.like(this.#rpc.baseParams(auth, { id: songId, like: String(liked) })),
        auth.signal,
      );
      this.#rpc.assertBusinessSuccess(response.body, "红心操作失败");

      if (
        this.#likeSetCache.getEpoch(scope) !== scopeEpoch ||
        this.#recentLikeMutations.getEpoch(scope) !== mutEpoch
      ) {
        return { liked };
      }

      const mutKey = this.#mutationCacheKey(uidHint, mutEpoch);
      const scopeMutations = this.#recentLikeMutations.get(scope, mutKey) ?? new Map();
      const prevMutation = scopeMutations.get(songId);
      if (prevMutation && prevMutation.writeStartSeq > writeStartSeq) {
        scopeMutations.delete(songId);
        this.#recentLikeMutations.setIfEpoch(scope, mutKey, scopeMutations, mutEpoch);
        this.#likeSetCache.invalidateScope(scope, "likes:");
        return { liked };
      }

      const mutationEpoch = ++this.#likeMutationEpoch;
      if (scopeMutations.has(songId)) {
        scopeMutations.delete(songId);
      }
      scopeMutations.set(songId, { liked, epoch: mutationEpoch, writeStartSeq });
      while (scopeMutations.size > 200) {
        const oldestKey = scopeMutations.keys().next().value;
        if (!oldestKey) break;
        scopeMutations.delete(oldestKey);
      }
      this.#recentLikeMutations.setIfEpoch(scope, mutKey, scopeMutations, mutEpoch);

      if (uidHint) {
        const cacheKey = `likes:${uidHint}`;
        const existing = this.#likeSetCache.get(scope, cacheKey);
        if (existing) {
          const next = new Set(existing.set);
          if (liked) next.add(songId);
          else next.delete(songId);
          this.#likeSetCache.setIfEpoch(
            scope,
            cacheKey,
            {
              set: next,
              readStartEpoch: Math.max(existing.readStartEpoch, mutationEpoch),
              readSeq: Math.max(existing.readSeq, this.#likeReadSeq),
            },
            scopeEpoch,
          );
        }
      } else {
        this.#likeSetCache.invalidateScope(scope, "likes:");
      }
      return { liked };
    } catch (error) {
      throw this.#rpc.wrapUpstreamError(error, "红心操作失败");
    } finally {
      this.#inFlightLikeWrites.delete(writeStartSeq);
    }
  }
}
