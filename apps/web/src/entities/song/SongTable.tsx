import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { type DownloadMode, type QualityLevel, type Song, getQualityLabel, getSongKey } from "#shared";
import { EmptyState } from "../../shared/ui/primitives.js";
import { SongRow } from "./SongRow.js";
import { type SongMenuAnchor, SongRowMenu } from "./SongRowMenu.js";

const BUTTON_DBLCLICK_GUARD_MS = 1000;
export const SONG_TABLE_VIRTUAL_THRESHOLD = 80;
export const SONG_TABLE_FALLBACK_WINDOW = 80;
const ESTIMATED_ROW_HEIGHT = 58;
const OVERSCAN_ROWS = 10;

interface VisibleWindow {
  startIndex: number;
  endIndex: number;
}

function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function computeVisibleWindow(
  listEl: HTMLElement | null,
  scrollParent: HTMLElement | null,
  totalCount: number,
): VisibleWindow {
  if (totalCount <= SONG_TABLE_VIRTUAL_THRESHOLD) {
    return { startIndex: 0, endIndex: totalCount };
  }

  const viewportHeight = scrollParent
    ? scrollParent.clientHeight
    : typeof document !== "undefined"
      ? document.documentElement.clientHeight
      : 0;

  if (!listEl || viewportHeight <= 0) {
    return {
      startIndex: 0,
      endIndex: Math.min(totalCount, SONG_TABLE_FALLBACK_WINDOW),
    };
  }

  const listRect = listEl.getBoundingClientRect();
  let visibleTop = 0;
  let visibleBottom = viewportHeight;

  if (scrollParent) {
    const parentRect = scrollParent.getBoundingClientRect();
    const hasRealRect = listRect.height > 0 || parentRect.height > 0;
    if (hasRealRect) {
      const listTopInScroll = listRect.top - parentRect.top;
      visibleTop = Math.max(0, -listTopInScroll);
      visibleBottom = Math.max(0, viewportHeight - listTopInScroll);
    } else {
      visibleTop = Math.max(0, scrollParent.scrollTop);
      visibleBottom = visibleTop + viewportHeight;
    }
  } else {
    const hasRealRect = listRect.height > 0 || listRect.top !== 0;
    if (hasRealRect) {
      visibleTop = Math.max(0, -listRect.top);
      visibleBottom = Math.max(0, viewportHeight - listRect.top);
    } else {
      visibleTop = Math.max(0, window.scrollY);
      visibleBottom = visibleTop + viewportHeight;
    }
  }

  const rawStart = Math.floor(visibleTop / ESTIMATED_ROW_HEIGHT);
  const rawEnd = Math.ceil(visibleBottom / ESTIMATED_ROW_HEIGHT);
  const startIndex = Math.max(0, rawStart - OVERSCAN_ROWS);
  const endIndex = Math.min(totalCount, Math.max(startIndex + 1, rawEnd + OVERSCAN_ROWS));

  return { startIndex, endIndex };
}

export interface PureSongTableProps {
  songs: Song[];
  emptyText?: string;
  emptyDescription?: string;
  showHeaderMeta?: boolean;
  indexOffset?: number;
  currentTrackKey?: string | null;
  isPlaying?: boolean;
  downloadMode?: DownloadMode;
  onChangeDownloadMode?: (mode: DownloadMode) => void;
  canLikeSong?: (song: Song) => boolean;
  isSongLiked?: (song: Song) => boolean;
  isSongDownloading?: (song: Song) => boolean;
  canManagePlaylists?: (song: Song) => boolean;
  getPreferredDownloadQuality?: (song: Song) => { level: QualityLevel; label: string };
  onPlaySong?: (song: Song, queue: Song[]) => void;
  onToggleLike?: (song: Song, nextLiked: boolean) => void;
  onDownloadSong?: (song: Song, level: QualityLevel, mode: DownloadMode) => void;
  onQueueNext?: (song: Song) => void;
  onQueueAdd?: (song: Song) => void;
  onRemoveTrack?: (song: Song) => void;
  onNavigateArtist?: (song: Song) => void;
  onNavigateAlbum?: (song: Song) => void;
  renderPlaylistSubmenu?: (
    song: Song,
    helpers: { closeMenu: () => void; backToMain: () => void },
  ) => ReactNode;
}

