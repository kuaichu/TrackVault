import {
  AlertCircle,
  ChevronDown,
  FileText,
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
import { useEffect, useRef, useState } from "react";
import { type QualityLevel, getQualityLabel, sanitizeCssUrl } from "#shared";
import { AlbumLink, ArtistLinks } from "../../../entities/music/index.js";
import { useIsSongLiked, useToggleLikeMutation } from "../../../entities/song/index.js";
import { useCapabilities } from "../../../shared/hooks/use-capabilities.js";
import { useIsOverlayViewport, useModalFocusTrap } from "../../../shared/hooks/use-modal-focus-trap.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine, resolveEffectivePlaybackQuality } from "../engine/audio-engine.js";
import { useTrackLyricsQuery } from "../hooks/use-track-lyrics-query.js";
import { usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";
import { PlaybackProgressBar } from "./PlaybackProgressBar.js";
import { PlayQueuePanel, TrackCommentsPanel } from "./PlayerDrawerPanels.js";

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
  const isMobileViewport = useIsOverlayViewport(768);
  const isRightPaneVisible = !isMobileViewport || !mobileShowCover;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const isActive = Boolean(open && currentTrack);

  useEffect(() => {
    if (!open) {
      setMobileShowCover(true);
      setRightPanel("lyrics");
    }
  }, [open]);

  useModalFocusTrap(dialogRef, isActive, { onClose: () => setOpen(false) });

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
  const activeQuality = resolveEffectivePlaybackQuality(
    currentTrack,
    loadedStreamQuality ?? preferredTrackQuality,
    defaultPlaybackQuality,
  );
  const availableQualities =
    currentTrack.availableQualities.length > 0
      ? currentTrack.availableQualities
      : [{ level: "standard" as const, label: "128K" }];

  const cycleQuality = () => {
    const idx = availableQualities.findIndex((q) => q.level === activeQuality);
    const next = availableQualities[(idx + 1) % availableQualities.length];
    if (next) void audioEngine.switchPlaybackQuality(next.level as QualityLevel);
  };

  const selectPanel = (nextPanel: FullscreenRightPanel) => {
    setRightPanel(nextPanel);
    setMobileShowCover(false);
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className="fixed inset-0 m-0 flex h-[100dvh] w-full max-h-none max-w-none flex-col overflow-hidden border-0 bg-[#111113] p-0 text-white"
      style={{ zIndex: "var(--tv-z-modal)" }}
      aria-label="沉浸歌词播放"
    >
      {/* Apple Music / YesPlayMusic ambient album cover backdrop */}
      {safeBgUrl && (
        <div
          className="pointer-events-none absolute inset-0 scale-125 bg-cover bg-center opacity-50 blur-[90px] saturate-150"
          style={{ backgroundImage: `url("${safeBgUrl}")` }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/55 via-black/65 to-black/80" />

      {/* Top Header with Mobile Cover/Content Switcher + Inline Lyrics/Comments/Queue Switcher */}
      <header className="tv-pt-safe relative flex shrink-0 items-center justify-between gap-2 px-4 pb-3 [--tv-safe-pt-base:0.75rem] md:px-8 md:pb-4 md:[--tv-safe-pt-base:1.25rem] [@media(max-height:500px)]:pb-1.5 [@media(max-height:500px)]:[--tv-safe-pt-base:0.375rem]">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/85 backdrop-blur-md transition-colors hover:bg-white/20 [@media(max-height:500px)]:h-8 [@media(max-height:500px)]:w-8"
          title="收起 (Esc)"
          aria-label="收起全屏播放器"
        >
          <ChevronDown className="h-5 w-5" />
        </button>

        {/* Mobile Cover Toggle (< md) */}
        <div className="inline-flex rounded-full bg-white/10 p-0.5 text-xs backdrop-blur-md md:hidden">
          <button
            type="button"
            onClick={() => setMobileShowCover(true)}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              mobileShowCover ? "bg-white text-[#111113]" : "text-white/75"
            }`}
          >
            封面
          </button>
          <button
            type="button"
            onClick={() => setMobileShowCover(false)}
            className={`rounded-full px-3 py-1 font-medium transition-colors ${
              !mobileShowCover ? "bg-white text-[#111113]" : "text-white/75"
            }`}
          >
            {rightPanel === "comments" ? "评论" : rightPanel === "queue" ? "队列" : "歌词"}
          </button>
        </div>

        {/* Inline Right-Pane Switcher (stays inside FullscreenPlayer without kicking user back to main page) */}
        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex">
            <PlatformBadge platform={currentTrack.platform} subtle />
          </span>

          <div className="inline-flex items-center rounded-full bg-white/10 p-0.5 text-xs backdrop-blur-md">
            <button
              type="button"
              aria-label="查看歌词"
              aria-pressed={isRightPaneVisible && rightPanel === "lyrics"}
              onClick={() => selectPanel("lyrics")}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium transition-colors [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "lyrics"
                  ? "bg-white text-[#111113] shadow-xs"
                  : "text-white/80 hover:bg-white/15 hover:text-white"
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
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium transition-colors [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "comments"
                  ? "bg-white text-[#111113] shadow-xs"
                  : "text-white/80 hover:bg-white/15 hover:text-white"
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
              className={`inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 font-medium transition-colors [@media(max-height:500px)]:h-7 ${
                isRightPaneVisible && rightPanel === "queue"
                  ? "bg-white text-[#111113] shadow-xs"
                  : "text-white/80 hover:bg-white/15 hover:text-white"
              }`}
              title="查看队列"
            >
              <ListMusic className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">队列{queueLength > 0 ? ` · ${queueLength}` : ""}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area: single-mounted transport controls + height-safe responsive layout with scroll fallback */}
      <div className="tv-pb-safe relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-y-auto px-5 [--tv-safe-pb-base:1.25rem] md:grid md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] md:grid-rows-[auto_auto] md:content-center md:items-center md:gap-x-10 md:gap-y-4 md:px-8 md:[--tv-safe-pb-base:2rem] [@media(max-height:500px)]:[--tv-safe-pb-base:0.5rem] [@media(max-height:500px)]:md:gap-x-6 [@media(max-height:500px)]:md:gap-y-2">
        {/* Cover & Track Metadata (Col 1, Row 1 on md+; hidden on mobile when viewing lyrics/comments/queue) */}
        <div
          className={`mx-auto w-full max-w-[340px] md:col-start-1 md:row-start-1 md:max-w-[360px] ${
            !mobileShowCover ? "hidden md:block" : "flex flex-1 flex-col justify-center md:block md:flex-none"
          }`}
        >
          <CoverArt
            src={currentTrack.coverUrl}
            alt={currentTrack.title}
            darkBackdrop
            rounded="rounded-2xl"
            className={`mx-auto aspect-square w-[min(70vw,36dvh,260px)] shadow-[0_28px_80px_rgba(0,0,0,0.65)] transition-transform duration-500 md:w-[min(100%,40dvh,340px)] [@media(max-height:500px)]:w-[min(30dvh,120px)] [@media(max-height:500px)]:rounded-xl ${
              isPlaying ? "scale-100" : "scale-[0.94] opacity-90"
            }`}
          />

          <div className="mt-4 flex items-start justify-between gap-3 md:mt-5 [@media(max-height:500px)]:mt-2">
            <div className="min-w-0 flex-1 space-y-0.5 sm:space-y-1">
              <h2 className="truncate text-lg font-bold tracking-tight text-white sm:text-xl md:text-2xl [@media(max-height:500px)]:text-base">
                {currentTrack.title}
              </h2>
              <p className="truncate text-xs text-white/65 md:text-sm">
                <ArtistLinks
                  platform={currentTrack.platform}
                  artists={currentTrack.artists}
                  fallbackText={currentTrack.artist}
                  primaryArtistId={currentTrack.primaryArtistId}
                  linkClassName="hover:text-white hover:underline"
                  onNavigate={() => setOpen(false)}
                />
                {currentTrack.album && (
                  <>
                    <span className="mx-1.5 opacity-50">—</span>
                    <AlbumLink
                      song={currentTrack}
                      className="hover:text-white hover:underline"
                      onNavigate={() => setOpen(false)}
                    />
                  </>
                )}
              </p>
            </div>

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
                className={`mt-0.5 shrink-0 rounded-full p-2 transition-colors hover:bg-white/10 ${
                  isLiked ? "text-[#fa2d48]" : "text-white/70"
                }`}
                aria-label={isLiked ? "取消喜欢" : "喜欢"}
              >
                <Heart className={`h-5 w-5 ${isLiked ? "fill-current" : ""}`} />
              </button>
            )}
          </div>
        </div>

        {/* Right Panel: Lyrics / Comments / Queue (Col 2, spanning Rows 1-2 on md+; fills mobile height when !mobileShowCover) */}
        <div
          className={`min-h-0 overflow-hidden md:col-start-2 md:row-start-1 md:row-span-2 md:h-[min(66dvh,calc(100dvh-96px))] ${
            !mobileShowCover ? "flex flex-1 flex-col" : "hidden md:flex md:flex-col"
          }`}
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
            <div className="flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/25 backdrop-blur-md">
              <TrackCommentsPanel active={Boolean(isActive && rightPanel === "comments")} onDarkBackdrop />
            </div>
          )}

          {rightPanel === "queue" && (
            <div className="flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/25 backdrop-blur-md">
              <PlayQueuePanel onDarkBackdrop />
            </div>
          )}
        </div>

        {/* Single Mounted Transport Controls (Col 1, Row 2 on md+; pinned bottom on mobile for all views) */}
        <div className="mx-auto mt-3 w-full max-w-[340px] shrink-0 space-y-3 md:col-start-1 md:row-start-2 md:mt-0 md:max-w-[360px] md:space-y-4 [@media(max-height:500px)]:mt-1.5 [@media(max-height:500px)]:space-y-1.5">
          {playerError && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-500/15 px-3 py-1.5 text-xs text-red-200"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-300" />
              <span className="truncate">{playerError}</span>
            </div>
          )}

          <PlaybackProgressBar compact onDarkBackdrop />

          <div className="flex items-center justify-between">
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
              className="rounded-full p-2 text-white/65 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="切换播放模式"
            >
              {playbackMode === "repeat-one" ? (
                <Repeat1 className="h-4 w-4 text-white" />
              ) : playbackMode === "shuffle" ? (
                <Shuffle className="h-4 w-4 text-white" />
              ) : (
                <Repeat className="h-4 w-4" />
              )}
            </button>

            <div className="flex items-center gap-4 sm:gap-5">
              <button
                type="button"
                onClick={() => void audioEngine.playPrevious()}
                className="rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 sm:p-2.5"
                aria-label="上一首"
              >
                <SkipBack className="h-5 w-5 fill-current" />
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.togglePlay()}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#111113] shadow-xl transition-transform hover:scale-105 active:scale-95 md:h-13 md:w-13 [@media(max-height:500px)]:h-10 [@media(max-height:500px)]:w-10"
                aria-label={isPlaying ? "暂停" : "播放"}
              >
                {isLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : isPlaying ? (
                  <Pause className="h-5 w-5 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-5 w-5 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.playNext()}
                className="rounded-full p-2 text-white/85 transition-colors hover:bg-white/10 sm:p-2.5"
                aria-label="下一首"
              >
                <SkipForward className="h-5 w-5 fill-current" />
              </button>
            </div>

            <button
              type="button"
              onClick={cycleQuality}
              className="rounded border border-white/25 px-1.5 py-0.5 text-[10px] font-semibold text-white/80 hover:border-white/50 hover:text-white"
              title="点击切换音质"
            >
              {getQualityLabel(activeQuality)}
            </button>
          </div>

          {/* Desktop Volume Control inside Fullscreen Player */}
          <div className="hidden items-center gap-2.5 pt-1 md:flex [@media(max-height:500px)]:hidden">
            <button
              type="button"
              onClick={() => audioEngine.toggleMute()}
              className="rounded-full p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
              aria-label={muted || effectiveVolume === 0 ? "取消静音" : "静音切换"}
            >
              {muted || effectiveVolume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
            <div className="group relative flex h-5 flex-1 items-center">
              <div className="relative h-[4px] w-full overflow-hidden rounded-full bg-white/20">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-white/75 transition-colors group-hover:bg-white"
                  style={{ width: `${Math.round(effectiveVolume * 100)}%` }}
                />
              </div>
              <input
                type="range"
                aria-label="全屏音量"
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
    </dialog>
  );
}
