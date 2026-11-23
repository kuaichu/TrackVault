import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { type MusicPlatform, type SongComment, type SongCommentsPage, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, EqualizerBars, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";

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

export function PlayQueuePanel({ onDarkBackdrop = false }: { onDarkBackdrop?: boolean }) {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queue = usePlayerStore((s) => s.queue);

  const subtleTextClass = onDarkBackdrop ? "text-white/55" : "text-[var(--tv-text-subtle)]";
  const mutedTextClass = onDarkBackdrop ? "text-white/65" : "text-[var(--tv-text-muted)]";

  return (
    <div className="p-3 space-y-1">
      {queue.length > 0 && (
        <div className={`mb-2 flex items-center justify-between px-2 text-[11px] ${subtleTextClass}`}>
          <span>待播清单 · {queue.length} 首</span>
          <button
            type="button"
            onClick={() => audioEngine.clearQueue()}
            className={
              onDarkBackdrop ? "transition-colors hover:text-red-300" : "hover:text-[var(--tv-danger)]"
            }
          >
            清空
          </button>
        </div>
      )}
      {queue.length === 0 ? (
        <div className={`py-16 text-center text-xs ${mutedTextClass}`}>队列为空</div>
      ) : (
        queue.map((song) => {
          const key = getSongKey(song);
          const isCurrent = currentTrack ? getSongKey(currentTrack) === key : false;
          const rowClass = onDarkBackdrop
            ? isCurrent
              ? "bg-white/14"
              : "hover:bg-white/8"
            : isCurrent
              ? "bg-[var(--tv-accent-soft)]"
              : "hover:bg-[var(--tv-surface-hover)]";
          const titleClass = onDarkBackdrop
            ? isCurrent
              ? "text-white font-semibold"
              : "text-white/90"
            : isCurrent
              ? "text-[var(--tv-accent)]"
              : "text-[var(--tv-text)]";

          return (
            <div
              key={key}
              className={`group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${rowClass}`}
            >
              <CoverArt
                src={song.coverUrl}
                alt={song.title}
                darkBackdrop={onDarkBackdrop}
                className="h-9 w-9"
                rounded="rounded"
              />
              <button
                type="button"
                onClick={() => void audioEngine.playTrack(song)}
                className="min-w-0 flex-1 text-left"
              >
                <div className={`truncate text-[13px] font-medium ${titleClass}`}>{song.title}</div>
                <div className={`mt-0.5 flex items-center gap-1.5 text-[11px] ${mutedTextClass}`}>
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
                  className={`rounded p-1.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:group-focus-within:transition-none md:focus:opacity-100 md:focus:transition-none md:focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:transition-none focus-visible:outline-none focus-visible:ring-2 ${
                    onDarkBackdrop
                      ? "text-white/50 hover:text-red-300 focus-visible:text-red-300 focus-visible:ring-white/70"
                      : "text-[var(--tv-text-subtle)] hover:text-[var(--tv-danger)] focus-visible:text-[var(--tv-danger)] focus-visible:ring-[var(--tv-accent)]"
                  }`}
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
  );
}

export function TrackCommentsPanel({
  active,
  onDarkBackdrop = false,
}: {
  active: boolean;
  onDarkBackdrop?: boolean;
}) {
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((s) => s.currentTrack);

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
    enabled: Boolean(active && currentTrack && commentSongId),
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

  const loadedPages = commentsQuery.data?.pages ?? [];
  const hasLoadedAnyPage = loadedPages.length > 0;

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

  const primaryTextClass = onDarkBackdrop ? "text-white/95" : "text-[var(--tv-text)]";
  const bodyTextClass = onDarkBackdrop ? "text-white/75" : "text-[var(--tv-text-muted)]";
  const subtleTextClass = onDarkBackdrop ? "text-white/50" : "text-[var(--tv-text-subtle)]";
  const dividerClass = onDarkBackdrop ? "divide-white/10" : "divide-[var(--tv-border)]";
  const actionBtnClass = onDarkBackdrop
    ? "bg-white/12 text-white/85 hover:bg-white/20 hover:text-white"
    : "bg-[var(--tv-surface)] text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]";

  const renderCommentCard = (comment: SongComment, keyPrefix: string) => (
    <div key={`${keyPrefix}-${comment.id}`} className="py-3.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={`font-medium ${primaryTextClass}`}>{comment.nickname}</span>
        <span className={`text-[11px] ${subtleTextClass}`}>{comment.timeText}</span>
      </div>
      <p className={`text-[12.5px] leading-relaxed whitespace-pre-wrap ${bodyTextClass}`}>
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
              ? onDarkBackdrop
                ? "text-[#fa2d48]"
                : "text-[var(--tv-accent)]"
              : onDarkBackdrop
                ? "text-white/55 hover:text-white"
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
    <div className="px-4 py-2">
      {!currentTrack ? (
        <div className={`py-16 text-center text-xs ${bodyTextClass}`}>播放歌曲后查看评论</div>
      ) : commentsQuery.isLoading && !hasLoadedAnyPage ? (
        <div className={`py-16 text-center text-xs ${bodyTextClass}`}>载入评论中...</div>
      ) : commentsQuery.isError && !hasLoadedAnyPage ? (
        <div className={`py-16 text-center text-xs space-y-3 ${bodyTextClass}`}>
          <div>{commentsQuery.error instanceof Error ? commentsQuery.error.message : "评论加载失败"}</div>
          <button
            type="button"
            onClick={() => void commentsQuery.refetch()}
            className={`inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${actionBtnClass}`}
          >
            重试
          </button>
        </div>
      ) : hotComments.length === 0 &&
        latestComments.length === 0 &&
        !commentsQuery.hasNextPage &&
        !commentsQuery.isFetchNextPageError ? (
        <div className={`py-16 text-center text-xs ${bodyTextClass}`}>暂无评论</div>
      ) : (
        <div className="space-y-4">
          {hotComments.length === 0 && latestComments.length === 0 && (
            <div className={`py-8 text-center text-xs ${bodyTextClass}`}>当前页暂无可展示的评论</div>
          )}
          {hotComments.length > 0 && (
            <section>
              <h3 className={`pb-1 text-[11px] font-semibold ${subtleTextClass}`}>精彩评论</h3>
              <div className={`divide-y ${dividerClass}`}>
                {hotComments.map((comment) => renderCommentCard(comment, "hot"))}
              </div>
            </section>
          )}

          {latestComments.length > 0 && (
            <section>
              <h3 className={`pb-1 text-[11px] font-semibold ${subtleTextClass}`}>最新评论</h3>
              <div className={`divide-y ${dividerClass}`}>
                {latestComments.map((comment) => renderCommentCard(comment, "latest"))}
              </div>
            </section>
          )}

          {/* P17: Keep already-loaded pages visible when page 2+ fails, and retry fetchNextPage() locally */}
          {commentsQuery.isFetchNextPageError ? (
            <div className="py-3 text-center space-y-2">
              <div className={`text-xs ${onDarkBackdrop ? "text-red-300" : "text-[var(--tv-danger)]"}`}>
                {commentsQuery.error instanceof Error ? commentsQuery.error.message : "加载更多评论失败"}
              </div>
              <button
                type="button"
                disabled={commentsQuery.isFetchingNextPage}
                onClick={() => void commentsQuery.fetchNextPage()}
                className={`inline-flex items-center rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${actionBtnClass}`}
              >
                重试加载更多
              </button>
            </div>
          ) : (
            commentsQuery.hasNextPage && (
              <div className="py-3 text-center">
                <button
                  type="button"
                  disabled={commentsQuery.isFetchingNextPage}
                  onClick={() => void commentsQuery.fetchNextPage()}
                  className={`inline-flex items-center rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${actionBtnClass}`}
                >
                  {commentsQuery.isFetchingNextPage ? "加载中..." : "加载更多"}
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
