import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Heart,
  ListMusic,
  Loader2,
  Maximize2,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type QualityLevel, getQualityLabel } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";
import { PlaybackProgressBar } from "./PlaybackProgressBar.js";

export function PlayerBar() {
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const volume = usePlayerStore((s) => s.volume);
  const playbackMode = usePlayerStore((s) => s.playbackMode);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const activeQualityOverride = usePlayerStore((s) => s.activeQualityOverride);
  const playerError = usePlayerStore((s) => s.playerError);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const setDrawerTab = usePlayerStore((s) => s.setDrawerTab);

  const canLike = currentTrack?.platform === "netease";
  const { data: likeData } = useQuery({
    queryKey: ["song-like", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.isSongLiked(currentTrack.platform, currentTrack.id) : { liked: false },
    enabled: Boolean(currentTrack && canLike),
  });

  const likeMutation = useMutation({
    mutationFn: (nextLiked: boolean) => {
      if (!currentTrack) throw new Error("无播放曲目");
      return api.toggleSongLike(currentTrack.platform, currentTrack.id, nextLiked);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(["song-like", currentTrack?.platform, currentTrack?.id], res);
      toast.success(res.liked ? "已加入红心喜欢" : "已取消喜欢");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "操作失败"),
  });

  const activeQuality = activeQualityOverride ?? defaultPlaybackQuality;

  return (
    <footer
      className="border-t border-[var(--tv-border)] bg-[var(--tv-surface)]/95 backdrop-blur-xl px-4 py-2.5"
      style={{ zIndex: "var(--tv-z-sticky)" }}
    >
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
        {/* Left: Track Info */}
        <div className="flex min-w-0 w-64 items-center gap-3">
          {currentTrack ? (
            <>
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="group relative shrink-0"
                title="展开全屏播放器"
              >
                <CoverArt src={currentTrack.coverUrl} alt={currentTrack.title} className="h-12 w-12" />
                <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 opacity-0 group-hover:opacity-100">
                  <Maximize2 className="h-4 w-4 text-white" />
                </span>
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-[var(--tv-text)]">
                    {currentTrack.title}
                  </span>
                  <PlatformBadge platform={currentTrack.platform} />
                </div>
                <div className="truncate text-xs text-[var(--tv-text-muted)]">
                  {playerError ? <span className="text-rose-400">{playerError}</span> : currentTrack.artist}
                </div>
              </div>
              {canLike && (
                <button
                  type="button"
                  onClick={() => likeMutation.mutate(!likeData?.liked)}
                  className={`rounded-lg p-1.5 transition-colors ${
                    likeData?.liked
                      ? "text-rose-400 hover:bg-rose-500/10"
                      : "text-[var(--tv-text-muted)] hover:bg-white/10"
                  }`}
                  title={likeData?.liked ? "取消喜欢" : "加入红心"}
                >
                  <Heart className={`h-4 w-4 ${likeData?.liked ? "fill-current" : ""}`} />
                </button>
              )}
            </>
          ) : (
            <div className="text-xs text-[var(--tv-text-subtle)]">尚未播放歌曲</div>
          )}
        </div>

        {/* Center: Controls & Progress */}
        <div className="flex flex-1 flex-col items-center gap-1">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => audioEngine.cyclePlaybackMode()}
              title={
                playbackMode === "repeat-one"
                  ? "单曲循环"
                  : playbackMode === "shuffle"
                    ? "随机播放"
                    : "列表循环"
              }
              className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-white/10 hover:text-amber-300"
            >
              {playbackMode === "repeat-one" ? (
                <Repeat1 className="h-4 w-4 text-amber-400" />
              ) : playbackMode === "shuffle" ? (
                <Shuffle className="h-4 w-4 text-amber-400" />
              ) : (
                <Repeat className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.playPrevious()}
              className="rounded-lg p-1.5 text-[var(--tv-text)] hover:bg-white/10"
              aria-label="上一首"
            >
              <SkipBack className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.togglePlay()}
              disabled={!currentTrack}
              aria-label={isPlaying ? "暂停" : "播放"}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-400 text-slate-950 shadow-lg shadow-amber-500/20 hover:bg-amber-300 disabled:opacity-40"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="h-4 w-4 fill-current ml-0.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.playNext()}
              className="rounded-lg p-1.5 text-[var(--tv-text)] hover:bg-white/10"
              aria-label="下一首"
            >
              <SkipForward className="h-4 w-4" />
            </button>

            {currentTrack && (
              <select
                aria-label="切换播放音质"
                value={activeQuality}
                onChange={(e) => void audioEngine.switchPlaybackQuality(e.target.value as QualityLevel)}
                className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface-elevated)] px-2 py-1 text-[11px] text-amber-300 focus:border-amber-400/60 focus:outline-none"
              >
                {(currentTrack.availableQualities.length > 0
                  ? currentTrack.availableQualities
                  : [{ level: "standard" as const, label: "128K" }]
                ).map((q) => (
                  <option key={q.level} value={q.level}>
                    播放 {getQualityLabel(q.level)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <PlaybackProgressBar />
        </div>

        {/* Right: Volume & Drawers */}
        <div className="hidden w-64 items-center justify-end gap-2 md:flex">
          <button
            type="button"
            onClick={() => setDrawerTab("lyrics")}
            className="rounded-lg px-2 py-1 text-xs text-[var(--tv-text-muted)] hover:bg-white/10 hover:text-[var(--tv-text)]"
          >
            词
          </button>
          <button
            type="button"
            onClick={() => setDrawerTab("comments")}
            className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-white/10 hover:text-[var(--tv-text)]"
            title="评论"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDrawerTab("queue")}
            className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-white/10 hover:text-[var(--tv-text)]"
            title="播放队列"
          >
            <ListMusic className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => audioEngine.setVolume(volume > 0 ? 0 : 0.85)}
            className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-white/10"
            aria-label="静音切换"
          >
            {volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
          <input
            type="range"
            aria-label="音量"
            min={0}
            max={1}
            step={0.02}
            value={volume}
            onChange={(e) => audioEngine.setVolume(Number(e.target.value))}
            className="w-20 accent-amber-400"
          />
        </div>
      </div>
    </footer>
  );
}
