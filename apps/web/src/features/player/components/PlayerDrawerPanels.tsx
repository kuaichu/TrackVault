import { type InfiniteData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Trash2 } from "lucide-react";
import { type UIEvent, useMemo, useState } from "react";
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

export function formatShortCommentTime(timeText: string): string {
  const trimmed = timeText.trim();
  if (!trimmed) return "";
  const fullDateMatch = trimmed.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (fullDateMatch) {
    const [, y, m, d] = fullDateMatch;
    return `${y}.${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`;
  }
  const monthDayMatch = trimmed.match(/^(\d{1,2})[-/.月](\d{1,2})日?(?:\s+\d{1,2}:\d{2})?/);
  if (monthDayMatch) {
    const [, m, d] = monthDayMatch;
    return `${String(m).padStart(2, "0")}.${String(d).padStart(2, "0")}`;
  }
  if (trimmed.startsWith("昨天")) return "昨天";
  if (trimmed.startsWith("前天")) return "前天";
  return trimmed;
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
  const fmMode = usePlayerStore((s) => s.fmMode);
  const [scrolled, setScrolled] = useState(false);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrolled = event.currentTarget.scrollTop > 4;
    setScrolled((prev) => (prev === nextScrolled ? prev : nextScrolled));
  };

  const mutedTextClass = onDarkBackdrop ? "text-white/50" : "text-[var(--tv-text-muted)]";

  const renderQueueItems = () =>
    queue.map((song) => {
      const key = getSongKey(song);
      const isCurrent = currentTrack ? getSongKey(currentTrack) === key : false;
      const showCrossPlatformBadge =
        !onDarkBackdrop && Boolean(currentTrack && song.platform !== currentTrack.platform);

      const rowClass = onDarkBackdrop
        ? isCurrent
          ? "bg-white/[0.10]"
          : "hover:bg-white/[0.055]"
        : isCurrent
          ? "bg-[var(--tv-accent-soft)]"
          : "hover:bg-[var(--tv-surface-hover)]";
      const titleClass = onDarkBackdrop
        ? isCurrent
          ? "text-white font-semibold"
          : "text-white/[0.90] font-medium group-hover:text-white"
        : isCurrent
          ? "text-[var(--tv-accent)] font-semibold"
          : "text-[var(--tv-text)] font-medium";

      return (
        <div
          key={key}
          className={`group flex items-center transition-colors duration-150 ${
            onDarkBackdrop
              ? `gap-3.5 rounded-[10px] px-3 py-2 ${rowClass}`
              : `gap-2.5 rounded-lg px-2 py-1.5 ${rowClass}`
          }`}
        >
          <CoverArt
            src={song.coverUrl}
            alt={song.title}
            darkBackdrop={onDarkBackdrop}
            className={onDarkBackdrop ? "h-11 w-11 shadow-sm ring-1 ring-white/10" : "h-10 w-10"}
            rounded={onDarkBackdrop ? "rounded-[7px]" : "rounded-[6px]"}
          />
          <button
            type="button"
            onClick={() => void audioEngine.playTrack(song, { fm: fmMode })}
            className="min-w-0 flex-1 text-left"
          >
            <div
              className={`truncate leading-snug ${onDarkBackdrop ? "text-[14px]" : "text-[13px]"} ${titleClass}`}
            >
              {song.title}
            </div>
            <div
              className={`mt-0.5 flex items-center gap-1.5 ${
                onDarkBackdrop ? "text-[12px] text-white/48" : "text-[11.5px] text-[var(--tv-text-muted)]"
              }`}
            >
              <span className="truncate">{song.artist}</span>
              {showCrossPlatformBadge && <PlatformBadge platform={song.platform} subtle />}
            </div>
          </button>
          {isCurrent && isPlaying ? (
            <div className="px-1.5">
              <EqualizerBars tone={onDarkBackdrop ? "light" : "accent"} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => audioEngine.removeFromQueue(key)}
              className={`rounded-full p-1.5 opacity-100 transition-all md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:group-focus-within:transition-none md:focus:opacity-100 md:focus:transition-none md:focus-visible:opacity-100 focus-visible:opacity-100 focus-visible:transition-none focus-visible:outline-none focus-visible:ring-2 ${
                onDarkBackdrop
                  ? "text-white/40 hover:bg-white/10 hover:text-white/90 focus-visible:text-white focus-visible:ring-white/70"
                  : "text-[var(--tv-text-subtle)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-danger)] focus-visible:text-[var(--tv-danger)] focus-visible:ring-[var(--tv-accent)]"
              }`}
              aria-label="移出队列"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      );
    });

  if (onDarkBackdrop) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {queue.length > 0 && (
          <div className="flex shrink-0 items-baseline justify-between px-3 pt-0.5 pb-3">
            <h3 className="text-[15px] font-semibold tracking-tight text-white/92">
              待播清单
              <span className="ml-1.5 text-[13px] font-normal tabular-nums text-white/45">
                · {queue.length} 首
              </span>
            </h3>
            <button
              type="button"
              onClick={() => audioEngine.clearQueue()}
              className="rounded-md px-1.5 py-0.5 text-[12.5px] font-medium text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/90"
            >
              清空
            </button>
          </div>
        )}
        {queue.length === 0 ? (
          <div className={`py-16 text-center text-sm ${mutedTextClass}`}>队列为空</div>
        ) : (
          <div
            onScroll={handleScroll}
            className={`tv-no-scrollbar min-h-0 flex-1 overflow-y-auto pt-1 pb-14 space-y-1.5 ${
              scrolled ? "tv-panel-mask-both" : "tv-panel-mask-bottom"
            }`}
          >
            {renderQueueItems()}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 space-y-1">
      {queue.length > 0 && (
        <div className="mb-2 flex items-center justify-between px-2 text-xs text-[var(--tv-text-subtle)]">
          <span className="font-semibold text-[var(--tv-text)]">
            待播清单
            <span className="ml-1 font-normal text-[var(--tv-text-subtle)]">· {queue.length} 首</span>
          </span>
          <button
            type="button"
            onClick={() => audioEngine.clearQueue()}
            className="transition-colors hover:text-[var(--tv-danger)]"
          >
            清空
          </button>
        </div>
      )}
      {queue.length === 0 ? (
        <div className={`py-16 text-center text-xs ${mutedTextClass}`}>队列为空</div>
      ) : (
        renderQueueItems()
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
  const [scrolled, setScrolled] = useState(false);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const nextScrolled = event.currentTarget.scrollTop > 4;
    setScrolled((prev) => (prev === nextScrolled ? prev : nextScrolled));
  };

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

  const statusTextClass = onDarkBackdrop ? "text-white/55" : "text-[var(--tv-text-muted)]";
  const actionBtnClass = onDarkBackdrop
    ? "rounded-full bg-white/[0.08] px-4 py-1.5 text-white/80 hover:bg-white/[0.15] hover:text-white"
    : "rounded-lg bg-[var(--tv-surface)] px-3.5 py-1.5 text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]";

  const renderCommentCard = (comment: SongComment, keyPrefix: string) => {
    const shortTime = formatShortCommentTime(comment.timeText);
    return (
      <article
        key={`${keyPrefix}-${comment.id}`}
        className={
          onDarkBackdrop
            ? "border-b border-white/[0.06] py-[18px] first:pt-2.5 last:border-b-0"
            : "border-b border-[var(--tv-border)] py-3.5 last:border-b-0"
        }
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={`truncate font-medium ${
                onDarkBackdrop ? "text-[12.5px] text-white/55" : "text-xs text-[var(--tv-text-muted)]"
              }`}
            >
              {comment.nickname}
            </span>
            {shortTime && (
              <span
                className={`shrink-0 tabular-nums ${
                  onDarkBackdrop ? "text-[11.5px] text-white/34" : "text-[11px] text-[var(--tv-text-subtle)]"
                }`}
              >
                {shortTime}
              </span>
            )}
          </div>

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
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[11.5px] tabular-nums transition-colors ${
              comment.liked
                ? onDarkBackdrop
                  ? "text-[#fa2d48]"
                  : "text-[var(--tv-accent)]"
                : onDarkBackdrop
                  ? "text-white/42 hover:bg-white/[0.06] hover:text-white/85"
                  : "text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
            }`}
          >
            <ThumbsUp className="h-3 w-3" />
            {comment.likedCount}
          </button>
        </div>

        <p
          className={`mt-2 whitespace-pre-wrap break-words ${
            onDarkBackdrop
              ? "text-[14.5px] leading-[1.65] text-white/[0.88]"
              : "text-[13.5px] leading-[1.6] text-[var(--tv-text)]"
          }`}
        >
          {comment.content}
        </p>
      </article>
    );
  };

  const sectionTitleClass = onDarkBackdrop
    ? "pb-1 text-[15px] font-semibold tracking-tight text-white/92"
    : "pb-1 text-xs font-semibold text-[var(--tv-text)]";

  return (
    <div
      onScroll={onDarkBackdrop ? handleScroll : undefined}
      className={
        onDarkBackdrop
          ? `tv-no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pt-0.5 pb-14 ${
              scrolled ? "tv-panel-mask-both" : "tv-panel-mask-bottom"
            }`
          : "px-4 py-3"
      }
    >
      {!currentTrack ? (
        <div className={`py-16 text-center text-xs ${statusTextClass}`}>播放歌曲后查看评论</div>
      ) : commentsQuery.isLoading && !hasLoadedAnyPage ? (
        <div className={`py-16 text-center text-xs ${statusTextClass}`}>载入评论中...</div>
      ) : commentsQuery.isError && !hasLoadedAnyPage ? (
        <div className={`py-16 text-center text-xs space-y-3 ${statusTextClass}`}>
          <div>{commentsQuery.error instanceof Error ? commentsQuery.error.message : "评论加载失败"}</div>
          <button
            type="button"
            onClick={() => void commentsQuery.refetch()}
            className={`inline-flex items-center text-xs font-medium transition-colors ${actionBtnClass}`}
          >
            重试
          </button>
        </div>
      ) : hotComments.length === 0 &&
        latestComments.length === 0 &&
        !commentsQuery.hasNextPage &&
        !commentsQuery.isFetchNextPageError ? (
        <div className={`py-16 text-center text-xs ${statusTextClass}`}>暂无评论</div>
      ) : (
        <div className={onDarkBackdrop ? "space-y-6" : "space-y-4"}>
          {hotComments.length === 0 && latestComments.length === 0 && (
            <div className={`py-8 text-center text-xs ${statusTextClass}`}>当前页暂无可展示的评论</div>
          )}
          {hotComments.length > 0 && (
            <section>
              <h3 className={sectionTitleClass}>精彩评论</h3>
              <div>{hotComments.map((comment) => renderCommentCard(comment, "hot"))}</div>
            </section>
          )}

          {latestComments.length > 0 && (
            <section>
              <h3 className={sectionTitleClass}>最新评论</h3>
              <div>{latestComments.map((comment) => renderCommentCard(comment, "latest"))}</div>
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
                className={`inline-flex items-center text-xs font-medium transition-colors disabled:opacity-50 ${actionBtnClass}`}
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
                  className={`inline-flex items-center text-xs font-medium transition-colors disabled:opacity-50 ${actionBtnClass}`}
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
