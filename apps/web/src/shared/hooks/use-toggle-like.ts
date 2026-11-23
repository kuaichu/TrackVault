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
  completedAt: number;
}

/**
 * Per-QueryClient map of recently confirmed heart mutations so an earlier in-flight
 * GET /api/likes/:platform resolving late can never overwrite a newer heart toggle (P06),
 * while remaining strictly scoped to the active QueryClient session.
 */
const recentLikeOverridesByClient = new WeakMap<
  QueryClient,
  Map<MusicPlatform, Map<string, LikeOverrideEntry>>
>();

function getPlatformOverrides(
  queryClient: QueryClient,
  platform: MusicPlatform,
): Map<string, LikeOverrideEntry> {
  let byPlatform = recentLikeOverridesByClient.get(queryClient);
  if (!byPlatform) {
    byPlatform = new Map();
    recentLikeOverridesByClient.set(queryClient, byPlatform);
  }
  let map = byPlatform.get(platform);
  if (!map) {
    map = new Map();
    byPlatform.set(platform, map);
  }
  return map;
}

export function useLikedIdsQuery(platform: MusicPlatform | undefined, enabled = true) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["liked-ids", platform],
    queryFn: async () => {
      if (!platform) return { ids: [] as string[] };
      const startedAt = Date.now();
      const res = await api.getLikedSongIds(platform);
      const overrides = getPlatformOverrides(queryClient, platform);
      if (overrides.size === 0) return res;

      const set = new Set(res.ids);
      for (const [songId, entry] of overrides.entries()) {
        if (entry.completedAt >= startedAt) {
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
      // P06: Cancel any older in-flight liked-ids GET so it cannot race and overwrite the new heart state
      await queryClient.cancelQueries({ queryKey: ["liked-ids", vars.platform] });
    },
    onSuccess: (res, vars) => {
      const overrides = getPlatformOverrides(queryClient, vars.platform);
      overrides.set(vars.songId, { liked: res.liked, completedAt: Date.now() });

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
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "操作失败");
    },
  });
}
