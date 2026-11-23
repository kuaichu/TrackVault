import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ThumbsUp, Trash2, X } from "lucide-react";
import { getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { type RightDrawerTab, usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";

export function RightDrawer() {
  const queryClient = useQueryClient();
  const open = usePlayerStore((s) => s.drawerOpen);
  const tab = usePlayerStore((s) => s.drawerTab);
  const setOpen = usePlayerStore((s) => s.setDrawerOpen);
  const setTab = usePlayerStore((s) => s.setDrawerTab);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queue = usePlayerStore((s) => s.queue);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const clearQueue = usePlayerStore((s) => s.clearQueue);

  const { data: lyricData, isLoading: lyricsLoading } = useQuery({
    queryKey: ["lyrics", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.getLyrics(currentTrack.platform, currentTrack.id, currentTrack.mediaId) : null,
    enabled: Boolean(open && tab === "lyrics" && currentTrack),
  });

  const commentSongId =
    currentTrack?.platform === "qq" ? (currentTrack.providerSongId ?? currentTrack.id) : currentTrack?.id;

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ["comments", currentTrack?.platform, commentSongId],
    queryFn: () =>
      currentTrack && commentSongId ? api.getComments(currentTrack.platform, commentSongId, 1, 20) : null,
    enabled: Boolean(open && tab === "comments" && currentTrack && commentSongId),
  });

  const likeCommentMutation = useMutation({
    mutationFn: (vars: { commentId: string; liked: boolean }) => {
      if (!currentTrack || !commentSongId) throw new Error("无当前曲目");
      return api.setCommentLiked(currentTrack.platform, commentSongId, vars.commentId, vars.liked);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["comments", currentTrack?.platform, commentSongId],
      });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "评论点赞失败"),
  });

  if (!open) return null;

  const tabs: Array<{ id: RightDrawerTab; label: string }> = [
    { id: "queue", label: `队列 (${queue.length})` },
    { id: "lyrics", label: "歌词" },
    { id: "comments", label: "评论" },
  ];

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-[var(--tv-border)] bg-[var(--tv-surface)] lg:w-96">
      <div className="flex items-center justify-between border-b border-[var(--tv-border)] px-3 py-2.5">
        <div className="flex items-center gap-1">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                tab === item.id
                  ? "bg-amber-400/15 text-amber-300"
                  : "text-[var(--tv-text-muted)] hover:bg-white/5 hover:text-[var(--tv-text)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg p-1 text-[var(--tv-text-muted)] hover:bg-white/10"
          aria-label="收起侧栏"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "queue" && (
          <div className="p-3 space-y-2">
            {queue.length > 0 && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => clearQueue()}
                  className="text-xs text-[var(--tv-text-muted)] hover:text-rose-300"
                >
                  清空队列
                </button>
              </div>
            )}
            {queue.length === 0 ? (
              <div className="py-12 text-center text-xs text-[var(--tv-text-muted)]">播放队列为空</div>
            ) : (
              queue.map((song) => {
                const key = getSongKey(song);
                const isCurrent = currentTrack ? getSongKey(currentTrack) === key : false;
                return (
                  <div
                    key={key}
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 hover:bg-white/5 ${
                      isCurrent ? "bg-amber-400/10" : ""
                    }`}
                  >
                    <CoverArt src={song.coverUrl} alt={song.title} className="h-9 w-9" />
                    <button
                      type="button"
                      onClick={() => void audioEngine.playTrack(song)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className={`truncate text-xs font-medium ${isCurrent ? "text-amber-300" : ""}`}>
                        {song.title}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--tv-text-muted)]">
                        <span className="truncate">{song.artist}</span>
                        <PlatformBadge platform={song.platform} />
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFromQueue(key)}
                      className="rounded p-1 text-[var(--tv-text-subtle)] hover:text-rose-300"
                      aria-label="移出队列"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {tab === "lyrics" && <LyricScroller lines={lyricData?.lyrics.lines ?? []} loading={lyricsLoading} />}

        {tab === "comments" && (
          <div className="p-3 space-y-3">
            {!currentTrack ? (
              <div className="py-12 text-center text-xs text-[var(--tv-text-muted)]">
                先播放一首歌曲即可查看评论
              </div>
            ) : commentsLoading ? (
              <div className="py-12 text-center text-xs text-[var(--tv-text-muted)]">加载评论中...</div>
            ) : (
              <>
                {[...(commentsData?.hotComments ?? []), ...(commentsData?.comments ?? [])].map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface-elevated)] p-3 space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-[var(--tv-text)]">{comment.nickname}</span>
                      <span className="text-[11px] text-[var(--tv-text-subtle)]">{comment.timeText}</span>
                    </div>
                    <p className="text-xs leading-relaxed text-[var(--tv-text-muted)] whitespace-pre-wrap">
                      {comment.content}
                    </p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() =>
                          likeCommentMutation.mutate({ commentId: comment.id, liked: !comment.liked })
                        }
                        className={`inline-flex items-center gap-1 text-[11px] ${
                          comment.liked ? "text-amber-300" : "text-[var(--tv-text-subtle)] hover:text-white"
                        }`}
                      >
                        <ThumbsUp className="h-3 w-3" />
                        {comment.likedCount}
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
