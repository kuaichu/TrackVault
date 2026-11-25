import { Download, Heart, Loader2, Lock, MoreHorizontal } from "lucide-react";
import { type MouseEvent, memo } from "react";
import type { Song } from "#shared";
import { CoverArt, EqualizerBars, PlatformBadge } from "../../shared/ui/primitives.js";
import { AlbumLink, ArtistLinks } from "../music/index.js";

export interface SongRowProps {
  song: Song;
  rowKey: string;
  displayIndex: number;
  isEvenRow?: boolean;
  showPlatformBadge?: boolean;
  isActive: boolean;
  isPlaying: boolean;
  canLike: boolean;
  isLiked: boolean;
  isDownloading: boolean;
  downloadDisabled: boolean;
  downloadTitle: string;
  menuOpen: boolean;
  onPlayButtonClick: (e: MouseEvent<HTMLButtonElement>, song: Song) => void;
  onRowDoubleClick: (e: MouseEvent<HTMLDivElement>, song: Song) => void;
  onToggleLike?: (song: Song, nextLiked: boolean) => void;
  onQuickDownload?: (song: Song) => void;
  onOpenMenu: (song: Song, rowKey: string, idx: number, triggerEl: HTMLButtonElement) => void;
}

export const SongRow = memo(function SongRow({
  song,
  rowKey,
  displayIndex,
  isEvenRow = false,
  showPlatformBadge = true,
  isActive,
  isPlaying,
  canLike,
  isLiked,
  isDownloading,
  downloadDisabled,
  downloadTitle,
  menuOpen,
  onPlayButtonClick,
  onRowDoubleClick,
  onToggleLike,
  onQuickDownload,
  onOpenMenu,
}: SongRowProps) {
  const playbackAvail = song.availability?.playback;
  const locked = Boolean(playbackAvail?.locked);
  const isUnlockedVip = playbackAvail?.status === "vip" && !locked;

  return (
    <div
      data-song-row={rowKey}
      onDoubleClick={(e) => onRowDoubleClick(e, song)}
      className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-[7px] px-2.5 py-2 transition-colors @lg:grid-cols-[32px_minmax(0,1fr)_48px_92px] @lg:gap-3 @lg:px-3 @3xl:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_96px] ${
        isActive
          ? "bg-[var(--tv-nav-active)]"
          : isEvenRow
            ? "bg-[var(--tv-zebra-bg)] hover:bg-[var(--tv-surface-hover)]"
            : "hover:bg-[var(--tv-surface-hover)]"
      }`}
    >
      {/* Index / Playing Equalizer / Hover Rounded Play Triangle (@lg+) */}
      <div className="hidden items-center justify-center @lg:flex">
        <button
          type="button"
          onClick={(e) => onPlayButtonClick(e, song)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--tv-text-subtle)] transition-colors hover:text-[var(--tv-text)]"
          title={locked ? playbackAvail?.reason : "播放"}
          aria-label={`播放 ${song.title}`}
        >
          {isActive && isPlaying ? (
            <EqualizerBars />
          ) : (
            <>
              <span
                className={`text-xs tabular-nums group-hover:hidden ${
                  isActive ? "font-semibold text-[var(--tv-accent)]" : ""
                }`}
              >
                {displayIndex}
              </span>
              <span className="hidden group-hover:inline-flex">
                {locked ? (
                  <Lock className="h-3.5 w-3.5 text-[var(--tv-danger)]" />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 text-[var(--tv-text)]"
                  >
                    <path
                      d="M7.5 5.4C7.5 4.2 8.8 3.48 9.82 4.11L19.6 10.21C20.56 10.81 20.56 12.19 19.6 12.79L9.82 18.89C8.8 19.52 7.5 18.8 7.5 17.6V5.4Z"
                      fill="currentColor"
                    />
                  </svg>
                )}
              </span>
            </>
          )}
        </button>
      </div>

      {/* Cover + Title + Compact Apple-Music-style Micro-Badges + Artist */}
      <div className="flex min-w-0 items-center gap-2.5 @lg:gap-3">
        <button
          type="button"
          onClick={(e) => onPlayButtonClick(e, song)}
          className="relative shrink-0 overflow-hidden rounded-[6px]"
          aria-label={`播放 ${song.title}`}
        >
          <CoverArt src={song.coverUrl} alt={song.title} className="h-10 w-10" rounded="rounded-[6px]" />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-[6px]"
            style={{ boxShadow: "var(--tv-cover-ring)" }}
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {isActive && isPlaying && (
              <span className="inline-flex shrink-0 @lg:hidden">
                <EqualizerBars />
              </span>
            )}
            <button
              type="button"
              onClick={(e) => onPlayButtonClick(e, song)}
              className={`truncate text-left text-[13.5px] font-medium transition-colors ${
                isActive ? "font-semibold text-[var(--tv-accent)]" : "text-[var(--tv-text)]"
              }`}
            >
              {song.title}
            </button>

            {song.isCloud && (
              <span className="inline-flex h-[14px] shrink-0 items-center rounded-[3.5px] border border-[var(--tv-border-strong)] px-1 text-[9px] leading-none font-medium text-[var(--tv-text-subtle)]">
                云盘
              </span>
            )}

            {playbackAvail &&
              playbackAvail.status !== "available" &&
              (isUnlockedVip ? (
                <span
                  title={playbackAvail.reason || playbackAvail.label}
                  className="inline-flex h-[14px] shrink-0 items-center rounded-[3.5px] border border-[var(--tv-border-strong)] px-1 text-[9px] leading-none font-semibold tracking-wider text-[var(--tv-text-subtle)]"
                >
                  VIP
                </span>
              ) : (
                <span
                  title={playbackAvail.reason}
                  className={`inline-flex h-[14px] shrink-0 items-center rounded-[3.5px] border px-1 text-[9px] leading-none font-medium ${
                    locked
                      ? "border-[var(--tv-danger)]/35 text-[var(--tv-danger)]/85"
                      : "border-[var(--tv-border-strong)] text-[var(--tv-text-subtle)]"
                  }`}
                >
                  {playbackAvail.label}
                </span>
              ))}
          </div>

          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--tv-text-muted)]">
            <ArtistLinks
              platform={song.platform}
              artists={song.artists}
              fallbackText={song.artist}
              primaryArtistId={song.primaryArtistId}
              className="truncate"
              linkClassName="transition-colors hover:text-[var(--tv-text)]"
            />
            {showPlatformBadge && <PlatformBadge platform={song.platform} subtle />}
          </div>
        </div>
      </div>

      {/* Clickable Album Column (@3xl+) */}
      <div className="hidden min-w-0 truncate text-xs text-[var(--tv-text-muted)] @3xl:block">
        <AlbumLink song={song} className="transition-colors hover:text-[var(--tv-text)]" />
      </div>

      {/* Duration (@lg+, right-aligned tabular-nums) */}
      <div className="hidden text-right text-xs text-[var(--tv-text-subtle)] tabular-nums @lg:block">
        {song.duration}
      </div>

      {/* Trailing Actions: Subtle Ruby Heart + Hover-Only Quick Download & More Menu */}
      <div className="relative flex items-center justify-end gap-0.5">
        {canLike && (
          <button
            type="button"
            onClick={() => onToggleLike?.(song, !isLiked)}
            title={isLiked ? "取消喜欢" : "红心喜欢"}
            aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
            className={`rounded-md p-1.5 transition-all ${
              isLiked
                ? "text-[var(--tv-accent)]/80 hover:text-[var(--tv-accent)]"
                : "hidden text-[var(--tv-text-subtle)] opacity-0 hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] group-hover:opacity-100 focus-visible:opacity-100 @lg:inline-flex"
            }`}
          >
            <Heart className={`h-[13.5px] w-[13.5px] ${isLiked ? "fill-current" : ""}`} />
          </button>
        )}

        <button
          type="button"
          disabled={downloadDisabled}
          onClick={() => onQuickDownload?.(song)}
          title={downloadTitle}
          aria-label={`下载 ${song.title}`}
          className={`hidden rounded-md p-1.5 text-[var(--tv-text-muted)] transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:cursor-not-allowed disabled:opacity-30 @lg:inline-flex ${
            isDownloading
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:group-hover:opacity-30"
          }`}
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </button>

        <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={(e) => onOpenMenu(song, rowKey, displayIndex - 1, e.currentTarget)}
            title="更多操作"
            aria-label="更多操作"
            aria-expanded={menuOpen}
            className={`rounded-md p-1.5 text-[var(--tv-text-muted)] transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] ${
              menuOpen
                ? "bg-[var(--tv-surface-active)] opacity-100"
                : "opacity-100 @lg:opacity-0 @lg:group-hover:opacity-100 @lg:focus-visible:opacity-100"
            }`}
          >
            <MoreHorizontal className="h-4 w-4 @lg:h-3.5 @lg:w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
