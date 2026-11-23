import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MusicPlatform } from "#shared";
import { api } from "../api/endpoints.js";
import { toast } from "../store/toast-store.js";

export interface ToggleLikeVariables {
  platform: MusicPlatform;
  songId: string;
  nextLiked: boolean;
  songTitle?: string;
}

interface LikeOverrideEntry {
  liked: boolean;
  completedSeq: number;
}

interface ClientLikeSyncState {
  seq: number;
  byPlatform: Map<MusicPlatform, Map<string, LikeOverrideEntry>>;
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
    state = { seq: 0, byPlatform: new Map() };
    likeStateByClient.set(queryClient, state);
  }
  return state;
}

function getPlatformOverrides(
  queryClient: QueryClient,
  platform: MusicPlatform,
): Map<string, LikeOverrideEntry> {
  const state = getClientLikeState(queryClient);
  let map = state.byPlatform.get(platform);
  if (!map) {
    map = new Map();
    state.byPlatform.set(platform, map);
  }
  return map;
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
      const overrides = getPlatformOverrides(queryClient, platform);
      if (overrides.size === 0) return res;

      const set = new Set(res.ids);
      for (const [songId, entry] of overrides.entries()) {
        if (entry.completedSeq > startedSeq) {
          if (entry.liked) set.add(songId);
          else set.delete(songId);
        } else {
          overrides.delete(songId);
        }
      }
      return { ids: [...set] };
    },
    enabled: Boolean(enabled && platform),
    staleTime: 60_000,
    retry: false,
  });
}

export function useToggleLikeMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ platform, songId, nextLiked }: ToggleLikeVariables) =>
      api.toggleSongLike(platform, songId, nextLiked),
    onMutate: async (vars) => {
      const hadFetchingQuery = queryClient.isFetching({ queryKey: ["liked-ids", vars.platform] }) > 0;
      // P06: Cancel any older in-flight liked-ids GET so it cannot race and overwrite the new heart state
      await queryClient.cancelQueries({ queryKey: ["liked-ids", vars.platform] });
      return { hadFetchingQuery };
    },
    onSuccess: (res, vars) => {
      const state = getClientLikeState(queryClient);
      const overrides = getPlatformOverrides(queryClient, vars.platform);
      overrides.set(vars.songId, { liked: res.liked, completedSeq: ++state.seq });

      // Always key by captured mutation variables so track switches in flight never corrupt another song's cache
      queryClient.setQueryData(["song-like", vars.platform, vars.songId], res);

      // Never fabricate a partial liked-ids list if the full list has not been loaded yet
      const existingList = queryClient.getQueryData<{ ids: string[] }>(["liked-ids", vars.platform]);
      if (existingList !== undefined) {
        const next = new Set(existingList.ids);
        if (res.liked) next.add(vars.songId);
        else next.delete(vars.songId);
        queryClient.setQueryData<{ ids: string[] }>(["liked-ids", vars.platform], { ids: [...next] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ["liked-ids", vars.platform] });
      }

      if (vars.songTitle) {
        toast.success(res.liked ? `已喜欢「${vars.songTitle}」` : `已取消喜欢「${vars.songTitle}」`);
      } else {
        toast.success(res.liked ? "已喜欢" : "已取消喜欢");
      }
    },
    onError: (err, vars, context) => {
      // P06: If onMutate cancelled the initial ["liked-ids", platform] fetch and toggleSongLike failed,
      // recover the liked-ids query immediately so other songs' heart states do not stay unloaded forever.
      const existingList = queryClient.getQueryData<{ ids: string[] }>(["liked-ids", vars.platform]);
      if (existingList === undefined || context?.hadFetchingQuery) {
        void queryClient.invalidateQueries({ queryKey: ["liked-ids", vars.platform] });
      }
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
  });
}
