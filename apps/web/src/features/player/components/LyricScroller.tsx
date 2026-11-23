import { useEffect, useMemo, useRef } from "react";
import type { LyricLine } from "#shared";
import { audioEngine } from "../engine/audio-engine.js";
import { usePlaybackClockStore } from "../store/player-store.js";

/**
 * Isolated leaf component subscribing to high-frequency playback clock for synchronized lyric scrolling.
 */
export function LyricScroller({
  lines,
  loading,
  large = false,
}: {
  lines: LyricLine[];
  loading: boolean;
  large?: boolean;
}) {
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const manualScrollUntilRef = useRef(0);

  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line && line.time <= currentTime + 0.15) {
        idx = i;
      } else {
        break;
      }
    }
    return idx;
  }, [lines, currentTime]);

  useEffect(() => {
    if (activeIndex < 0 || Date.now() < manualScrollUntilRef.current) return;
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIndex]);

  if (loading) {
    return (
      <div className={`py-16 text-center text-sm ${large ? "text-white/50" : "text-[var(--tv-text-muted)]"}`}>
        载入歌词...
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className={`py-16 text-center text-sm ${large ? "text-white/50" : "text-[var(--tv-text-muted)]"}`}>
        纯音乐或暂无歌词
      </div>
    );
  }

  return (
    <div
      onWheel={() => {
        manualScrollUntilRef.current = Date.now() + 3000;
      }}
      className={`tv-lyric-mask h-full overflow-y-auto ${large ? "px-4 py-28 space-y-5" : "px-3 py-12 space-y-2.5"}`}
    >
      {lines.map((line, index) => {
        const isActive = index === activeIndex;
        const distance = activeIndex >= 0 ? Math.abs(index - activeIndex) : 0;

        if (large) {
          return (
            <button
              key={`${line.time}-${index}`}
              ref={isActive ? activeRef : undefined}
              type="button"
              onClick={() => audioEngine.seek(line.time)}
              className={`block w-full origin-left rounded-xl px-3 py-1.5 text-left transition-all duration-300 hover:bg-white/8 hover:text-white ${
                isActive
                  ? "scale-[1.02] text-[26px] font-bold leading-snug text-white"
                  : distance <= 2
                    ? "text-[20px] font-semibold leading-snug text-white/40"
                    : "text-[19px] font-medium leading-snug text-white/25"
              }`}
            >
              <div>{line.text}</div>
              {line.translation && (
                <div className={`mt-1 text-base font-normal ${isActive ? "text-white/75" : "text-white/28"}`}>
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
            onClick={() => audioEngine.seek(line.time)}
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
