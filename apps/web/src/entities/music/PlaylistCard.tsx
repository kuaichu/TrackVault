import { Loader2, Play } from "lucide-react";
import type { ReactNode } from "react";
import type { PlaylistSummary } from "#shared";
import { CoverArt } from "../../shared/ui/primitives.js";

/**
 * Shared playlist card with separate cover/title navigation trigger and an optional real play action button
 * (never renders a misleading decorative Play icon when `onPlay` is not wired).
 */
export function PlaylistCard({
  playlist,
  subtitle,
  onOpen,
  onPlay,
  playLoading = false,
}: {
  playlist: PlaylistSummary;
  subtitle?: ReactNode;
  onOpen: () => void;
  onPlay?: () => void;
  playLoading?: boolean;
}) {
  return (
    <div className="group rounded-xl text-left">
      <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`打开歌单 ${playlist.name}`}
          className="block h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
        >
          <CoverArt
            src={playlist.coverUrl}
            alt={playlist.name}
            className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
            rounded="rounded-none"
          />
        </button>

        {onPlay && (
          <button
            type="button"
            disabled={playLoading}
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            aria-label={`播放歌单 ${playlist.name}`}
            title={`播放 ${playlist.name}`}
            className="absolute bottom-3 right-3 flex h-9 w-9 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] disabled:opacity-60"
          >
            {playLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            )}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2.5 block w-full text-left focus:outline-none focus-visible:text-[var(--tv-accent)]"
      >
        <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
          {playlist.name}
        </div>
        {subtitle && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">{subtitle}</div>
        )}
      </button>
    </div>
  );
}
