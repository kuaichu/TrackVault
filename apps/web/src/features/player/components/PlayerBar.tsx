import { ChevronUp, Loader2, Music2 } from "lucide-react";
import type { MouseEvent } from "react";
import { ArtistLinks } from "../../../entities/music/index.js";
import { useIsSongLiked, useToggleLikeMutation } from "../../../entities/song/index.js";
import { useCapabilities } from "../../../shared/hooks/use-capabilities.js";
import { CoverArt } from "../../../shared/ui/primitives.js";
import { audioEngine, resolveEffectivePlaybackQuality } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";
import {
  SfBackwardFill,
  SfCommentBubble,
  SfForwardFill,
  SfHeart,
  SfLyricsBubble,
  SfPauseFill,
  SfPlayFill,
  SfQueueList,
  SfRepeat,
  SfRepeatOne,
  SfShuffle,
  SfSpeakerMaxFill,
  SfSpeakerMinFill,
  SfSpeakerXmarkFill,
} from "./AppleMusicIcons.js";
import { MiniProgressStripe, PlaybackProgressBar } from "./PlaybackProgressBar.js";
import { QualitySelectorPopover } from "./QualitySelectorPopover.js";
import { QuickCollectPopover } from "./QuickCollectPopover.js";

const INTERACTIVE_CHILD_SELECTOR = "button, a, input, section, [role='menu']";

