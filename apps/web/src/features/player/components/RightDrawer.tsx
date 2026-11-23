import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { api } from "../../../shared/api/endpoints.js";
import {
  registerInertSynchronizer,
  setElementInert,
  useIsOverlayViewport,
  useModalFocusTrap,
} from "../../../shared/hooks/use-modal-focus-trap.js";
import { type RightDrawerTab, usePlayerStore } from "../store/player-store.js";
import { LyricScroller } from "./LyricScroller.js";
import { PlayQueuePanel, TrackCommentsPanel } from "./PlayerDrawerPanels.js";

export function RightDrawer({ backgroundInert = false }: { backgroundInert?: boolean } = {}) {
  const open = usePlayerStore((s) => s.drawerOpen);
  const tab = usePlayerStore((s) => s.drawerTab);
  const setOpen = usePlayerStore((s) => s.setDrawerOpen);
  const setTab = usePlayerStore((s) => s.setDrawerTab);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const queue = usePlayerStore((s) => s.queue);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const drawerPanelRef = useRef<HTMLElement | null>(null);
  const isOverlay = useIsOverlayViewport(1280);

  const shouldBeInert = Boolean(open && backgroundInert);
  const shouldBeInertRef = useRef(shouldBeInert);
  shouldBeInertRef.current = shouldBeInert;

  useLayoutEffect(() => {
    setElementInert(rootRef.current, shouldBeInert);
  }, [shouldBeInert]);

  useLayoutEffect(() => {
    return registerInertSynchronizer(() => {
      setElementInert(rootRef.current, shouldBeInertRef.current);
    });
  }, []);

  useModalFocusTrap(drawerPanelRef, open && isOverlay && !backgroundInert, {
    onClose: () => setOpen(false),
  });

  const lyricsQuery = useQuery({
    queryKey: ["lyrics", currentTrack?.platform, currentTrack?.id],
    queryFn: () =>
      currentTrack ? api.getLyrics(currentTrack.platform, currentTrack.id, currentTrack.mediaId) : null,
    enabled: Boolean(open && tab === "lyrics" && currentTrack),
  });

  if (!open) return null;

  const tabs: Array<{ id: RightDrawerTab; label: string }> = [
    { id: "queue", label: `队列 · ${queue.length}` },
    { id: "lyrics", label: "歌词" },
    { id: "comments", label: "评论" },
  ];

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-[var(--tv-z-modal)] flex flex-col justify-end xl:static xl:z-auto xl:flex xl:shrink-0"
    >
      {/* Overlay dimmed backdrop (< xl) */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="fixed inset-0 bg-black/55 backdrop-blur-xs xl:hidden"
        aria-label="关闭侧栏遮罩"
      />

      <aside
        ref={drawerPanelRef}
        role={isOverlay ? "dialog" : undefined}
        aria-modal={isOverlay ? true : undefined}
        aria-label="播放详情侧栏"
        className="tv-pb-safe relative flex h-[78dvh] w-full flex-col rounded-t-2xl border-t border-[var(--tv-border-strong)] bg-[var(--tv-sidebar)] shadow-2xl xl:h-full xl:w-[336px] xl:rounded-none xl:border-l xl:border-t-0 xl:border-[var(--tv-border)] xl:shadow-none"
      >
        {/* Mobile/Tablet grab indicator (< xl) */}
        <div className="flex justify-center pt-2 xl:hidden">
          <span className="h-1 w-9 rounded-full bg-[var(--tv-border-strong)]" />
        </div>

        <div className="flex h-13 items-center justify-between border-b border-[var(--tv-border)] px-3.5 xl:h-14">
          <div className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] p-0.5 text-xs">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  tab === item.id
                    ? "bg-[var(--tv-surface-elevated)] text-[var(--tv-text)] shadow-xs"
                    : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            aria-label="收起侧栏"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "queue" && <PlayQueuePanel />}

          {tab === "lyrics" &&
            (!currentTrack ? (
              <div className="py-16 text-center text-xs text-[var(--tv-text-muted)]">播放歌曲后查看歌词</div>
            ) : (
              <LyricScroller
                lines={lyricsQuery.data?.lyrics.lines ?? []}
                loading={lyricsQuery.isLoading}
                error={
                  lyricsQuery.isError
                    ? lyricsQuery.error instanceof Error
                      ? lyricsQuery.error.message
                      : "歌词加载失败"
                    : null
                }
                onRetry={() => void lyricsQuery.refetch()}
              />
            ))}

          {tab === "comments" && <TrackCommentsPanel active={Boolean(open && tab === "comments")} />}
        </div>
      </aside>
    </div>
  );
}