/**
 * Pure presentational virtualized song table with zero `features/*` dependencies.
 * Business actions (playback, likes, playlists, downloads) are injected via props from `widgets/song-table`.
 */
export function SongTable({
  songs,
  emptyText = "暂无歌曲",
  emptyDescription,
  showHeaderMeta = true,
  indexOffset = 0,
  currentTrackKey = null,
  isPlaying = false,
  downloadMode = "tagged_server",
  onChangeDownloadMode,
  canLikeSong,
  isSongLiked,
  isSongDownloading,
  canManagePlaylists,
  getPreferredDownloadQuality,
  onPlaySong,
  onToggleLike,
  onDownloadSong,
  onQueueNext,
  onQueueAdd,
  onRemoveTrack,
  onNavigateArtist,
  onNavigateAlbum,
  renderPlaylistSubmenu,
}: PureSongTableProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastButtonPlayRef = useRef<{ key: string; at: number } | null>(null);
  const songsRef = useRef(songs);
  songsRef.current = songs;

  const [menuAnchor, setMenuAnchor] = useState<SongMenuAnchor | null>(null);
  const [visibleWindow, setVisibleWindow] = useState<VisibleWindow>(() => ({
    startIndex: 0,
    endIndex:
      songs.length > SONG_TABLE_VIRTUAL_THRESHOLD
        ? Math.min(songs.length, SONG_TABLE_FALLBACK_WINDOW)
        : songs.length,
  }));

  const isVirtualized = songs.length > SONG_TABLE_VIRTUAL_THRESHOLD;

  const updateWindow = useCallback(() => {
    const total = songs.length;
    if (total <= SONG_TABLE_VIRTUAL_THRESHOLD) {
      setVisibleWindow((prev) =>
        prev.startIndex === 0 && prev.endIndex === total ? prev : { startIndex: 0, endIndex: total },
      );
      return;
    }
    const listEl = listRef.current;
    const scrollParent = findScrollParent(listEl);
    const next = computeVisibleWindow(listEl, scrollParent, total);
    setVisibleWindow((prev) =>
      prev.startIndex === next.startIndex && prev.endIndex === next.endIndex ? prev : next,
    );
  }, [songs.length]);

  useLayoutEffect(() => {
    updateWindow();
  }, [updateWindow]);

  useEffect(() => {
    if (!isVirtualized) return;
    const listEl = listRef.current;
    const scrollParent = findScrollParent(listEl);
    const scrollTarget: EventTarget = scrollParent ?? window;

    scrollTarget.addEventListener("scroll", updateWindow, { passive: true });
    window.addEventListener("resize", updateWindow);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateWindow);
      if (scrollParent) observer.observe(scrollParent);
      if (listEl) observer.observe(listEl);
    }

    return () => {
      scrollTarget.removeEventListener("scroll", updateWindow);
      window.removeEventListener("resize", updateWindow);
      observer?.disconnect();
    };
  }, [isVirtualized, updateWindow]);

  useEffect(() => {
    if (!menuAnchor) return;
    const stillPresent = songs.some((s, i) => `${getSongKey(s)}-${i}` === menuAnchor.rowKey);
    if (!stillPresent) {
      setMenuAnchor(null);
    }
  }, [songs, menuAnchor]);

  // P15: Honor W3C UIEvent.detail semantics: ignore detail > 1 (OS double-click second click),
  // respond immediately to independent clicks (detail === 1) and keyboard activations (detail === 0).
  const handlePlayButtonClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>, song: Song) => {
      if (e.detail > 1) return;
      lastButtonPlayRef.current = { key: getSongKey(song), at: Date.now() };
      onPlaySong?.(song, songsRef.current);
    },
    [onPlaySong],
  );

  const handleRowDoubleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>, song: Song) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("button, a, input, select")) return;
      const key = getSongKey(song);
      const lastBtn = lastButtonPlayRef.current;
      if (lastBtn && lastBtn.key === key && Date.now() - lastBtn.at < BUTTON_DBLCLICK_GUARD_MS) {
        lastButtonPlayRef.current = null;
        return;
      }
      onPlaySong?.(song, songsRef.current);
    },
    [onPlaySong],
  );

  const resolvePreferredQuality = useCallback(
    (song: Song): { level: QualityLevel; label: string } => {
      if (getPreferredDownloadQuality) {
        return getPreferredDownloadQuality(song);
      }
      const fallbackLevel = song.availableQualities[song.availableQualities.length - 1]?.level ?? "standard";
      return { level: fallbackLevel, label: getQualityLabel(fallbackLevel) };
    },
    [getPreferredDownloadQuality],
  );

  const handleQuickDownload = useCallback(
    (song: Song) => {
      if (!onDownloadSong) return;
      const { level } = resolvePreferredQuality(song);
      onDownloadSong(song, level, downloadMode);
    },
    [onDownloadSong, resolvePreferredQuality, downloadMode],
  );

  const handleOpenMenu = useCallback(
    (song: Song, rowKey: string, idx: number, triggerEl: HTMLButtonElement) => {
      setMenuAnchor((prev) => {
        if (prev?.rowKey === rowKey) {
          return null;
        }
        const rect = triggerEl.getBoundingClientRect();
        const hasLayoutRect = rect.height > 0 && window.innerHeight > 0;
        const upward = hasLayoutRect
          ? window.innerHeight - rect.bottom < 280 && rect.top > 240
          : songsRef.current.length >= 4 && idx >= songsRef.current.length - 3;
        return {
          song,
          rowKey,
          top: rect.top,
          bottom: rect.bottom,
          right: rect.right,
          hasLayoutRect,
          upward,
        };
      });
    },
    [],
  );

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  const handleDownloadFromMenu = useCallback(
    (song: Song, level: QualityLevel) => {
      onDownloadSong?.(song, level, downloadMode);
    },
    [onDownloadSong, downloadMode],
  );

  if (songs.length === 0) {
    return <EmptyState title={emptyText} description={emptyDescription} />;
  }

  const startIndex = isVirtualized ? Math.min(visibleWindow.startIndex, songs.length) : 0;
  const endIndex = isVirtualized ? Math.min(visibleWindow.endIndex, songs.length) : songs.length;
  const renderedSongs = songs.slice(startIndex, endIndex);
  const topSpacerHeight = isVirtualized ? startIndex * ESTIMATED_ROW_HEIGHT : 0;
  const bottomSpacerHeight = isVirtualized
    ? Math.max(0, (songs.length - endIndex) * ESTIMATED_ROW_HEIGHT)
    : 0;

  const menuSong = menuAnchor?.song;
  const menuDownloadLocked = Boolean(menuSong?.availability?.download.locked);
  const menuDownloading = menuSong ? Boolean(isSongDownloading?.(menuSong)) : false;
  const menuPreferred = menuSong ? resolvePreferredQuality(menuSong) : null;

  return (
    <div className="@container">
      {showHeaderMeta && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-muted)]">
          <span className="tabular-nums">{songs.length} 首曲目</span>
          {onChangeDownloadMode && (
            <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => onChangeDownloadMode("tagged_server")}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  downloadMode === "tagged_server"
                    ? "bg-[var(--tv-surface-elevated)] font-medium text-[var(--tv-text)] shadow-xs"
                    : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                }`}
              >
                写标签下载
              </button>
              <button
                type="button"
                onClick={() => onChangeDownloadMode("direct_link")}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  downloadMode === "direct_link"
                    ? "bg-[var(--tv-surface-elevated)] font-medium text-[var(--tv-text)] shadow-xs"
                    : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                }`}
              >
                直链下载
              </button>
            </div>
          )}
        </div>
      )}

      {/* Container-query responsive column header */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--tv-border)] px-2 pb-2 text-[11px] font-medium text-[var(--tv-text-subtle)] select-none @lg:grid-cols-[32px_minmax(0,1fr)_48px_96px] @lg:gap-3 @lg:px-3 @3xl:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px]">
        <span className="hidden text-center @lg:block">#</span>
        <span>标题</span>
        <span className="hidden @3xl:block">专辑</span>
        <span className="hidden text-right @lg:block">时长</span>
        <span className="text-right">操作</span>
      </div>

      <div ref={listRef} className="mt-1 space-y-0.5" data-virtualized={isVirtualized ? "true" : "false"}>
        {topSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} />}

        {renderedSongs.map((song, localIdx) => {
          const idx = startIndex + localIdx;
          const key = getSongKey(song);
          const rowKey = `${key}-${idx}`;
          const active = currentTrackKey === key;
          const canLike = Boolean(canLikeSong?.(song));
          const isLiked = canLike && Boolean(isSongLiked?.(song));
          const isDownloading = Boolean(isSongDownloading?.(song));
          const downloadLocked = Boolean(song.availability?.download.locked);
          const downloadDisabled = isDownloading || downloadLocked;
          const { label: preferredLabel } = resolvePreferredQuality(song);
          const downloadTitle = downloadLocked
            ? (song.availability?.download.reason ?? "当前曲目暂不可下载")
            : isDownloading
              ? "正在加入下载..."
              : `下载 ${preferredLabel}`;

          return (
            <SongRow
              key={rowKey}
              song={song}
              rowKey={rowKey}
              displayIndex={indexOffset + idx + 1}
              isActive={active}
              isPlaying={active && isPlaying}
              canLike={canLike}
              isLiked={isLiked}
              isDownloading={isDownloading}
              downloadDisabled={downloadDisabled}
              downloadTitle={downloadTitle}
              menuOpen={menuAnchor?.rowKey === rowKey}
              onPlayButtonClick={handlePlayButtonClick}
              onRowDoubleClick={handleRowDoubleClick}
              onToggleLike={onToggleLike}
              onQuickDownload={handleQuickDownload}
              onOpenMenu={handleOpenMenu}
            />
          );
        })}

        {bottomSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} />}
      </div>

      {menuAnchor && menuSong && menuPreferred && (
        <SongRowMenu
          anchor={menuAnchor}
          canLike={Boolean(canLikeSong?.(menuSong))}
          isLiked={Boolean(canLikeSong?.(menuSong) && isSongLiked?.(menuSong))}
          canManagePlaylists={Boolean(canManagePlaylists?.(menuSong))}
          downloadDisabled={menuDownloading || menuDownloadLocked}
          downloadLocked={menuDownloadLocked}
          downloadTitle={
            menuDownloadLocked
              ? (menuSong.availability?.download.reason ?? "当前曲目暂不可下载")
              : menuDownloading
                ? "正在加入下载..."
                : `下载 ${menuPreferred.label}`
          }
          preferredLevel={menuPreferred.level}
          onClose={closeMenu}
          onQueueNext={onQueueNext}
          onQueueAdd={onQueueAdd}
          onToggleLike={onToggleLike}
          onDownloadQuality={onDownloadSong ? handleDownloadFromMenu : undefined}
          onNavigateArtist={onNavigateArtist}
          onNavigateAlbum={onNavigateAlbum}
          onRemoveTrack={onRemoveTrack}
          renderPlaylistSubmenu={renderPlaylistSubmenu}
        />
      )}
    </div>
  );
}
