import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Trash2 } from "lucide-react";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { EmptyState } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

const CLOUD_PAGE_SIZE = 100;

export function CloudPage() {
  const cloudQuery = useInfiniteQuery({
    queryKey: ["cloud-songs"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getCloudSongs({ offset: pageParam, limit: CLOUD_PAGE_SIZE }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.songs.length : undefined),
  });

  const pages = cloudQuery.data?.pages ?? [];
  const songs = pages.flatMap((page) => page.songs);
  const total = pages[0]?.total ?? songs.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">云盘</h1>
          {total > 0 && (
            <span className="text-xs tabular-nums text-[var(--tv-text-muted)]">
              已加载 {songs.length} / {total} 首
            </span>
          )}
        </div>
        {songs.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const first = songs[0];
              if (first) void audioEngine.playTrack(first, { queue: songs });
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-4 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            播放全部
          </button>
        )}
      </div>

      {cloudQuery.isLoading ? (
        <div className="space-y-2">
          {["c1", "c2", "c3", "c4", "c5"].map((id) => (
            <div key={id} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : cloudQuery.isError ? (
        <EmptyState
          title="未能加载网易云盘"
          description={cloudQuery.error instanceof Error ? cloudQuery.error.message : "请先绑定网易云账号"}
          action={
            <button
              type="button"
              onClick={() => void cloudQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : (
        <>
          <SongTable songs={songs} emptyText="云盘暂无歌曲" />
          {cloudQuery.hasNextPage && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                disabled={cloudQuery.isFetchingNextPage}
                onClick={() => void cloudQuery.fetchNextPage()}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--tv-surface)] px-5 py-2 text-xs font-medium text-[var(--tv-text)] transition-colors hover:bg-[var(--tv-surface-hover)] disabled:opacity-50"
              >
                {cloudQuery.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {cloudQuery.isFetchingNextPage ? "正在加载更多..." : "加载更多"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function HistoryPage() {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["play-history"],
    queryFn: () => api.getPlayHistory(),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearPlayHistory(),
    onSuccess: (res) => {
      queryClient.setQueryData(["play-history"], res);
      toast.info("已清空播放记录");
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "清空播放记录失败");
    },
  });

  const songs = historyQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">最近播放</h1>
        <div className="flex items-center gap-2">
          {songs.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  const first = songs[0];
                  if (first) void audioEngine.playTrack(first, { queue: songs });
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                全部播放
              </button>
              <button
                type="button"
                disabled={clearMutation.isPending}
                onClick={() => clearMutation.mutate()}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-danger)] disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </button>
            </>
          )}
        </div>
      </div>

      {historyQuery.isLoading ? (
        <div className="space-y-2">
          {["h1", "h2", "h3", "h4", "h5"].map((id) => (
            <div key={id} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : historyQuery.isError ? (
        <EmptyState
          title="未能加载最近播放"
          description={historyQuery.error instanceof Error ? historyQuery.error.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void historyQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : (
        <SongTable
          songs={songs}
          emptyText="还没有播放记录"
          emptyDescription="播放过的曲目会自动保存在这里。"
        />
      )}
    </div>
  );
}