export function PlayerBar() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const hasPlayableQueue = usePlayerStore((s) => s.queue.some((item) => !item.availability?.playback.locked));
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const playbackMode = usePlayerStore((s) => s.playbackMode);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const preferredTrackQuality = usePlayerStore((s) => s.preferredTrackQuality);
  const loadedStreamQuality = usePlayerStore((s) => s.loadedStreamQuality);
  const playerError = usePlayerStore((s) => s.playerError);
  const drawerOpen = usePlayerStore((s) => s.drawerOpen);
  const drawerTab = usePlayerStore((s) => s.drawerTab);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const toggleDrawerTab = usePlayerStore((s) => s.toggleDrawerTab);

  const capabilities = useCapabilities();
  const canLike = Boolean(currentTrack && capabilities[currentTrack.platform].canLikeSong);
  const { liked: isLiked } = useIsSongLiked(currentTrack?.platform, currentTrack?.id, canLike);

  const likeMutation = useToggleLikeMutation();

  const canControl = Boolean(currentTrack) || hasPlayableQueue;
  const effectiveVolume = muted ? 0 : volume;
  const volumePct = Math.round(effectiveVolume * 100);
  const activeQuality = resolveEffectivePlaybackQuality(
    currentTrack,
    loadedStreamQuality ?? preferredTrackQuality,
    defaultPlaybackQuality,
  );
  const platformText = currentTrack?.platform === "qq" ? "QQ 音乐" : "网易云";

  const handleNowPlayingRegionClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!currentTrack) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_CHILD_SELECTOR)) return;
    setFullscreenOpen(true);
  };

  return (
    <footer className="pointer-events-auto relative select-none">
      {/* Mobile Floating iOS Apple Music Mini-Player (< md): borderless shadow-elevated glass + 42px thumb targets */}
      <div
        className="relative mx-3 mb-2 flex h-[58px] items-center justify-between gap-2 rounded-[16px] border-0 bg-[var(--tv-mini-player-bg)] pr-2 pl-3 backdrop-blur-[28px] backdrop-saturate-[190%] md:hidden"
        style={{ boxShadow: "var(--tv-glass-highlight), var(--tv-mini-player-shadow)" }}
      >
        <MiniProgressStripe />

        {currentTrack ? (
          <button
            type="button"
            onClick={() => setFullscreenOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-3 py-1 text-left"
          >
            <CoverArt
              src={currentTrack.coverUrl}
              alt={currentTrack.title}
              className="h-10 w-10 shadow-sm ring-1 ring-white/10"
              rounded="rounded-[8px]"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="truncate text-[13.5px] font-semibold tracking-tight text-[var(--tv-text)]">
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
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-[var(--tv-lcd-bg)] text-[var(--tv-text-subtle)]">
              <Music2 className="h-4 w-4 opacity-60" />
            </div>
            <span className="text-xs text-[var(--tv-text-subtle)]">未在播放</span>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void audioEngine.togglePlay()}
            disabled={!canControl}
            aria-label={isPlaying ? "暂停" : "播放"}
            className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-transparent text-[var(--tv-text)] transition-all hover:bg-[var(--tv-surface-hover)] active:scale-90 disabled:opacity-35"
          >
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--tv-text-muted)]" />
            ) : isPlaying ? (
              <SfPauseFill className="h-[22px] w-[22px]" />
            ) : (
              <SfPlayFill className="h-[22px] w-[22px]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void audioEngine.playNext()}
            disabled={!canControl}
            className="inline-flex h-[42px] w-[42px] items-center justify-center rounded-full bg-transparent text-[var(--tv-text)] transition-all hover:bg-[var(--tv-surface-hover)] active:scale-90 disabled:opacity-35"
            aria-label="下一首"
          >
            <SfForwardFill className="h-[19px] w-[19px]" />
          </button>
        </div>
      </div>

      {/* Desktop Floating Liquid Glass Bar (>= md): symmetric 1fr | minmax(320px,460px) | 1fr + bottom-edge scrubber */}
      <div
        className="relative mx-auto hidden h-[74px] max-w-[1280px] grid-cols-[1fr_minmax(280px,440px)_1fr] items-center gap-4 rounded-[18px] border border-[var(--tv-glass-border)] bg-[var(--tv-glass-bg)] px-5 backdrop-blur-[28px] backdrop-saturate-[180%] lg:grid-cols-[1fr_minmax(340px,460px)_1fr] lg:gap-6 lg:px-6 md:grid"
        style={{ boxShadow: "var(--tv-glass-highlight), var(--tv-glass-shadow)" }}
      >
        {/* Left Zone: Borderless SF Symbols Transport Controls (left-anchored in 1fr) */}
        <div className="flex items-center gap-1.5 justify-self-start">
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
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 hover:bg-[var(--tv-surface-hover)] active:scale-90 ${
              playbackMode === "sequential"
                ? "text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                : "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
            }`}
          >
            {playbackMode === "repeat-one" ? (
              <SfRepeatOne className="h-[15px] w-[15px]" />
            ) : playbackMode === "shuffle" ? (
              <SfShuffle className="h-[15px] w-[15px]" />
            ) : (
              <SfRepeat className="h-[15px] w-[15px]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void audioEngine.playPrevious()}
            disabled={!canControl}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tv-text)] opacity-85 transition-all duration-150 hover:bg-[var(--tv-surface-hover)] hover:opacity-100 active:scale-90 disabled:opacity-30"
            aria-label="上一首"
          >
            <SfBackwardFill className="h-[19px] w-[19px]" />
          </button>

          <button
            type="button"
            onClick={() => void audioEngine.togglePlay()}
            disabled={!canControl}
            aria-label={isPlaying ? "暂停" : "播放"}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-[var(--tv-text)] transition-all duration-150 hover:bg-[var(--tv-surface-hover)] active:scale-90 active:bg-[var(--tv-surface-active)] disabled:opacity-30"
          >
            {isLoading ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--tv-text-muted)]" />
            ) : isPlaying ? (
              <SfPauseFill className="h-[25px] w-[25px]" />
            ) : (
              <SfPlayFill className="h-[25px] w-[25px]" />
            )}
          </button>

          <button
            type="button"
            onClick={() => void audioEngine.playNext()}
            disabled={!canControl}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tv-text)] opacity-85 transition-all duration-150 hover:bg-[var(--tv-surface-hover)] hover:opacity-100 active:scale-90 disabled:opacity-30"
            aria-label="下一首"
          >
            <SfForwardFill className="h-[19px] w-[19px]" />
          </button>
        </div>

        {/* Center Zone: Strictly Centered 2-Line Now Playing + Vertically Centered Actions (zero vertical crunch) */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: inner cover/title buttons provide full keyboard activation */}
        <div
          onClick={handleNowPlayingRegionClick}
          className={`group/lcd flex w-full items-center gap-3.5 justify-self-center rounded-[13px] px-2.5 py-1.5 transition-colors duration-150 ${
            currentTrack ? "cursor-pointer hover:bg-[var(--tv-np-hover)]" : ""
          }`}
        >
          {currentTrack ? (
            <>
              <button
                type="button"
                onClick={() => setFullscreenOpen(true)}
                className="group/cover relative shrink-0 overflow-hidden rounded-[9px] shadow-sm"
                title="展开全屏歌词"
                aria-label="展开全屏播放器"
              >
                <CoverArt
                  src={currentTrack.coverUrl}
                  alt={currentTrack.title}
                  className="h-[46px] w-[46px]"
                  rounded="rounded-[9px]"
                />
                <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 backdrop-blur-[1px] transition-opacity duration-150 group-hover/lcd:opacity-100">
                  <ChevronUp className="h-4 w-4 text-white/95" />
                </span>
              </button>

              <div className="min-w-0 flex-1 space-y-1 text-left">
                <button
                  type="button"
                  onClick={() => setFullscreenOpen(true)}
                  className="block w-full truncate text-left text-[13.5px] leading-snug font-semibold tracking-tight text-[var(--tv-text)]"
                >
                  {currentTrack.title}
                </button>

                <div className="truncate text-[11.5px] leading-snug text-[var(--tv-text-muted)]">
                  {playerError ? (
                    <span className="text-[var(--tv-danger)]">{playerError}</span>
                  ) : (
                    <>
                      <ArtistLinks
                        platform={currentTrack.platform}
                        artists={currentTrack.artists}
                        fallbackText={currentTrack.artist}
                        primaryArtistId={currentTrack.primaryArtistId}
                        linkClassName="transition-colors hover:text-[var(--tv-text)]"
                      />
                      <span className="mx-1.5 opacity-40">·</span>
                      <span className="text-[11px] text-[var(--tv-text-subtle)]">{platformText}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Vertically centered Collect + Heart actions */}
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation guard wrapper for child buttons */}
              <div className="flex shrink-0 items-center gap-0.5 pl-1" onClick={(e) => e.stopPropagation()}>
                <QuickCollectPopover song={currentTrack} variant="player-bar" />

                {canLike && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      likeMutation.mutate({
                        platform: currentTrack.platform,
                        songId: currentTrack.id,
                        nextLiked: !isLiked,
                        songTitle: currentTrack.title,
                      });
                    }}
                    className={`inline-flex items-center justify-center rounded-full p-1.5 transition-all duration-150 active:scale-95 ${
                      isLiked
                        ? "text-[var(--tv-accent)]"
                        : "text-[var(--tv-text-subtle)] opacity-75 group-hover/lcd:opacity-100 hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
                    }`}
                    title={isLiked ? "取消喜欢" : "喜欢"}
                    aria-label={isLiked ? "取消喜欢" : "喜欢"}
                  >
                    <SfHeart
                      filled={isLiked}
                      className={`h-[16px] w-[16px] ${isLiked ? "tv-heart-pop" : ""}`}
                    />
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="flex w-full items-center gap-3.5">
              <div className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[9px] bg-[var(--tv-lcd-bg)] text-[var(--tv-text-subtle)]">
                <Music2 className="h-4 w-4 opacity-50" />
              </div>
              <span className="text-xs font-medium text-[var(--tv-text-subtle)]">未在播放</span>
            </div>
          )}
        </div>

        {/* Right Zone: Slimmed-down Tool Cluster (right-anchored in 1fr) */}
        <div className="flex items-center justify-self-end gap-1">
          {currentTrack && (
            <QualitySelectorPopover song={currentTrack} activeQuality={activeQuality} variant="player-bar" />
          )}

          <button
            type="button"
            onClick={() => toggleDrawerTab("lyrics")}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 ${
              drawerOpen && drawerTab === "lyrics"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="歌词"
            aria-label="歌词"
          >
            <SfLyricsBubble className="h-[17px] w-[17px]" />
          </button>

          <button
            type="button"
            onClick={() => toggleDrawerTab("comments")}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 ${
              drawerOpen && drawerTab === "comments"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="评论"
            aria-label="歌曲评论"
          >
            <SfCommentBubble className="h-[17px] w-[17px]" />
          </button>

          <button
            type="button"
            onClick={() => toggleDrawerTab("queue")}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-all duration-150 ${
              drawerOpen && drawerTab === "queue"
                ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                : "text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`}
            title="播放队列"
            aria-label="播放队列"
          >
            <SfQueueList className="h-[17px] w-[17px]" />
          </button>

          <div className="ml-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => audioEngine.toggleMute()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
              aria-label={muted || effectiveVolume === 0 ? "取消静音" : "静音切换"}
            >
              {muted || effectiveVolume === 0 ? (
                <SfSpeakerXmarkFill className="h-3.5 w-3.5" />
              ) : effectiveVolume < 0.45 ? (
                <SfSpeakerMinFill className="h-3.5 w-3.5" />
              ) : (
                <SfSpeakerMaxFill className="h-3.5 w-3.5" />
              )}
            </button>

            <div className="group/vol relative flex h-5 w-[72px] items-center lg:w-[76px]">
              <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-[var(--tv-slider-track)] transition-[height] duration-150 group-hover/vol:h-[4.5px]">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[var(--tv-slider-fill-muted)] transition-colors group-hover/vol:bg-[var(--tv-slider-fill)]"
                  style={{ width: `${volumePct}%` }}
                />
              </div>
              <div
                className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--tv-text)] opacity-0 shadow-xs transition-opacity duration-150 group-hover/vol:opacity-100"
                style={{ left: `${volumePct}%` }}
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

        {/* Full-Capsule Bottom-Edge Scrubber (liberates middle vertical space completely) */}
        <PlaybackProgressBar variant="lcd" />
      </div>
    </footer>
  );
}
