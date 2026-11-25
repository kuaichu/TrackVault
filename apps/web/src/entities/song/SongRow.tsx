import { Download, Heart, Loader2, Lock, MoreHorizontal, Play } from "lucide-react";
import { type MouseEvent, memo } from "react";
import type { Song } from "#shared";
import { CoverArt, EqualizerBars, PlatformBadge } from "../../shared/ui/primitives.js";
import { AlbumLink, ArtistLinks } from "../music/index.js";

export interface SongRowProps {
  song: Song;
  rowKey: string;
  displayIndex: number;
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
  const locked = Boolean(song.availability?.playback.locked);

  return (
    <div
      data-song-row={rowKey}
      onDoubleClick={(e) => onRowDoubleClick(e, song)}
      className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 transition-colors @lg:grid-cols-[32px_minmax(0,1fr)_48px_96px] @lg:gap-3 @lg:px-3 @3xl:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px] ${
        isActive ? "bg-[var(--tv-accent-soft)]" : "hover:bg-[var(--tv-surface-hover)]"
      }`}
    >
      {/* Index / Playing Equalizer / Hover Play Button (@lg+) */}
      <div className="hidden items-center justify-center @lg:flex">
        <button
          type="button"
          onClick={(e) => onPlayButtonClick(e, song)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--tv-text-subtle)] transition-colors hover:text-[var(--tv-text)]"
          title={locked ? song.availability?.playback.reason : "播放"}
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
                  <Play className="h-3.5 w-3.5 fill-current text-[var(--tv-text)]" />
                )}
              </span>
            </>
          )}
        </button>
      </div>

      {/* Cover + Title + Clickable Artist Links */}
      <div className="flex min-w-0 items-center gap-2.5 @lg:gap-3">
        <button
          type="button"
          onClick={(e) => onPlayButtonClick(e, song)}
          className="relative shrink-0"
          aria-label={`播放 ${song.title}`}
        >
          <CoverArt src={song.coverUrl} alt={song.title} className="h-10 w-10" rounded="rounded-md" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 @lg:gap-2">
            {isActive && isPlaying && (
              <span className="inline-flex shrink-0 @lg:hidden">
                <EqualizerBars />
              </span>
            )}
            <button
              type="button"
              onClick={(e) => onPlayButtonClick(e, song)}
              className={`truncate text-left text-[13.5px] font-semibold transition-colors ${
                isActive ? "text-[var(--tv-accent)]" : "text-[var(--tv-text)] hover:text-[var(--tv-accent)]"
              }`}
            >
              {song.title}
            </button>
            {song.isCloud && (
              <span className="shrink-0 rounded bg-[var(--tv-surface-active)] px-1.5 py-0.5 text-[10px] text-[var(--tv-text-muted)]">
                云盘
              </span>
            )}
            {song.availability && song.availability.playback.status !== "available" && (
              <span
                title={song.availability.playback.reason}
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                  song.availability.playback.locked
                    ? "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]"
                    : "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]"
                }`}
              >
                {song.availability.playback.label}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--tv-text-muted)]">
            <ArtistLinks
              platform={song.platform}
              artists={song.artists}
              fallbackText={song.artist}
              primaryArtistId={song.primaryArtistId}
              className="truncate"
            />
            <PlatformBadge platform={song.platform} subtle />
          </div>
        </div>
      </div>

      {/* Clickable Album Column (@3xl+) */}
      <div className="hidden min-w-0 truncate text-xs text-[var(--tv-text-muted)] @3xl:block">
        <AlbumLink song={song} />
      </div>

      {/* Duration (@lg+) */}
      <div className="hidden text-right text-xs tabular-nums text-[var(--tv-text-subtle)] @lg:block">
        {song.duration}
      </div>

      {/* Clean Row Actions: Like + Quick Download (@lg+) + Context Menu */}
      <div className="relative flex items-center justify-end gap-0.5">
        {canLike && (
          <button
            type="button"
            onClick={() => onToggleLike?.(song, !isLiked)}
            title={isLiked ? "取消喜欢" : "红心喜欢"}
            aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
            className={`rounded-md p-1.5 transition-all ${
              isLiked
                ? "text-[var(--tv-accent)] opacity-100"
                : "hidden text-[var(--tv-text-subtle)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] @lg:inline-flex @3xl:opacity-0 @3xl:group-hover:opacity-100"
            }`}
          >
            <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
          </button>
        )}

        <button
          type="button"
          disabled={downloadDisabled}
          onClick={() => onQuickDownload?.(song)}
          title={downloadTitle}
          aria-label={`下载 ${song.title}`}
          className="hidden rounded-md p-1.5 text-[var(--tv-text-muted)] opacity-65 transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-35 @lg:inline-flex"
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
                : "opacity-100 @3xl:opacity-65 @3xl:group-hover:opacity-100"
            }`}
          >
            <MoreHorizontal className="h-4 w-4 @lg:h-3.5 @lg:w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
