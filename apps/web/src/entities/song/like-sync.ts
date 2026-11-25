import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { MusicPlatform } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

export interface ToggleLikeVariables {
  platform: MusicPlatform;
  songId: string;
  nextLiked: boolean;
  songTitle?: string;
}

const MAX_LIKE_OVERRIDES_PER_PLATFORM = 200;

interface LikeOverrideEntry {
  liked: boolean;
  startSeq: number;
  completedSeq: number;
}

interface ClientLikeSyncState {
  seq: number;
  version: number;
  listeners: Set<() => void>;
  byPlatform: Map<MusicPlatform, Map<string, LikeOverrideEntry>>;
  latestMutationSeqByPlatform: Map<MusicPlatform, Map<string, number>>;
  inFlightByPlatform: Map<MusicPlatform, Map<string, number>>;
}

/**
 * Per-QueryClient state of recently confirmed heart mutations so an earlier in-flight
 * GET /api/likes/:platform resolving late can never overwrite a newer heart toggle (P06),
 * while remaining strictly scoped to the active QueryClient session.
 */
const likeStateByClient = new WeakMap<QueryClient, ClientLikeSyncState>();

function getClientLikeState(queryClient: QueryClient): ClientLikeSyncState {
  let state = likeStateByClient.get(queryClient);
  if (!state) {
    state = {
      seq: 0,
      version: 0,
      listeners: new Set(),
      byPlatform: new Map(),
      latestMutationSeqByPlatform: new Map(),
      inFlightByPlatform: new Map(),
    };
    likeStateByClient.set(queryClient, state);
  }
  return state;
}

function notifyLikeStateListeners(state: ClientLikeSyncState): void {
  state.version += 1;
  for (const listener of state.listeners) {
    listener();
  }
}

function getOrCreatePlatformMap<T>(
  root: Map<MusicPlatform, Map<string, T>>,
  platform: MusicPlatform,
): Map<string, T> {
  let map = root.get(platform);
  if (!map) {
    map = new Map();
    root.set(platform, map);
  }
  return map;
}

function setBoundedEntry<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) break;
    map.delete(oldestKey);
  }
}

function updateLikedIdsCache(
  queryClient: QueryClient,
  platform: MusicPlatform,
  songId: string,
  liked: boolean,
): boolean {
  const existingList = queryClient.getQueryData<{ ids: string[] }>(["liked-ids", platform]);
  if (existingList === undefined) {
    return false;
  }
  const next = new Set(existingList.ids);
  if (liked) next.add(songId);
  else next.delete(songId);
  queryClient.setQueryData<{ ids: string[] }>(["liked-ids", platform], { ids: [...next] });
  return true;
}

export function useLikedIdsQuery(platform: MusicPlatform | undefined, enabled = true) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["liked-ids", platform],
    queryFn: async () => {
      if (!platform) return { ids: [] as string[] };
      const state = getClientLikeState(queryClient);
      const startedSeq = ++state.seq;
      const res = await api.getLikedSongIds(platform);
      const overrides = getOrCreatePlatformMap(state.byPlatform, platform);
      if (overrides.size === 0) return res;

      const set = new Set(res.ids);
      for (const [songId, entry] of overrides.entries()) {
        if (entry.completedSeq > startedSeq) {
          if (entry.liked) set.add(songId);
          else set.delete(songId);
        }
      }
      return { ids: [...set] };
    },
    enabled: Boolean(enabled && platform),
    staleTime: 60_000,
    retry: false,
  });
}

export function useIsSongLiked(
  platform: MusicPlatform | undefined,
  songId: string | undefined,
  enabled = true,
): { liked: boolean; isLoading: boolean } {
  const queryClient = useQueryClient();
  const isEnabled = Boolean(enabled && platform && songId);
  const query = useLikedIdsQuery(platform, isEnabled);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!isEnabled) return () => {};
      const state = getClientLikeState(queryClient);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    [queryClient, isEnabled],
  );

  useSyncExternalStore(subscribe, () => (isEnabled ? getClientLikeState(queryClient).version : 0));

  let liked = false;
  if (isEnabled && platform && songId) {
    if (query.data !== undefined) {
      liked = query.data.ids.includes(songId);
    } else {
      const state = getClientLikeState(queryClient);
      liked = getOrCreatePlatformMap(state.byPlatform, platform).get(songId)?.liked ?? false;
    }
  }

  return {
    liked,
    isLoading: isEnabled ? query.isLoading : false,
  };
}

