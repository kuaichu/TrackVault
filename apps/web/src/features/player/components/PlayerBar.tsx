import { useQuery } from "@tanstack/react-query";
import {
  ChevronUp,
  Heart,
  ListMusic,
  Loader2,
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
import { useEffect, useState } from "react";
import { type QualityLevel, getQualityLabel } from "#shared";
import { ArtistLinks } from "../../../entities/music/EntityLinks.js";
import { api } from "../../../shared/api/endpoints.js";
import { useCapabilities } from "../../../shared/hooks/use-capabilities.js";
import { useToggleLikeMutation } from "../../../shared/hooks/use-toggle-like.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine, resolveEffectivePlaybackQuality } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";
import { MiniProgressStripe, PlaybackProgressBar } from "./PlaybackProgressBar.js";

export function PlayerBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const hasPlayableQueue = usePlayerStore((s) => s.queue.some((item) => !item.availability?.playback.locked));
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const playbackMode = usePlayerStore((s) => s.playbackMode);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const activeQualityOverride = usePlayerStore((s) => s.activeQualityOverride);
  const playerError = usePlayerStore((s) => s.playerError);
  const drawerOpen = usePlayerStore((s) => s.drawerOpen);
  const drawerTab = usePlayerStore((s) => s.drawerTab);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const toggleDrawerTab = usePlayerStore((s) => s.toggleDrawerTab);

  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);

  useEffect(() => {
    if (!qualityMenuOpen) return;
    const onPointerDown = () => setQualityMenuOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [qualityMenuOpen]);

  const capabilities = useCapabilities();
  const canLike = Boolean(currentTrack && capabilities[currentTrack.platform].canLikeSong);
  const { data: likeData } = useQuery({
    queryKey: ["song-like", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.isSongLiked(currentTrack.platform, currentTrack.id) : { liked: false },
    enabled: Boolean(currentTrack && canLike),
  });

  const likeMutation = useToggleLikeMutation();

  const canControl = Boolean(currentTrack) || hasPlayableQueue;
  const effectiveVolume = muted ? 0 : volume;
  const activeQuality = resolveEffectivePlaybackQuality(
    currentTrack,
    activeQualityOverride,
    defaultPlaybackQuality,
  );
  const availableQualities =
    currentTrack && currentTrack.availableQualities.length > 0
      ? currentTrack.availableQualities
      : [{ level: "standard" as const, label: "128K" }];

  return (
    <footer
      className="relative shrink-0 border-t border-[var(--tv-border)] bg-[var(--tv-player-bg)] backdrop-blur-2xl select-none"
      style={{ zIndex: "var(--tv-z-sticky)" }}
    >
      {/* Mobile Mini Player Bar (< md) */}
      <div className="relative flex h-[58px] items-center justify-between gap-2.5 px-3.5 md:hidden">
        <MiniProgressStripe />

        {currentTrack ? (
          <button
            type="button"
            onClick={() => setFullscreenOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          >
            <CoverArt
              src={currentTrack.coverUrl}
              alt={currentTrack.title}
              className="h-10 w-10 shadow-sm"
              rounded="rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-[var(--tv-text)]">
                {currentTrack.title}
              </div>
              <div className="truncate text-[11.5px] text-[var(--tv-text-muted)]">
                {playerError ? (
                  <span className="text-[var(--tv-danger)]">{playerError}</span>
                ) : (
                  currentTrack.artist
                )}
              </div>
            </div>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-[var(--tv-surface)]" />
            <span className="text-xs text-[var(--tv-text-subtle)]">未在播放</span>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-1">
          {canLike && currentTrack && (
            <button
              type="button"
              onClick={() =>
                likeMutation.mutate({
                  platform: currentTrack.platform,
                  songId: currentTrack.id,
                  nextLiked: !likeData?.liked,
                })
              }
              className={`rounded-full p-2 transition-colors ${
                likeData?.liked ? "text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)]"
              }`}
              aria-label={likeData?.liked ? "取消喜欢" : "喜欢"}
            >
              <Heart className={`h-4 w-4 ${likeData?.liked ? "fill-current" : ""}`} />
            </button>
          )}

          <button
            type="button"
            onClick={() => void audioEngine.togglePlay()}
            disabled={!canControl}
            aria-label={isPlaying ? "暂停" : "播放"}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--tv-contrast-bg)] text-[var(--tv-contrast-fg)] active:scale-95 disabled:opacity-35"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isPlaying ? (
              <Pause className="h-4 w-4 fill-current" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void audioEngine.playNext()}
            disabled={!canControl}
            className="rounded-full p-2 text-[var(--tv-text)] disabled:opacity-35"
            aria-label="下一首"
          >
            <SkipForward className="h-4 w-4 fill-current" />
          </button>

          <button
            type="button"
            onClick={() => toggleDrawerTab("queue")}
            className={`rounded-full p-2 ${
              drawerOpen && drawerTab === "queue" ? "text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)]"
            }`}
            aria-label="播放队列"
          >
            <ListMusic className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Desktop 3-Column Player Bar (>= md) */}
      <div className="mx-auto hidden h-[76px] max-w-[1680px] grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)_minmax(0,1fr)] items-center gap-4 px-5 md:grid">
        {/* Left: Cover + Track Info + Like */}
        <div className="flex min-w-0 items-center gap-3">
          {currentTrack ? (
            <>
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="group relative shrink-0 overflow-hidden rounded-lg shadow-sm"
                title="展开全屏歌词"
                aria-label="展开全屏播放器"
              >
                <CoverArt
                  src={currentTrack.coverUrl}
                  alt={currentTrack.title}
                  className="h-12 w-12"
                  rounded="rounded-lg"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                  <ChevronUp className="h-5 w-5 text-white" />
                </span>
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFullscreenOpen(true)}
                    className="truncate text-left text-[13.5px] font-semibold text-[var(--tv-text)] hover:underline"
                  >
                    {currentTrack.title}
                  </button>
                  <PlatformBadge platform={currentTrack.platform} subtle />
                </div>
                <div className="mt-0.5 truncate text-xs text-[var(--tv-text-muted)]">
                  {playerError ? (
                    <span className="text-[var(--tv-danger)]">{playerError}</span>
                  ) : (
                    <ArtistLinks
                      platform={currentTrack.platform}
                      artists={currentTrack.artists}
                      fallbackText={currentTrack.artist}
                      primaryArtistId={currentTrack.primaryArtistId}
                    />
                  )}
                </div>
              </div>

              {canLike && (
                <button
                  type="button"
                  onClick={() =>
                    likeMutation.mutate({
                      platform: currentTrack.platform,
                      songId: currentTrack.id,
                      nextLiked: !likeData?.liked,
                    })
                  }
                  className={`rounded-full p-1.5 transition-colors ${
                    likeData?.liked
                      ? "text-[var(--tv-accent)]"
                      : "text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                  }`}
                  title={likeData?.liked ? "取消喜欢" : "喜欢"}
                  aria-label={likeData?.liked ? "取消喜欢" : "喜欢"}
                >
                  <Heart className={`h-4 w-4 ${likeData?.liked ? "fill-current" : ""}`} />
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-lg bg-[var(--tv-surface)]" />
              <div className="text-xs text-[var(--tv-text-subtle)]">未在播放</div>
            </div>
          )}
        </div>

        {/* Center: Clean Monochrome Transport + Tactile Progress */}
        <div className="flex flex-col items-center justify-center gap-1">
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
              aria-label="切换播放模式"
              className={`rounded-full p-1.5 transition-colors hover:bg-[var(--tv-surface-hover)] ${
                playbackMode === "sequential"
                  ? "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                  : "text-[var(--tv-accent)]"
              }`}
            >
              {playbackMode === "repeat-one" ? (
                <Repeat1 className="h-4 w-4" />
              ) : playbackMode === "shuffle" ? (
                <Shuffle className="h-4 w-4" />
              ) : (
                <Repeat className="h-4 w-4" />
              )}
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.playPrevious()}
              disabled={!canControl}
              className="rounded-full p-1.5 text-[var(--tv-text)] transition-colors hover:bg-[var(--tv-surface-hover)] disabled:opacity-35"
              aria-label="上一首"
            >
              <SkipBack className="h-4 w-4 fill-current" />
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.togglePlay()}
              disabled={!canControl}
              aria-label={isPlaying ? "暂停" : "播放"}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--tv-contrast-bg)] text-[var(--tv-contrast-fg)] transition-transform hover:scale-105 hover:bg-[var(--tv-contrast-bg-hover)] active:scale-95 disabled:opacity-35"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4 fill-current" />
              ) : (
                <Play className="ml-0.5 h-4 w-4 fill-current" />
              )}
            </button>

            <button
              type="button"
              onClick={() => void audioEngine.playNext()}
              disabled={!canControl}
              className="rounded-full p-1.5 text-[var(--tv-text)] transition-colors hover:bg-[var(--tv-surface-hover)] disabled:opacity-35"
              aria-label="下一首"
            >
              <SkipForward className="h-4 w-4 fill-current" />
            </button>

            {currentTrack && (
              <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => setQualityMenuOpen((v) => !v)}
                  className="rounded border border-[var(--tv-border-strong)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--tv-text-muted)] transition-colors hover:border-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                  title="切换试听音质"
                >
                  {getQualityLabel(activeQuality)}
                </button>
                {qualityMenuOpen && (
                  <div
                    className="absolute bottom-full left-1/2 mb-2 w-32 -translate-x-1/2 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] p-1 shadow-xl"
                    style={{ zIndex: "var(--tv-z-dropdown)" }}
                  >
                    <div className="px-2 py-1 text-[10px] font-medium text-[var(--tv-text-subtle)]">
                      试听音质
                    </div>
                    {availableQualities.map((q) => (
                      <button
                        key={q.level}
                        type="button"
                        onClick={() => {
                          setQualityMenuOpen(false);
                          void audioEngine.switchPlaybackQuality(q.level as QualityLevel);
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--tv-surface-hover)] ${
                          q.level === activeQuality
                            ? "font-semibold text-[var(--tv-accent)]"
                            : "text-[var(--tv-text)]"
                        }`}
                      >
                        <span>{q.label}</span>
                        {q.level === activeQuality && (
                          <span className="h-1.5 w-1.5 rounded-full bg-[var(--tv-accent)]" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <PlaybackProgressBar />
        </div>

        {/* Right: Lyrics / Comments / Queue + Sleek Volume */}
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => toggleDrawerTab("lyrics")}
            className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
              drawerOpen && drawerTab === "lyrics"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="歌词"
          >
            词
          </button>

          <button
            type="button"
            onClick={() => toggleDrawerTab("comments")}
            className={`rounded-md p-1.5 transition-colors ${
              drawerOpen && drawerTab === "comments"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="评论"
            aria-label="歌曲评论"
          >
            <MessageSquare className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => toggleDrawerTab("queue")}
            className={`rounded-md p-1.5 transition-colors ${
              drawerOpen && drawerTab === "queue"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="播放队列"
            aria-label="播放队列"
          >
            <ListMusic className="h-4 w-4" />
          </button>

          <div className="ml-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => audioEngine.toggleMute()}
              className="rounded-md p-1.5 text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
              aria-label={muted || effectiveVolume === 0 ? "取消静音" : "静音切换"}
            >
              {muted || effectiveVolume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <div className="group relative flex h-5 w-20 items-center lg:w-24">
              <div className="relative h-[4px] w-full overflow-hidden rounded-full bg-[var(--tv-border-strong)]">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[var(--tv-text-muted)] transition-colors group-hover:bg-[var(--tv-accent)]"
                  style={{ width: `${Math.round(effectiveVolume * 100)}%` }}
                />
              </div>
              <div
                className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--tv-text)] opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100"
                style={{ left: `${Math.round(effectiveVolume * 100)}%` }}
              />
              <input
                type="range"
                aria-label="音量"
                min={0}
                max={1}
                step={0.02}
                value={effectiveVolume}
                onChange={(e) => audioEngine.setVolume(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
