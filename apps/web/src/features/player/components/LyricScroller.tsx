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
    return <div className="py-12 text-center text-sm text-[var(--tv-text-muted)]">加载歌词中...</div>;
  }

  if (lines.length === 0) {
    return <div className="py-12 text-center text-sm text-[var(--tv-text-muted)]">纯音乐或暂无同步歌词</div>;
  }

  return (
    <div
      onWheel={() => {
        manualScrollUntilRef.current = Date.now() + 3000;
      }}
      className="h-full overflow-y-auto px-3 py-10 space-y-3"
    >
      {lines.map((line, index) => {
        const isActive = index === activeIndex;
        return (
          <button
            key={`${line.time}-${index}`}
            ref={isActive ? activeRef : undefined}
            type="button"
            onClick={() => audioEngine.seek(line.time)}
            className={`block w-full rounded-xl px-3 py-1.5 text-left transition-all hover:bg-white/5 ${
              isActive
                ? large
                  ? "text-xl font-semibold text-amber-300"
                  : "text-sm font-semibold text-amber-300"
                : large
                  ? "text-base text-white/55"
                  : "text-xs text-[var(--tv-text-muted)]"
            }`}
          >
            <div>{line.text}</div>
            {line.translation && (
              <div className={`mt-0.5 ${isActive ? "text-amber-200/80" : "text-white/35"} text-xs`}>
                {line.translation}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
