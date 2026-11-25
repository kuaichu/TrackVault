import { Disc3, Download, FolderPlus, Heart, ListEnd, ListPlus, Trash2, User } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type QualityLevel, type Song, getQualityLabel } from "#shared";

export type SongMenuPanel = "main" | "playlists" | "quality";

export interface SongMenuAnchor {
  song: Song;
  rowKey: string;
  top: number;
  bottom: number;
  right: number;
  hasLayoutRect: boolean;
  upward: boolean;
}

interface SongRowMenuProps {
  anchor: SongMenuAnchor;
  canLike: boolean;
  isLiked: boolean;
  canManagePlaylists: boolean;
  downloadDisabled: boolean;
  downloadLocked: boolean;
  downloadTitle: string;
  preferredLevel: QualityLevel;
  onClose: () => void;
  onQueueNext?: (song: Song) => void;
  onQueueAdd?: (song: Song) => void;
  onToggleLike?: (song: Song, nextLiked: boolean) => void;
  onDownloadQuality?: (song: Song, level: QualityLevel) => void;
  onNavigateArtist?: (song: Song) => void;
  onNavigateAlbum?: (song: Song) => void;
  onRemoveTrack?: (song: Song) => void;
  renderPlaylistSubmenu?: (
    song: Song,
    helpers: { closeMenu: () => void; backToMain: () => void },
  ) => ReactNode;
}

/**
 * Single-instance Portal context menu for `<SongTable>` rows.
 * Only one menu node is ever mounted regardless of how many thousands of tracks exist in the table.
 */
export function SongRowMenu({
  anchor,
  canLike,
  isLiked,
  canManagePlaylists,
  downloadDisabled,
  downloadLocked,
  downloadTitle,
  preferredLevel,
  onClose,
  onQueueNext,
  onQueueAdd,
  onToggleLike,
  onDownloadQuality,
  onNavigateArtist,
  onNavigateAlbum,
  onRemoveTrack,
  renderPlaylistSubmenu,
}: SongRowMenuProps) {
  const [panel, setPanel] = useState<SongMenuPanel>("main");
  const prevRowKeyRef = useRef(anchor.rowKey);
  if (prevRowKeyRef.current !== anchor.rowKey) {
    prevRowKeyRef.current = anchor.rowKey;
    setPanel("main");
  }
  const { song } = anchor;

  useEffect(() => {
    const onPointerDown = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const positionStyle: CSSProperties = anchor.hasLayoutRect
    ? {
        position: "fixed",
        right: Math.max(8, window.innerWidth - anchor.right),
        ...(anchor.upward
          ? { bottom: Math.max(8, window.innerHeight - anchor.top + 4) }
          : { top: Math.max(8, anchor.bottom + 4) }),
        zIndex: "var(--tv-z-dropdown)",
      }
    : {
        position: "fixed",
        top: 0,
        right: 0,
        zIndex: "var(--tv-z-dropdown)",
      };

  const menuContent = (
    <div
      role="menu"
      aria-label={`${song.title} 操作菜单`}
      data-song-portal-menu="true"
      data-placement={anchor.upward ? "top" : "bottom"}
      onPointerDown={(e) => e.stopPropagation()}
      className="w-48 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] p-1 shadow-2xl"
      style={positionStyle}
    >
      {panel === "main" && (
        <>
          {onQueueNext && (
            <button
              type="button"
              onClick={() => {
                onQueueNext(song);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              <ListPlus className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
              下一首播放
            </button>
          )}

          {onQueueAdd && (
            <button
              type="button"
              onClick={() => {
                onQueueAdd(song);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              <ListEnd className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
              添加到队列末尾
            </button>
          )}

          {canManagePlaylists && renderPlaylistSubmenu && (
            <button
              type="button"
              onClick={() => setPanel("playlists")}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              <span className="flex items-center gap-2">
                <FolderPlus className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                收藏到歌单
              </span>
              <span className="text-[10px] text-[var(--tv-text-subtle)]">›</span>
            </button>
          )}

          {canLike && onToggleLike && (
            <button
              type="button"
              onClick={() => {
                onToggleLike(song, !isLiked);
                onClose();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] @lg:hidden"
            >
              <Heart
                className={`h-3.5 w-3.5 ${
                  isLiked ? "fill-[var(--tv-accent)] text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)]"
                }`}
              />
              {isLiked ? "取消红心喜欢" : "红心喜欢"}
            </button>
          )}

          {onDownloadQuality &&
            (song.availableQualities.length > 1 ? (
              <button
                type="button"
                disabled={downloadDisabled}
                title={downloadTitle}
                onClick={() => setPanel("quality")}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="flex items-center gap-2">
                  <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                  {downloadLocked ? "暂不可下载" : "下载歌曲"}
                </span>
                <span className="text-[10px] text-[var(--tv-text-subtle)]">›</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={downloadDisabled}
                title={downloadTitle}
                onClick={() => {
                  onClose();
                  onDownloadQuality(song, preferredLevel);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 @lg:hidden"
              >
                <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                {downloadLocked ? "暂不可下载" : `下载 (${getQualityLabel(preferredLevel)})`}
              </button>
            ))}

          {(song.primaryArtistId || song.albumId) && (
            <div className="my-1 border-t border-[var(--tv-border)]" />
          )}

          {song.primaryArtistId && onNavigateArtist && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigateArtist(song);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              <User className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
              查看歌手
            </button>
          )}

          {song.albumId && onNavigateAlbum && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onNavigateAlbum(song);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              <Disc3 className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
              查看专辑
            </button>
          )}

          {onRemoveTrack && (
            <>
              <div className="my-1 border-t border-[var(--tv-border)]" />
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onRemoveTrack(song);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-danger)] hover:bg-[var(--tv-danger)]/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                从歌单移除
              </button>
            </>
          )}
        </>
      )}

      {panel === "playlists" &&
        renderPlaylistSubmenu?.(song, {
          closeMenu: onClose,
          backToMain: () => setPanel("main"),
        })}

      {panel === "quality" && onDownloadQuality && (
        <>
          <button
            type="button"
            onClick={() => setPanel("main")}
            className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
          >
            ‹ 选择下载音质
          </button>
          {song.availableQualities.map((q) => (
            <button
              key={q.level}
              type="button"
              disabled={downloadDisabled}
              onClick={() => {
                onClose();
                onDownloadQuality(song, q.level);
              }}
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:opacity-40"
            >
              <span>{q.label}</span>
              {q.level === preferredLevel && (
                <span className="text-[10px] text-[var(--tv-accent)]">默认</span>
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );

  if (typeof document === "undefined") {
    return menuContent;
  }
  return createPortal(menuContent, document.body);
}
