import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { PlaylistSummary } from "#shared";
import { CoverArt } from "../../shared/ui/primitives.js";

/**
 * Shared Apple Music-style playlist card:
 * - Crisp 0.5px inner rim (`--tv-cover-ring`) so bright covers stay sharp against dark backgrounds
 * - Bottom-left translucent frosted circular play trigger on hover
 * - Clean single-line title + subtle secondary subtitle
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
    <div className="group text-left">
      <div className="relative aspect-square w-full overflow-hidden rounded-[11px] bg-[var(--tv-surface)] shadow-sm transition-shadow duration-300 group-hover:shadow-lg">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`打开歌单 ${playlist.name}`}
          className="block h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
        >
          <CoverArt
            src={playlist.coverUrl}
            alt={playlist.name}
            className="h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.03]"
            rounded="rounded-none"
          />
        </button>

        {/* Subtle 0.5px inner highlight rim for light/pastel cover definition */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[11px]"
          style={{ boxShadow: "var(--tv-cover-ring)" }}
        />

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
            className="absolute bottom-2.5 left-2.5 flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-black/55 text-white opacity-0 ring-1 ring-white/20 backdrop-blur-md transition-all duration-200 hover:scale-105 hover:bg-[var(--tv-accent)] hover:ring-transparent group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] disabled:opacity-60"
          >
            {playLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4">
                <path
                  d="M7.5 5.4C7.5 4.2 8.8 3.48 9.82 4.11L19.6 10.21C20.56 10.81 20.56 12.19 19.6 12.79L9.82 18.89C8.8 19.52 7.5 18.8 7.5 17.6V5.4Z"
                  fill="currentColor"
                />
              </svg>
            )}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="mt-2 block w-full text-left focus:outline-none focus-visible:text-[var(--tv-accent)]"
      >
        <div className="line-clamp-1 text-[13px] leading-snug font-medium text-[var(--tv-text)] transition-colors group-hover:text-[var(--tv-text)]">
          {playlist.name}
        </div>
        {subtitle && (
          <div className="mt-0.5 flex items-center gap-1 truncate text-[11.5px] leading-snug text-[var(--tv-text-subtle)]">
            {subtitle}
          </div>
        )}
      </button>
    </div>
  );
}
