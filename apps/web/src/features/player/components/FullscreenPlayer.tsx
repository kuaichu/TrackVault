import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { sanitizeCssUrl } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";
import { PlaybackProgressBar } from "./PlaybackProgressBar.js";

export function FullscreenPlayer() {
  const open = usePlayerStore((s) => s.fullscreenOpen);
  const setOpen = usePlayerStore((s) => s.setFullscreenOpen);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const { data: lyricData, isLoading } = useQuery({
    queryKey: ["lyrics", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.getLyrics(currentTrack.platform, currentTrack.id, currentTrack.mediaId) : null,
    enabled: Boolean(open && currentTrack),
  });

  if (!open || !currentTrack) return null;

  const safeBgUrl = sanitizeCssUrl(currentTrack.coverUrl);

  return (
    <dialog
      open
      className="fixed inset-0 m-0 flex h-full w-full max-h-none max-w-none flex-col overflow-hidden border-0 bg-[var(--tv-bg)] p-0 text-[var(--tv-text)]"
      style={{ zIndex: "var(--tv-z-modal)" }}
      aria-label="沉浸播放模式"
    >
      {safeBgUrl && (
        <div
          className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-25 blur-3xl"
          style={{ backgroundImage: `url("${safeBgUrl}")` }}
        />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-[#0b0e14]/85 to-[#0b0e14]" />

      <header className="relative flex items-center justify-between px-6 py-4">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/10"
        >
          <ChevronDown className="h-4 w-4" />
          收起
        </button>
        <PlatformBadge platform={currentTrack.platform} />
      </header>

      <div className="relative mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 items-center gap-10 overflow-hidden px-6 py-4 md:grid-cols-2">
        <div className="flex flex-col items-center gap-6">
          <CoverArt
            src={currentTrack.coverUrl}
            alt={currentTrack.title}
            className={`h-64 w-64 rounded-3xl shadow-2xl md:h-80 md:w-80 ${isPlaying ? "ring-2 ring-amber-400/40" : ""}`}
          />
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-white">{currentTrack.title}</h2>
            <p className="mt-1 text-sm text-white/65">
              {currentTrack.artist} · {currentTrack.album}
            </p>
          </div>
          <div className="w-full max-w-md space-y-4">
            <PlaybackProgressBar compact />
            <div className="flex items-center justify-center gap-5">
              <button
                type="button"
                onClick={() => void audioEngine.playPrevious()}
                className="rounded-full p-2.5 text-white/80 hover:bg-white/10"
              >
                <SkipBack className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.togglePlay()}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-400 text-slate-950 shadow-lg hover:bg-amber-300"
              >
                {isPlaying ? (
                  <Pause className="h-5 w-5 fill-current" />
                ) : (
                  <Play className="h-5 w-5 fill-current ml-0.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => void audioEngine.playNext()}
                className="rounded-full p-2.5 text-white/80 hover:bg-white/10"
              >
                <SkipForward className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        <div className="h-[55vh] overflow-hidden">
          <LyricScroller lines={lyricData?.lyrics.lines ?? []} loading={isLoading} large />
        </div>
      </div>
    </dialog>
  );
}
