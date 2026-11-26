import { AlertCircle, ChevronDown, FileText, ListMusic, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { sanitizeCssUrl } from "#shared";
import { AlbumLink, ArtistLinks } from "../../../entities/music/index.js";
import { useIsSongLiked, useToggleLikeMutation } from "../../../entities/song/index.js";
import { useCapabilities } from "../../../shared/hooks/use-capabilities.js";
import { useIsOverlayViewport, useModalFocusTrap } from "../../../shared/hooks/use-modal-focus-trap.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine, resolveEffectivePlaybackQuality } from "../engine/audio-engine.js";
import { useTrackLyricsQuery } from "../hooks/use-track-lyrics-query.js";
import { usePlayerStore } from "../store/player-store.js";
import {
  SfBackwardFill,
  SfForwardFill,
  SfHeart,
  SfPauseFill,
  SfPlayFill,
  SfRepeat,
  SfRepeatOne,
  SfShuffle,
  SfSpeakerMaxFill,
  SfSpeakerMinFill,
  SfSpeakerXmarkFill,
} from "./AppleMusicIcons.js";
import { LyricScroller } from "./LyricScroller.js";
import { PlaybackProgressBar } from "./PlaybackProgressBar.js";
import { PlayQueuePanel, TrackCommentsPanel } from "./PlayerDrawerPanels.js";
import { QualitySelectorPopover } from "./QualitySelectorPopover.js";
import { QuickCollectPopover } from "./QuickCollectPopover.js";

type FullscreenRightPanel = "lyrics" | "comments" | "queue";

export function FullscreenPlayer() {
  const open = usePlayerStore((s) => s.fullscreenOpen);
  const setOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queueLength = usePlayerStore((s) => s.queue.length);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLoading = usePlayerStore((s) => s.isLoading);
  const playerError = usePlayerStore((s) => s.playerError);
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const playbackMode = usePlayerStore((s) => s.playbackMode);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const preferredTrackQuality = usePlayerStore((s) => s.preferredTrackQuality);
  const loadedStreamQuality = usePlayerStore((s) => s.loadedStreamQuality);

  const [mobileShowCover, setMobileShowCover] = useState(true);
  const [rightPanel, setRightPanel] = useState<FullscreenRightPanel>("lyrics");
  const [draggingVolume, setDraggingVolume] = useState(false);
  const isMobileViewport = useIsOverlayViewport(768);
  const isRightPaneVisible = !isMobileViewport || !mobileShowCover;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const isClosingRef = useRef(false);
  const isActive = Boolean(open && currentTrack);

  useEffect(() => {
    if (!open) {
      isClosingRef.current = false;
      setMobileShowCover(true);
      setRightPanel("lyrics");
      setDraggingVolume(false);
    }
  }, [open]);

  useEffect(() => {
    if (!draggingVolume) return;
    const stopDragging = () => setDraggingVolume(false);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [draggingVolume]);

  useModalFocusTrap(dialogRef, isActive, { onClose: () => setOpen(false) });

  const handleAnimatedClose = () => {
    const el = dialogRef.current;
    const prefersReduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!el || typeof el.animate !== "function" || prefersReduced || isClosingRef.current) {
      setOpen(false);
      return;
    }
    isClosingRef.current = true;
    const anim = el.animate(
      [
        { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
        { opacity: 0, transform: "translate3d(0, 28px, 0) scale(0.985)" },
      ],
      { duration: 200, easing: "cubic-bezier(0.32, 0, 0.67, 0)", fill: "forwards" },
    );
    const finish = () => {
      isClosingRef.current = false;
      setOpen(false);
    };
    anim.onfinish = finish;
    anim.oncancel = finish;
  };

  const {
    data: lyricData,
    isLoading: lyricsLoading,
    isError: lyricIsError,
    error: lyricError,
    refetch: refetchLyrics,
  } = useTrackLyricsQuery(currentTrack, Boolean(isActive && rightPanel === "lyrics"));

  const capabilities = useCapabilities();
  const canLike = Boolean(currentTrack && capabilities[currentTrack.platform].canLikeSong);
  const { liked: isLiked } = useIsSongLiked(
    currentTrack?.platform,
    currentTrack?.id,
    Boolean(isActive && canLike),
  );

  const likeMutation = useToggleLikeMutation();

  if (!open || !currentTrack) return null;

  const safeBgUrl = sanitizeCssUrl(currentTrack.coverUrl);
  const effectiveVolume = muted ? 0 : volume;
  const volumePct = Math.round(effectiveVolume * 100);
  const activeQuality = resolveEffectivePlaybackQuality(
    currentTrack,
    loadedStreamQuality ?? preferredTrackQuality,
    defaultPlaybackQuality,
  );

  const selectPanel = (nextPanel: FullscreenRightPanel) => {
    setRightPanel(nextPanel);
    setMobileShowCover(false);
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className="tv-fullscreen-enter fixed inset-0 m-0 flex h-[100dvh] w-full max-h-none max-w-none flex-col overflow-hidden border-0 bg-[#111113] p-0 text-white"
      style={{ zIndex: "var(--tv-z-modal)" }}
      aria-label="沉浸歌词播放"
    >
      {/* Apple Music ambient blurred album artwork canvas */}
      {safeBgUrl && (
        <div
          className="pointer-events-none absolute inset-0 scale-125 bg-cover bg-center opacity-55 blur-[100px] saturate-150 transition-all duration-700"
          style={{ backgroundImage: `url("${safeBgUrl}")` }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/50 via-black/62 to-black/78" />

      {/* Top Header: borderless floating controls with translucent hover/active states */}
      <header className="tv-pt-safe relative flex shrink-0 items-center justify-between gap-2 px-4 pb-3 [--tv-safe-pt-base:0.75rem] md:px-8 md:pb-4 md:[--tv-safe-pt-base:1.25rem] [@media(max-height:500px)]:pb-1.5 [@media(max-height:500px)]:[--tv-safe-pt-base:0.375rem]">
        <button
          type="button"
          onClick={handleAnimatedClose}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/60 transition-all duration-150 hover:bg-white/10 hover:text-white/95 active:scale-95 [@media(max-height:500px)]:h-8 [@media(max-height:500px)]:w-8"
          title="收起 (Esc)"
          aria-label="收起全屏播放器"
        >
          <ChevronDown className="h-5 w-5" />
        </button>

        {/* Mobile Cover Toggle (< md) */}
        <div className="inline-flex rounded-full bg-white/[0.06] p-0.5 text-xs backdrop-blur-md md:hidden">
          <button
            type="button"
            onClick={() => setMobileShowCover(true)}
            className={`rounded-full px-3 py-1 font-medium transition-all ${
              mobileShowCover ? "bg-white/18 text-white" : "text-white/60 hover:text-white/90"
            }`}
          >
            封面
          </button>
          <button
            type="button"
            onClick={() => setMobileShowCover(false)}
            className={`rounded-full px-3 py-1 font-medium transition-all ${
              !mobileShowCover ? "bg-white/18 text-white" : "text-white/60 hover:text-white/90"
            }`}
          >
            {rightPanel === "comments" ? "评论" : rightPanel === "queue" ? "队列" : "歌词"}
          </button>
        </div>

        {/* Inline Right-Pane Switcher (borderless vibrancy) */}
        <div className="flex items-center gap-2.5">
          <span className="hidden opacity-75 md:inline-flex">
            <PlatformBadge platform={currentTrack.platform} subtle />
          </span>

          <div className="inline-flex items-center gap-0.5 rounded-full bg-white/[0.05] p-0.5 text-xs backdrop-blur-md">
            <button
              type="button"
              aria-label="查看歌词"
              aria-pressed={isRightPaneVisible && rightPanel === "lyrics"}
              onClick={() => selectPanel("lyrics")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium transition-all [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "lyrics"
                  ? "bg-white/16 text-white"
                  : "text-white/55 hover:bg-white/[0.08] hover:text-white/90"
              }`}
              title="查看歌词"
            >
              <FileText className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">歌词</span>
            </button>
            <button
              type="button"
              aria-label="查看评论"
              aria-pressed={isRightPaneVisible && rightPanel === "comments"}
              onClick={() => selectPanel("comments")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium transition-all [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "comments"
                  ? "bg-white/16 text-white"
                  : "text-white/55 hover:bg-white/[0.08] hover:text-white/90"
              }`}
              title="查看评论"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">评论</span>
            </button>
            <button
              type="button"
              aria-label="查看队列"
              aria-pressed={isRightPaneVisible && rightPanel === "queue"}
              onClick={() => selectPanel("queue")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium transition-all [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "queue"
                  ? "bg-white/16 text-white"
                  : "text-white/55 hover:bg-white/[0.08] hover:text-white/90"
              }`}
              title="查看队列"
            >
              <ListMusic className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">队列{queueLength > 0 ? ` · ${queueLength}` : ""}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area: strict Apple Music plumb-line geometry on left column + floating lyrics on right */}
      <div className="tv-pb-safe tv-subtle-scrollbar relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-y-auto px-5 [--tv-safe-pb-base:1.25rem] md:grid md:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] md:grid-rows-[auto_auto] md:content-center md:items-center md:gap-x-12 md:gap-y-5 md:px-8 md:[--tv-safe-pb-base:2rem] [@media(max-height:500px)]:[--tv-safe-pb-base:0.5rem] [@media(max-height:500px)]:md:gap-x-6 [@media(max-height:500px)]:md:gap-y-2">
        {/* Cover & Track Metadata (exact shared width with transport & timeline below) */}
        <div
          className={`mx-auto w-[min(80vw,38dvh,320px)] md:col-start-1 md:row-start-1 md:w-[min(100%,44dvh,348px)] [@media(max-height:500px)]:w-[240px] ${
            !mobileShowCover ? "hidden md:block" : "flex flex-1 flex-col justify-center md:block md:flex-none"
          }`}
        >
          <CoverArt
            src={currentTrack.coverUrl}
            alt={currentTrack.title}
            darkBackdrop
            rounded="rounded-[18px]"
            className={`aspect-square w-full ring-1 ring-white/10 transition-all duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] [@media(max-height:500px)]:mx-auto [@media(max-height:500px)]:w-[min(30dvh,120px)] [@media(max-height:500px)]:rounded-xl ${
              isPlaying
                ? "scale-100 shadow-[0_32px_88px_-12px_rgba(0,0,0,0.75)]"
                : "scale-[0.9] opacity-90 shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)]"
            }`}
          />

          <div className="mt-5 flex items-center justify-between gap-2 md:mt-6 [@media(max-height:500px)]:mt-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <h2 className="truncate text-lg font-bold tracking-tight text-white/95 sm:text-xl md:text-[21px] [@media(max-height:500px)]:text-base">
                {currentTrack.title}
              </h2>
              <p className="truncate text-xs font-medium text-white/55 md:text-[13.5px]">
                <ArtistLinks
                  platform={currentTrack.platform}
                  artists={currentTrack.artists}
                  fallbackText={currentTrack.artist}
                  primaryArtistId={currentTrack.primaryArtistId}
                  linkClassName="transition-colors hover:text-white/95"
                  onNavigate={() => setOpen(false)}
                />
                {currentTrack.album && (
                  <>
                    <span className="mx-1.5 opacity-40">—</span>
                    <AlbumLink
                      song={currentTrack}
                      className="transition-colors hover:text-white/95"
                      onNavigate={() => setOpen(false)}
                    />
                  </>
                )}
              </p>
            </div>

            {/* Pure-icon Collect + Favorite actions tucked cleanly beside song title */}
            <div className="mr-[-6px] flex shrink-0 items-center gap-0.5">
              <QuickCollectPopover song={currentTrack} variant="fullscreen" />

              {canLike && (
                <button
                  type="button"
                  onClick={() =>
                    likeMutation.mutate({
                      platform: currentTrack.platform,
                      songId: currentTrack.id,
                      nextLiked: !isLiked,
                      songTitle: currentTrack.title,
                    })
                  }
                  className={`inline-flex items-center justify-center rounded-full p-2 transition-all duration-150 hover:bg-white/10 active:scale-95 ${
                    isLiked ? "text-[#fa2d48]" : "text-white/60 hover:text-white/95"
                  }`}
                  title={isLiked ? "取消喜欢" : "喜欢"}
                  aria-label={isLiked ? "取消喜欢" : "喜欢"}
                >
                  <SfHeart filled={isLiked} className={`h-5 w-5 ${isLiked ? "tv-heart-pop" : ""}`} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel: Frameless Lyrics / Comments / Queue locked to left column top-cover & bottom-volume baselines */}
        <div
          className={`min-h-0 overflow-hidden md:relative md:col-start-2 md:row-start-1 md:row-span-2 md:self-stretch ${
            !mobileShowCover ? "flex flex-1 flex-col" : "hidden md:block"
          }`}
        >
          <div
            key={rightPanel}
            className="tv-panel-enter flex min-h-0 flex-1 flex-col md:absolute md:inset-0"
          >
            {rightPanel === "lyrics" && (
              <LyricScroller
                lines={lyricData?.lyrics.lines ?? []}
                loading={lyricsLoading}
                error={
                  lyricIsError ? (lyricError instanceof Error ? lyricError.message : "歌词加载失败") : null
                }
                onRetry={() => void refetchLyrics()}
                large
              />
            )}

            {rightPanel === "comments" && (
              <TrackCommentsPanel active={Boolean(isActive && rightPanel === "comments")} onDarkBackdrop />
            )}

            {rightPanel === "queue" && <PlayQueuePanel onDarkBackdrop />}
          </div>
        </div>

        {/* Single Mounted Apple Music Transport & Volume Block (exact same width as CoverArt above) */}
        <div className="mx-auto mt-3 w-[min(80vw,38dvh,320px)] shrink-0 space-y-3.5 md:col-start-1 md:row-start-2 md:mt-0 md:w-[min(100%,44dvh,348px)] md:space-y-4 [@media(max-height:500px)]:mt-1.5 [@media(max-height:500px)]:w-[240px] [@media(max-height:500px)]:space-y-1.5">
          {playerError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl bg-red-500/18 px-3 py-1.5 text-xs text-red-200 backdrop-blur-md"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-300" />
              <span className="truncate">{playerError}</span>
            </div>
          )}

          {/* Full-bleed progress bar flush with album cover + subtle timestamps underneath */}
          <PlaybackProgressBar compact onDarkBackdrop stackedTimestamps />

          {/* Borderless SF-Symbol Transport Row (dead-center play glyph with soft hover halo) */}
          <div className="grid grid-cols-[1fr_auto_1fr] items-center">
            <div className="justify-self-start">
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
                className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-transparent transition-all duration-150 hover:bg-white/10 active:scale-95 ${
                  playbackMode === "sequential" ? "text-white/50 hover:text-white/90" : "text-white"
                }`}
                aria-label="切换播放模式"
              >
                {playbackMode === "repeat-one" ? (
                  <SfRepeatOne className="h-[18px] w-[18px]" />
                ) : playbackMode === "shuffle" ? (
                  <SfShuffle className="h-[18px] w-[18px]" />
                ) : (
                  <SfRepeat className="h-[18px] w-[18px]" />
                )}
                {playbackMode !== "sequential" && (
                  <span
                    aria-hidden="true"
                    data-testid="playback-mode-dot"
                    className="pointer-events-none absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white/95 shadow-[0_0_6px_rgba(255,255,255,0.65)]"
                  />
                )}
              </button>
            </div>

            <div className="flex items-center gap-5 sm:gap-7">
              <button
                type="button"
                onClick={() => void audioEngine.playPrevious()}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full text-white/90 transition-all duration-150 hover:bg-white/10 hover:text-white active:scale-90 active:bg-white/15 [@media(max-height:500px)]:h-9 [@media(max-height:500px)]:w-9"
                aria-label="上一首"
              >
                <SfBackwardFill className="h-6 w-6" />
              </button>

              <button
                type="button"
                onClick={() => void audioEngine.togglePlay()}
                className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-transparent text-white/95 transition-all duration-200 hover:bg-white/10 hover:text-white active:scale-90 active:bg-white/15 [@media(max-height:500px)]:h-10 [@media(max-height:500px)]:w-10"
                aria-label={isPlaying ? "暂停" : "播放"}
              >
                {isLoading ? (
                  <Loader2 className="h-7 w-7 animate-spin text-white/85" />
                ) : isPlaying ? (
                  <SfPauseFill className="h-9 w-9 [@media(max-height:500px)]:h-7 [@media(max-height:500px)]:w-7" />
                ) : (
                  <SfPlayFill className="h-9 w-9 [@media(max-height:500px)]:h-7 [@media(max-height:500px)]:w-7" />
                )}
              </button>

              <button
                type="button"
                onClick={() => void audioEngine.playNext()}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full text-white/90 transition-all duration-150 hover:bg-white/10 hover:text-white active:scale-90 active:bg-white/15 [@media(max-height:500px)]:h-9 [@media(max-height:500px)]:w-9"
                aria-label="下一首"
              >
                <SfForwardFill className="h-6 w-6" />
              </button>
            </div>

            <div className="justify-self-end">
              <QualitySelectorPopover
                song={currentTrack}
                activeQuality={activeQuality}
                variant="fullscreen"
              />
            </div>
          </div>

          {/* Apple Music Borderless Volume Slider: small/large solid speakers + drag-only tooltip */}
          <div className="hidden items-center gap-3 pt-0.5 md:flex [@media(max-height:500px)]:hidden">
            <button
              type="button"
              onClick={() => audioEngine.toggleMute()}
              className="inline-flex shrink-0 items-center justify-center rounded-full p-1 text-white/45 transition-colors hover:text-white/85"
              aria-label={muted || effectiveVolume === 0 ? "取消静音" : "静音切换"}
            >
              {muted || effectiveVolume === 0 ? (
                <SfSpeakerXmarkFill className="h-3.5 w-3.5" />
              ) : (
                <SfSpeakerMinFill className="h-3.5 w-3.5" />
              )}
            </button>

            <div className="group relative flex h-5 flex-1 items-center">
              <div className="relative h-[3.5px] w-full overflow-hidden rounded-full bg-white/18 transition-[height] duration-150 group-hover:h-[5px]">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-white/65 transition-colors group-hover:bg-white/95"
                  style={{ width: `${volumePct}%` }}
                />
              </div>

              {draggingVolume && (
                <span
                  className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded-md bg-white/18 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white shadow-sm backdrop-blur-md"
                  style={{ left: `${volumePct}%` }}
                >
                  {volumePct}%
                </span>
              )}

              <input
                type="range"
                aria-label="全屏音量"
                min={0}
                max={1}
                step={0.01}
                value={effectiveVolume}
                onPointerDown={() => setDraggingVolume(true)}
                onBlur={() => setDraggingVolume(false)}
                onChange={(e) => audioEngine.setVolume(Number(e.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </div>

            <button
              type="button"
              onClick={() => audioEngine.setVolume(1)}
              className="inline-flex shrink-0 items-center justify-center rounded-full p-1 text-white/45 transition-colors hover:text-white/85"
              title="最大音量"
              aria-label="最大音量"
            >
              <SfSpeakerMaxFill className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
