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
  pinnedFavorite = false,
}: {
  playlist: PlaylistSummary;
  subtitle?: ReactNode;
  onOpen: () => void;
  onPlay?: () => void;
  playLoading?: boolean;
  /** Subtle Apple Music corner heart indicator for the user's primary "Liked Songs" playlist. */
  pinnedFavorite?: boolean;
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

        {pinnedFavorite && (
          <span
            aria-label="我喜欢的音乐"
            title="我喜欢的音乐"
            className="pointer-events-none absolute top-2.5 right-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-[#fa2d48] shadow-xs ring-1 ring-white/15 backdrop-blur-md"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
              <path
                d="M12 20.15C11.68 20.15 11.37 20.04 11.11 19.84C7.18 16.79 3.25 13.38 3.25 9.15C3.25 6.32 5.45 4.25 8.12 4.25C9.73 4.25 11.12 5.04 12 6.26C12.88 5.04 14.27 4.25 15.88 4.25C18.55 4.25 20.75 6.32 20.75 9.15C20.75 13.38 16.82 16.79 12.89 19.84C12.63 20.04 12.32 20.15 12 20.15Z"
                fill="currentColor"
              />
            </svg>
          </span>
        )}

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
