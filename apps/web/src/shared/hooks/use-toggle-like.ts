import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MusicPlatform } from "#shared";
import { api } from "../api/endpoints.js";
import { toast } from "../store/toast-store.js";

export interface ToggleLikeVariables {
  platform: MusicPlatform;
  songId: string;
  nextLiked: boolean;
  songTitle?: string;
}

export function useLikedIdsQuery(platform: MusicPlatform | undefined, enabled = true) {
  return useQuery({
    queryKey: ["liked-ids", platform],
    queryFn: () => {
      if (!platform) return Promise.resolve({ ids: [] as string[] });
      return api.getLikedSongIds(platform);
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
    onSuccess: (res, vars) => {
      // Always key by captured mutation variables so track switches in flight never corrupt another song's cache
      queryClient.setQueryData(["song-like", vars.platform, vars.songId], res);

      // Never fabricate a partial liked-ids list if the full list has not been loaded yet
      queryClient.setQueryData<{ ids: string[] }>(["liked-ids", vars.platform], (prev) => {
        if (prev === undefined) return undefined;
        const next = new Set(prev.ids);
        if (res.liked) next.add(vars.songId);
        else next.delete(vars.songId);
        return { ids: [...next] };
      });

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
