import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Trash2 } from "lucide-react";
import type { Song } from "#shared";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import {
  abortPlayHistoryClear,
  applyClearedPlayHistory,
  audioEngine,
  beginPlayHistoryClear,
  fetchSyncedPlayHistory,
  usePlayerStore,
} from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { EmptyState } from "../../shared/ui/primitives.js";
import { SongTable } from "../../widgets/song-table/index.js";

const CLOUD_PAGE_SIZE = 100;
const MAX_CLOUD_PLAY_ALL_PAGES = 30;

function dedupCloudSongs(list: readonly Song[]): Song[] {
  const seen = new Set<string>();
  const out: Song[] = [];
  for (const song of list) {
    if (!seen.has(song.id)) {
      seen.add(song.id);
      out.push(song);
    }
  }
  return out;
}

export function CloudPage() {
  const cloudPlayAllLoading = usePlayerStore((s) => s.cloudPlayAllLoading);

  const cloudQuery = useInfiniteQuery({
    queryKey: ["cloud-songs"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.getCloudSongs({ offset: pageParam, limit: CLOUD_PAGE_SIZE }),
    // A10: Advance cursor by upstream raw consumed count (`nextOffset`) so filtered items never duplicate tail rows
    getNextPageParam: (lastPage) =>
      lastPage.hasMore
        ? (lastPage.nextOffset ?? lastPage.offset + Math.max(lastPage.songs.length, 1))
        : undefined,
  });

  const pages = cloudQuery.data?.pages ?? [];
  const songs = dedupCloudSongs(pages.flatMap((page) => page.songs));
  const total = pages[0]?.total ?? songs.length;

  const handlePlayAll = () => {
    void audioEngine.playCloudAll({
      initialSongs: songs,
      hasNextPage: Boolean(cloudQuery.hasNextPage),
      isFetchNextPageError: cloudQuery.isFetchNextPageError,
      maxPages: MAX_CLOUD_PLAY_ALL_PAGES,
      fetchNextPage: async () => {
        const nextRes = await cloudQuery.fetchNextPage();
        const latestPages = nextRes.data?.pages ?? [];
        return {
          songs: dedupCloudSongs(latestPages.flatMap((page) => page.songs)),
          hasNextPage: Boolean(nextRes.hasNextPage),
          isError: nextRes.isError,
          error: nextRes.error,
        };
      },
    });
  };

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
            disabled={cloudPlayAllLoading}
            onClick={handlePlayAll}
            className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-4 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-50"
          >
            {cloudPlayAllLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            {cloudPlayAllLoading ? "加载全部中..." : "播放全部"}
          </button>
        )}
      </div>

      {cloudQuery.isLoading && pages.length === 0 ? (
        <div className="space-y-2">
          {["c1", "c2", "c3", "c4", "c5"].map((id) => (
            <div key={id} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : cloudQuery.isError && pages.length === 0 ? (
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
          <SongTable songs={songs} showPlatformBadge={false} emptyText="云盘暂无歌曲" />
          {cloudQuery.isFetchNextPageError ? (
            <div className="flex flex-col items-center gap-2 pt-2 text-center">
              <p className="text-xs text-[var(--tv-danger)]">
                {cloudQuery.error instanceof Error ? cloudQuery.error.message : "加载更多云盘歌曲失败"}
              </p>
              <button
                type="button"
                disabled={cloudQuery.isFetchingNextPage}
                onClick={() => void cloudQuery.fetchNextPage()}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--tv-surface)] px-5 py-2 text-xs font-medium text-[var(--tv-text)] transition-colors hover:bg-[var(--tv-surface-hover)] disabled:opacity-50"
              >
                {cloudQuery.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {cloudQuery.isFetchingNextPage ? "正在重试..." : "重试加载更多"}
              </button>
            </div>
          ) : (
            cloudQuery.hasNextPage && (
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
            )
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
    queryFn: () => fetchSyncedPlayHistory(queryClient),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearPlayHistory(),
    onMutate: async () => {
      const clearSeq = beginPlayHistoryClear(queryClient);
      const wasFetching = queryClient.getQueryState(["play-history"])?.fetchStatus === "fetching";
      await queryClient.cancelQueries({ queryKey: ["play-history"] });
      return { clearSeq, wasFetching };
    },
    onSuccess: (res, _vars, context) => {
      applyClearedPlayHistory(queryClient, res, context?.clearSeq);
      toast.info("已清空播放记录");
    },
    onError: (err, _vars, context) => {
      abortPlayHistoryClear(queryClient, context?.clearSeq);
      void queryClient.invalidateQueries({ queryKey: ["play-history"] });
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
                  const first = findFirstPlayableSong(songs);
                  if (!first) {
                    toast.info("当前列表中的歌曲均不可播放");
                    return;
                  }
                  void audioEngine.playTrack(first, { queue: songs });
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
