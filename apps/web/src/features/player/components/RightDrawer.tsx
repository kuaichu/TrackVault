import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ThumbsUp, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { type MusicPlatform, type SongComment, type SongCommentsPage, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, EqualizerBars, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { type RightDrawerTab, usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";

interface CommentLikeVariables {
  platform: MusicPlatform;
  songId: string;
  commentId: string;
  liked: boolean;
}

function updateCommentList(comments: SongComment[], commentId: string, liked: boolean): SongComment[] {
  return comments.map((comment) => {
    if (comment.id !== commentId) return comment;
    const delta = liked === comment.liked ? 0 : liked ? 1 : -1;
    return {
      ...comment,
      liked,
      likedCount: Math.max(0, comment.likedCount + delta),
    };
  });
}

export function RightDrawer() {
  const queryClient = useQueryClient();
  const open = usePlayerStore((s) => s.drawerOpen);
  const tab = usePlayerStore((s) => s.drawerTab);
  const setOpen = usePlayerStore((s) => s.setDrawerOpen);
  const setTab = usePlayerStore((s) => s.setDrawerTab);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queue = usePlayerStore((s) => s.queue);

  const lyricsQuery = useQuery({
    queryKey: ["lyrics", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.getLyrics(currentTrack.platform, currentTrack.id, currentTrack.mediaId) : null,
    enabled: Boolean(open && tab === "lyrics" && currentTrack),
  });

  const commentSongId =
    currentTrack?.platform === "qq" ? (currentTrack.providerSongId ?? currentTrack.id) : currentTrack?.id;

  const commentsQuery = useInfiniteQuery({
    queryKey: ["comments", currentTrack?.platform, commentSongId],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      if (!currentTrack || !commentSongId) {
        throw new Error("无当前曲目");
      }
      return api.getComments(currentTrack.platform, commentSongId, pageParam, 20);
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.page + 1 : undefined),
    enabled: Boolean(open && tab === "comments" && currentTrack && commentSongId),
  });

  const likeCommentMutation = useMutation({
    mutationFn: ({ platform, songId, commentId, liked }: CommentLikeVariables) =>
      api.setCommentLiked(platform, songId, commentId, liked),
    onSuccess: (res, vars) => {
      // Strictly key by captured mutation variables so track switches never corrupt another song's comments
      const queryKey = ["comments", vars.platform, vars.songId] as const;
      queryClient.setQueryData<InfiniteData<SongCommentsPage>>(queryKey, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            hotComments: updateCommentList(page.hotComments, vars.commentId, res.liked),
            comments: updateCommentList(page.comments, vars.commentId, res.liked),
          })),
        };
      });
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "评论点赞失败"),
  });

  const { hotComments, latestComments } = useMemo(() => {
    const pages = commentsQuery.data?.pages ?? [];
    const seenHot = new Set<string>();
    const dedupHot: SongComment[] = [];
    for (const comment of pages[0]?.hotComments ?? []) {
      if (seenHot.has(comment.id)) continue;
      seenHot.add(comment.id);
      dedupHot.push(comment);
    }

    const seenLatest = new Set<string>(seenHot);
    const dedupLatest: SongComment[] = [];
    for (const page of pages) {
      for (const comment of page.comments) {
        if (seenLatest.has(comment.id)) continue;
        seenLatest.add(comment.id);
        dedupLatest.push(comment);
      }
    }

    return { hotComments: dedupHot, latestComments: dedupLatest };
  }, [commentsQuery.data?.pages]);

  if (!open) return null;

  const tabs: Array<{ id: RightDrawerTab; label: string }> = [
    { id: "queue", label: `队列 · ${queue.length}` },
    { id: "lyrics", label: "歌词" },
    { id: "comments", label: "评论" },
  ];

  const renderCommentCard = (comment: SongComment, keyPrefix: string) => (
    <div key={`${keyPrefix}-${comment.id}`} className="py-3.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--tv-text)]">{comment.nickname}</span>
        <span className="text-[11px] text-[var(--tv-text-subtle)]">{comment.timeText}</span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-[var(--tv-text-muted)] whitespace-pre-wrap">
        {comment.content}
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!currentTrack || !commentSongId}
          onClick={() => {
            if (!currentTrack || !commentSongId) return;
            likeCommentMutation.mutate({
              platform: currentTrack.platform,
              songId: commentSongId,
              commentId: comment.id,
              liked: !comment.liked,
            });
          }}
          className={`inline-flex items-center gap-1 text-[11px] tabular-nums transition-colors ${
            comment.liked
              ? "text-[var(--tv-accent)]"
              : "text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
          }`}
        >
          <ThumbsUp className="h-3 w-3" />
          {comment.likedCount}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 flex flex-col justify-end md:static md:z-auto md:flex md:shrink-0"
      style={{ zIndex: "var(--tv-z-modal)" }}
    >
      {/* Mobile dimmed backdrop */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="fixed inset-0 bg-black/55 backdrop-blur-xs md:hidden"
        aria-label="关闭侧栏遮罩"
      />

      <aside className="tv-pb-safe relative flex h-[78dvh] w-full flex-col rounded-t-2xl border-t border-[var(--tv-border-strong)] bg-[var(--tv-sidebar)] shadow-2xl md:h-full md:w-[336px] md:rounded-none md:border-l md:border-t-0 md:border-[var(--tv-border)] md:shadow-none">
        {/* Mobile grab indicator */}
        <div className="flex justify-center pt-2 md:hidden">
          <span className="h-1 w-9 rounded-full bg-[var(--tv-border-strong)]" />
        </div>

        <div className="flex h-13 items-center justify-between border-b border-[var(--tv-border)] px-3.5 md:h-14">
          <div className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] p-0.5 text-xs">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  tab === item.id
                    ? "bg-[var(--tv-surface-elevated)] text-[var(--tv-text)] shadow-xs"
                    : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            aria-label="收起侧栏"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "queue" && (
            <div className="p-3 space-y-1">
              {queue.length > 0 && (
                <div className="mb-2 flex items-center justify-between px-2 text-[11px] text-[var(--tv-text-subtle)]">
                  <span>待播清单</span>
                  <button
                    type="button"
                    onClick={() => audioEngine.clearQueue()}
                    className="hover:text-[var(--tv-danger)]"
                  >
                    清空
                  </button>
                </div>
              )}
              {queue.length === 0 ? (
                <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">队列为空</div>
              ) : (
                queue.map((song) => {
                  const key = getSongKey(song);
                  const isCurrent = currentTrack ? getSongKey(currentTrack) === key : false;
                  return (
                    <div
                      key={key}
                      className={`group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${
                        isCurrent ? "bg-[var(--tv-accent-soft)]" : "hover:bg-[var(--tv-surface-hover)]"
                      }`}
                    >
                      <CoverArt src={song.coverUrl} alt={song.title} className="h-9 w-9" rounded="rounded" />
                      <button
                        type="button"
                        onClick={() => void audioEngine.playTrack(song)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div
                          className={`truncate text-[13px] font-medium ${
                            isCurrent ? "text-[var(--tv-accent)]" : "text-[var(--tv-text)]"
                          }`}
                        >
                          {song.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--tv-text-muted)]">
                          <span className="truncate">{song.artist}</span>
                          <PlatformBadge platform={song.platform} subtle />
                        </div>
                      </button>
                      {isCurrent && isPlaying ? (
                        <EqualizerBars />
                      ) : (
                        <button
                          type="button"
                          onClick={() => audioEngine.removeFromQueue(key)}
                          className="rounded p-1.5 text-[var(--tv-text-subtle)] opacity-100 transition-opacity hover:text-[var(--tv-danger)] md:opacity-0 md:group-hover:opacity-100"
                          aria-label="移出队列"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {tab === "lyrics" &&
            (!currentTrack ? (
              <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">播放歌曲后查看歌词</div>
            ) : (
              <LyricScroller
                lines={lyricsQuery.data?.lyrics.lines ?? []}
                loading={lyricsQuery.isLoading}
                error={
                  lyricsQuery.isError
                    ? lyricsQuery.error instanceof Error
                      ? lyricsQuery.error.message
                      : "歌词加载失败"
                    : null
                }
                onRetry={() => void lyricsQuery.refetch()}
              />
            ))}

          {tab === "comments" && (
            <div className="px-4 py-2">
              {!currentTrack ? (
                <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">
                  播放歌曲后查看评论
                </div>
              ) : commentsQuery.isLoading ? (
                <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">载入评论中...</div>
              ) : commentsQuery.isError ? (
                <div className="py-16 text-center text-xs text-[var(--tv-text-muted)] space-y-3">
                  <div>
                    {commentsQuery.error instanceof Error ? commentsQuery.error.message : "评论加载失败"}
                  </div>
                  <button
                    type="button"
                    onClick={() => void commentsQuery.refetch()}
                    className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
                  >
                    重试
                  </button>
                </div>
              ) : hotComments.length === 0 && latestComments.length === 0 ? (
                <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">暂无评论</div>
              ) : (
                <div className="space-y-4">
                  {hotComments.length > 0 && (
                    <section>
                      <h3 className="pb-1 text-[11px] font-semibold text-[var(--tv-text-subtle)]">
                        精彩评论
                      </h3>
                      <div className="divide-y divide-[var(--tv-border)]">
                        {hotComments.map((comment) => renderCommentCard(comment, "hot"))}
                      </div>
                    </section>
                  )}

                  {latestComments.length > 0 && (
                    <section>
                      <h3 className="pb-1 text-[11px] font-semibold text-[var(--tv-text-subtle)]">
                        最新评论
                      </h3>
                      <div className="divide-y divide-[var(--tv-border)]">
                        {latestComments.map((comment) => renderCommentCard(comment, "latest"))}
                      </div>
                    </section>
                  )}

                  {commentsQuery.hasNextPage && (
                    <div className="py-3 text-center">
                      <button
                        type="button"
                        disabled={commentsQuery.isFetchingNextPage}
                        onClick={() => void commentsQuery.fetchNextPage()}
                        className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] px-3.5 py-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:opacity-50"
                      >
                        {commentsQuery.isFetchingNextPage ? "加载中..." : "加载更多"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