export function useToggleLikeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ platform, songId, nextLiked }: ToggleLikeVariables) =>
      api.toggleSongLike(platform, songId, nextLiked),
    onMutate: async (vars) => {
      const state = getClientLikeState(queryClient);
      const mutationStartSeq = ++state.seq;
      const latestSeqMap = getOrCreatePlatformMap(state.latestMutationSeqByPlatform, vars.platform);
      setBoundedEntry(latestSeqMap, vars.songId, mutationStartSeq, MAX_LIKE_OVERRIDES_PER_PLATFORM);

      const inFlightMap = getOrCreatePlatformMap(state.inFlightByPlatform, vars.platform);
      const prevInFlightCount = inFlightMap.get(vars.songId) ?? 0;
      inFlightMap.set(vars.songId, prevInFlightCount + 1);
      const hadConcurrentSameSongMutation = prevInFlightCount > 0;

      const hadFetchingQuery = queryClient.isFetching({ queryKey: ["liked-ids", vars.platform] }) > 0;
      // P06: Cancel any older in-flight liked-ids GET so it cannot race and overwrite the new heart state
      await queryClient.cancelQueries({ queryKey: ["liked-ids", vars.platform] });

      // Never fabricate a partial liked-ids list if the full list has not been loaded yet
      const existingList = queryClient.getQueryData<{ ids: string[] }>(["liked-ids", vars.platform]);
      if (existingList === undefined) {
        return {
          hadFetchingQuery,
          mutationStartSeq,
          hadOptimisticUpdate: false,
          prevLiked: false,
          hadConcurrentSameSongMutation,
        };
      }

      if (latestSeqMap.get(vars.songId) !== mutationStartSeq) {
        return {
          hadFetchingQuery,
          mutationStartSeq,
          hadOptimisticUpdate: false,
          prevLiked: existingList.ids.includes(vars.songId),
          hadConcurrentSameSongMutation,
        };
      }

      const prevLiked = existingList.ids.includes(vars.songId);
      updateLikedIdsCache(queryClient, vars.platform, vars.songId, vars.nextLiked);

      return {
        hadFetchingQuery,
        mutationStartSeq,
        hadOptimisticUpdate: true,
        prevLiked,
        hadConcurrentSameSongMutation,
      };
    },
    onSuccess: (res, vars, context) => {
      const state = getClientLikeState(queryClient);
      const startSeq = context?.mutationStartSeq ?? ++state.seq;
      const overrides = getOrCreatePlatformMap(state.byPlatform, vars.platform);
      const latestSeqMap = getOrCreatePlatformMap(state.latestMutationSeqByPlatform, vars.platform);
      const prev = overrides.get(vars.songId);
      const latestSeq = latestSeqMap.get(vars.songId);
      if ((prev && prev.startSeq > startSeq) || (latestSeq !== undefined && latestSeq > startSeq)) {
        // P06: Ignore out-of-order delayed acknowledgment from an earlier heart mutation so it can never
        // clobber a newer pending or completed toggle on the same song.
        return;
      }

      setBoundedEntry(
        overrides,
        vars.songId,
        { liked: res.liked, startSeq, completedSeq: ++state.seq },
        MAX_LIKE_OVERRIDES_PER_PLATFORM,
      );
      notifyLikeStateListeners(state);

      // Never fabricate a partial liked-ids list if the full list has not been loaded yet
      const updated = updateLikedIdsCache(queryClient, vars.platform, vars.songId, res.liked);
      if (!updated) {
        void queryClient.invalidateQueries({ queryKey: ["liked-ids", vars.platform] });
      }

      if (vars.songTitle) {
        toast.success(res.liked ? `已喜欢「${vars.songTitle}」` : `已取消喜欢「${vars.songTitle}」`);
      } else {
        toast.success(res.liked ? "已喜欢" : "已取消喜欢");
      }
    },
    onError: (err, vars, context) => {
      const state = getClientLikeState(queryClient);
      const latestSeq = getOrCreatePlatformMap(state.latestMutationSeqByPlatform, vars.platform).get(
        vars.songId,
      );
      const isSuperseded =
        latestSeq !== undefined &&
        context?.mutationStartSeq !== undefined &&
        latestSeq > context.mutationStartSeq;

      let shouldInvalidate =
        queryClient.getQueryData<{ ids: string[] }>(["liked-ids", vars.platform]) === undefined ||
        Boolean(context?.hadFetchingQuery);

      if (!isSuperseded && context?.hadOptimisticUpdate) {
        if (context.hadConcurrentSameSongMutation) {
          shouldInvalidate = true;
        } else {
          const rolledBack = updateLikedIdsCache(queryClient, vars.platform, vars.songId, context.prevLiked);
          if (!rolledBack) {
            shouldInvalidate = true;
          }
        }
      }

      // P06: If onMutate cancelled the initial ["liked-ids", platform] fetch and toggleSongLike failed,
      // recover the liked-ids query immediately so other songs' heart states do not stay unloaded forever.
      if (shouldInvalidate) {
        void queryClient.invalidateQueries({ queryKey: ["liked-ids", vars.platform] });
      }
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
    onSettled: (_data, _error, vars) => {
      const state = getClientLikeState(queryClient);
      const inFlightMap = getOrCreatePlatformMap(state.inFlightByPlatform, vars.platform);
      const count = inFlightMap.get(vars.songId) ?? 0;
      if (count <= 1) {
        inFlightMap.delete(vars.songId);
      } else {
        inFlightMap.set(vars.songId, count - 1);
      }
    },
  });
}
