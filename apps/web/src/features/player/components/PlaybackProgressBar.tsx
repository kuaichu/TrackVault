import { audioEngine } from "../engine/audio-engine.js";
import { usePlaybackClockStore } from "../store/player-store.js";

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Isolated leaf component subscribing to high-frequency playback clock (~4Hz).
 * Prevents main layout and song lists from re-rendering during audio playback.
 */
export function PlaybackProgressBar({ compact = false }: { compact?: boolean }) {
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const duration = usePlaybackClockStore((s) => s.duration);
  const bufferedTime = usePlaybackClockStore((s) => s.bufferedTime);

  const safeDuration = duration > 0 ? duration : 1;
  const playedPct = Math.min(100, (currentTime / safeDuration) * 100);
  const bufferedPct = Math.min(100, (bufferedTime / safeDuration) * 100);

  return (
    <div className={`flex items-center gap-2.5 ${compact ? "w-full" : "w-full max-w-xl"}`}>
      <span className="w-10 text-right text-[11px] tabular-nums text-[var(--tv-text-muted)]">
        {formatTime(currentTime)}
      </span>
      <div className="relative flex h-4 flex-1 items-center">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-200"
            style={{ width: `${bufferedPct}%` }}
          />
          <div className="absolute inset-y-0 left-0 bg-amber-400" style={{ width: `${playedPct}%` }} />
        </div>
        <input
          type="range"
          aria-label="播放进度"
          min={0}
          max={Math.max(1, duration)}
          step={0.5}
          value={Math.min(currentTime, Math.max(1, duration))}
          onChange={(e) => audioEngine.seek(Number(e.target.value))}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      <span className="w-10 text-[11px] tabular-nums text-[var(--tv-text-muted)]">
        {formatTime(duration)}
      </span>
    </div>
  );
}
