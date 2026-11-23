import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Heart,
  ListMusic,
  MessageSquare,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type QualityLevel, getQualityLabel, sanitizeCssUrl } from "#shared";
import { AlbumLink, ArtistLinks } from "../../../entities/music/EntityLinks.js";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";
import { PlaybackProgressBar } from "./PlaybackProgressBar.js";

export function FullscreenPlayer() {
  const queryClient = useQueryClient();
  const open = usePlayerStore((s) => s.fullscreenOpen);
  const setOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const setDrawerTab = usePlayerStore((s) => s.setDrawerTab);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackMode = usePlayerStore((s) => s.playbackMode);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const activeQualityOverride = usePlayerStore((s) => s.activeQualityOverride);

  const [mobileView, setMobileView] = useState<"cover" | "lyrics">("cover");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

  const { data: lyricData, isLoading } = useQuery({
    queryKey: ["lyrics", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.getLyrics(currentTrack.platform, currentTrack.id, currentTrack.mediaId) : null,
    enabled: Boolean(open && currentTrack),
  });

  const canLike = currentTrack?.platform === "netease";
  const { data: likeData } = useQuery({
    queryKey: ["song-like", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.isSongLiked(currentTrack.platform, currentTrack.id) : { liked: false },
    enabled: Boolean(open && currentTrack && canLike),
  });

  const likeMutation = useMutation({
    mutationFn: (nextLiked: boolean) => {
      if (!currentTrack) throw new Error("无播放曲目");
      return api.toggleSongLike(currentTrack.platform, currentTrack.id, nextLiked);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(["song-like", currentTrack?.platform, currentTrack?.id], res);
      if (currentTrack?.platform === "netease") {
        queryClient.setQueryData<{ ids: string[] }>(["liked-ids", "netease"], (prev) => {
          const next = new Set(prev?.ids ?? []);
          if (res.liked) next.add(currentTrack.id);
          else next.delete(currentTrack.id);
          return { ids: [...next] };
        });
      }
      toast.success(res.liked ? "已喜欢" : "已取消喜欢");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "操作失败"),
  });

  if (!open || !currentTrack) return null;

  const safeBgUrl = sanitizeCssUrl(currentTrack.coverUrl);
  const activeQuality = activeQualityOverride ?? defaultPlaybackQuality;
  const availableQualities =
    currentTrack.availableQualities.length > 0
      ? currentTrack.availableQualities
      : [{ level: "standard" as const, label: "128K" }];

  const cycleQuality = () => {
    const idx = availableQualities.findIndex((q) => q.level === activeQuality);
    const next = availableQualities[(idx + 1) % availableQualities.length];
    if (next) void audioEngine.switchPlaybackQuality(next.level as QualityLevel);
  };

  return (
    <dialog
      open
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

      {/* Top Header with Mobile Cover/Lyrics Switcher */}
      <header className="tv-pt-safe relative flex items-center justify-between px-4 py-3.5 md:px-8 md:py-5">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/85 backdrop-blur-md transition-colors hover:bg-white/20"
          title="收起 (Esc)"
          aria-label="收起全屏播放器"
        >
          <ChevronDown className="h-5 w-5" />
        </button>

        {/* Mobile View Switcher */}
        <div className="inline-flex rounded-full bg-white/10 p-0.5 text-xs backdrop-blur-md md:hidden">
          <button
            type="button"
            onClick={() => setMobileView("cover")}
            className={`rounded-full px-3.5 py-1 font-medium transition-colors ${
              mobileView === "cover" ? "bg-white text-[#111113]" : "text-white/75"
            }`}
          >
            封面
          </button>
          <button
            type="button"
            onClick={() => setMobileView("lyrics")}
            className={`rounded-full px-3.5 py-1 font-medium transition-colors ${
              mobileView === "lyrics" ? "bg-white text-[#111113]" : "text-white/75"
            }`}
          >
            歌词
          </button>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden md:inline-flex">
            <PlatformBadge platform={currentTrack.platform} subtle />
          </span>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setDrawerTab("comments");
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur-md hover:bg-white/20 md:hidden"
            aria-label="查看评论"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setDrawerTab("queue");
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white/80 backdrop-blur-md hover:bg-white/20 md:hidden"
            aria-label="查看队列"
          >
            <ListMusic className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="tv-pb-safe relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden px-6 pb-6 md:grid md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] md:items-center md:gap-12 md:px-8 md:pb-10">
        {/* Cover & Transport Column (Always visible on desktop; visible when mobileView === "cover" on mobile) */}
        <div
          className={`mx-auto flex w-full max-w-[340px] flex-1 flex-col justify-center md:max-w-[360px] md:flex-none ${
            mobileView === "lyrics" ? "hidden md:flex" : "flex"
          }`}
        >
          <CoverArt
            src={currentTrack.coverUrl}
            alt={currentTrack.title}
            rounded="rounded-2xl"
            className={`mx-auto aspect-square w-[min(72vw,280px)] shadow-[0_28px_80px_rgba(0,0,0,0.65)] transition-transform duration-500 md:w-full ${
              isPlaying ? "scale-100" : "scale-[0.94] opacity-90"
            }`}
          />

          <div className="mt-6 flex items-start justify-between gap-3 md:mt-7">
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="truncate text-xl font-bold tracking-tight text-white md:text-2xl">
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
                onClick={() => likeMutation.mutate(!likeData?.liked)}
                className={`mt-1 shrink-0 rounded-full p-2 transition-colors hover:bg-white/10 ${
                  likeData?.liked ? "text-[#fa2d48]" : "text-white/70"
                }`}
                aria-label={likeData?.liked ? "取消喜欢" : "喜欢"}
              >
                <Heart className={`h-5 w-5 ${likeData?.liked ? "fill-current" : ""}`} />
              </button>
            )}
          </div>

          <div className="mt-5 space-y-4 md:mt-6 md:space-y-5">
            <PlaybackProgressBar compact onDarkBackdrop />

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => audioEngine.cyclePlaybackMode()}
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

              <div className="flex items-center gap-5">
                <button
                  type="button"
                  onClick={() => void audioEngine.playPrevious()}
                  className="rounded-full p-2.5 text-white/85 transition-colors hover:bg-white/10"
                  aria-label="上一首"
                >
                  <SkipBack className="h-5 w-5 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={() => void audioEngine.togglePlay()}
                  className="flex h-13 w-13 items-center justify-center rounded-full bg-white text-[#111113] shadow-xl transition-transform hover:scale-105 active:scale-95"
                  aria-label={isPlaying ? "暂停" : "播放"}
                >
                  {isPlaying ? (
                    <Pause className="h-5 w-5 fill-current" />
                  ) : (
                    <Play className="ml-0.5 h-5 w-5 fill-current" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => void audioEngine.playNext()}
                  className="rounded-full p-2.5 text-white/85 transition-colors hover:bg-white/10"
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
          </div>
        </div>

        {/* Lyrics Column (Always visible on desktop; fills height when mobileView === "lyrics" on mobile) */}
        <div
          className={`min-h-0 flex-1 flex-col overflow-hidden md:flex md:h-[66vh] md:flex-none ${
            mobileView === "lyrics" ? "flex" : "hidden md:flex"
          }`}
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            <LyricScroller lines={lyricData?.lyrics.lines ?? []} loading={isLoading} large />
          </div>

          {/* Mobile compact bottom transport while viewing lyrics */}
          <div className="mt-3 space-y-3 border-t border-white/10 pt-3 md:hidden">
            <PlaybackProgressBar compact onDarkBackdrop />
            <div className="flex items-center justify-center gap-6">
              <button
                type="button"
                onClick={() => void audioEngine.playPrevious()}
                className="rounded-full p-2 text-white/85"
                aria-label="上一首"
              >
                <SkipBack className="h-5 w-5 fill-current" />
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.togglePlay()}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#111113]"
                aria-label={isPlaying ? "暂停" : "播放"}
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.playNext()}
                className="rounded-full p-2 text-white/85"
                aria-label="下一首"
              >
                <SkipForward className="h-5 w-5 fill-current" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
