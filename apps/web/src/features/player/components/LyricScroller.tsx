import { useEffect, useMemo, useRef } from "react";
import type { LyricLine } from "#shared";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlaybackClockStore } from "../store/player-store.js";

const MANUAL_SCROLL_PAUSE_MS = 3_000;

/**
 * Isolated leaf component subscribing to high-frequency playback clock for synchronized lyric scrolling.
 * Uses container-local `scrollTo` (never `scrollIntoView`) so embedded lyric panes never jump the outer page.
 */
export function LyricScroller({
  lines,
  loading,
  error = null,
  onRetry,
  large = false,
  syncWithClock = true,
  onLineClick,
  emptyText = "纯音乐或暂无歌词",
}: {
  lines: LyricLine[];
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  large?: boolean;
  /** Set false when previewing lyrics of a non-playing track (e.g. unplayed FM candidate). */
  syncWithClock?: boolean;
  onLineClick?: (time: number) => void;
  emptyText?: string;
}) {
  const currentTime = usePlaybackClockStore((s) => (syncWithClock ? s.currentTime : -1));
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const manualScrollUntilRef = useRef(0);

  const pauseAutoFollow = () => {
    manualScrollUntilRef.current = Date.now() + MANUAL_SCROLL_PAUSE_MS;
  };

  const hasVocalLines = useMemo(() => lines.some((line) => line.text.trim().length > 0), [lines]);

  const activeIndex = useMemo(() => {
    if (!syncWithClock || currentTime < 0) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line && line.time <= currentTime + 0.15) {
        idx = i;
      } else {
        break;
      }
    }
    // Empty timestamp line marks an interlude end: clear previous line's highlight naturally
    if (idx >= 0 && !lines[idx]?.text.trim()) {
      return -1;
    }
    return idx;
  }, [lines, currentTime, syncWithClock]);

  useEffect(() => {
    if (!syncWithClock || activeIndex < 0 || Date.now() < manualScrollUntilRef.current) return;
    const container = containerRef.current;
    const activeEl = activeRef.current;
    if (!container || !activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    const targetTop = Math.max(
      0,
      container.scrollTop +
        (activeRect.top - containerRect.top) -
        container.clientHeight / 2 +
        activeRect.height / 2,
    );

    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: targetTop, behavior: "smooth" });
    } else {
      container.scrollTop = targetTop;
    }
  }, [activeIndex, syncWithClock]);

  if (loading) {
    return (
      <div className={`py-16 text-center text-sm ${large ? "text-white/50" : "text-[var(--tv-text-muted)]"}`}>
        载入歌词...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`py-16 text-center text-sm space-y-3 ${large ? "text-white/70" : "text-[var(--tv-text-muted)]"}`}
      >
        <div>{error}</div>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className={`inline-flex items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              large
                ? "bg-white/15 text-white hover:bg-white/25"
                : "bg-[var(--tv-surface)] text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            }`}
          >
            重试
          </button>
        )}
      </div>
    );
  }

  if (!hasVocalLines) {
    return (
      <div className={`py-16 text-center text-sm ${large ? "text-white/50" : "text-[var(--tv-text-muted)]"}`}>
        {emptyText}
      </div>
    );
  }

  const handleLineClick = (time: number) => {
    if (onLineClick) {
      onLineClick(time);
    } else {
      audioEngine.seek(time);
    }
  };

  return (
    <div
      ref={containerRef}
      onWheel={pauseAutoFollow}
      onTouchStart={pauseAutoFollow}
      onTouchMove={pauseAutoFollow}
      onTouchEnd={pauseAutoFollow}
      onPointerDown={pauseAutoFollow}
      onPointerUp={pauseAutoFollow}
      className={`tv-lyric-mask relative h-full overflow-y-auto ${large ? "px-4 py-28 space-y-5" : "px-3 py-12 space-y-2.5"}`}
    >
      {lines.map((line, index) => {
        if (!line.text.trim()) return null;
        const isActive = index === activeIndex;
        const distance = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0;

        if (large) {
          return (
            <button
              key={`${line.time}-${index}`}
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => handleLineClick(line.time)}
              className={`block w-full origin-left rounded-xl px-3 py-1.5 text-left transition-all duration-300 hover:bg-white/8 hover:text-white ${
                isActive
                  ? "scale-[1.02] text-[26px] font-bold leading-snug text-white"
                  : !syncWithClock
                    ? "text-[20px] font-medium leading-snug text-white/60"
                    : distance <= 2
                      ? "text-[20px] font-semibold leading-snug text-white/40"
                      : "text-[19px] font-medium leading-snug text-white/25"
              }`}
            >
              <div>{line.text}</div>
              {line.translation && (
                <div
                  className={`mt-1 text-base font-normal ${
                    isActive ? "text-white/75" : !syncWithClock ? "text-white/45" : "text-white/28"
                  }`}
                >
                  {line.translation}
                </div>
              )}
            </button>
          );
        }

        return (
          <button
            key={`${line.time}-${index}`}
            ref={isActive ? activeRef : undefined}
            type="button"
            onClick={() => handleLineClick(line.time)}
            className={`block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--tv-surface-hover)] ${
              isActive
                ? "text-[14px] font-semibold text-[var(--tv-text)]"
                : "text-[12.5px] text-[var(--tv-text-muted)]"
            }`}
          >
            <div>{line.text}</div>
            {line.translation && (
              <div className="mt-0.5 text-[11.5px] text-[var(--tv-text-subtle)]">{line.translation}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}
