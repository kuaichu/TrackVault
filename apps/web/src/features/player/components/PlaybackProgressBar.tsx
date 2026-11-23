import { audioEngine } from "../engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Isolated leaf hairline progress stripe for the mobile mini player bar (~4Hz updates).
 */
export function MiniProgressStripe() {
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const duration = usePlaybackClockStore((s) => s.duration);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[var(--tv-border)]">
      <div
        className="h-full bg-[var(--tv-accent)] transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * Isolated leaf component subscribing to high-frequency playback clock (~4Hz).
 * Prevents main layout and song lists from re-rendering during audio playback.
 */
export function PlaybackProgressBar({
  compact = false,
  onDarkBackdrop = false,
}: {
  compact?: boolean;
  onDarkBackdrop?: boolean;
}) {
  const hasTrack = usePlayerStore((s) => s.currentTrack !== null);
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const duration = usePlaybackClockStore((s) => s.duration);
  const bufferedTime = usePlaybackClockStore((s) => s.bufferedTime);

  const disabled = !hasTrack || duration <= 0;
  const safeDuration = duration > 0 ? duration : 1;
  const playedPct = duration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedTime / safeDuration) * 100) : 0;

  const timeClass = onDarkBackdrop ? "text-white/55" : "text-[var(--tv-text-subtle)]";
  const trackBg = onDarkBackdrop ? "bg-white/15" : "bg-[var(--tv-border-strong)]";
  const bufferBg = onDarkBackdrop ? "bg-white/25" : "bg-[var(--tv-text-subtle)]/35";
  const fillBg = onDarkBackdrop ? "bg-white" : "bg-[var(--tv-accent)]";

  return (
    <div className={`group flex items-center gap-2.5 ${compact ? "w-full" : "w-full max-w-[520px]"}`}>
      <span className={`min-w-10 shrink-0 text-right text-[11px] tabular-nums select-none ${timeClass}`}>
        {formatTime(currentTime)}
      </span>
      <div className="relative flex h-4 flex-1 items-center">
        <div
          className={`relative h-[3px] w-full overflow-hidden rounded-full transition-[height] duration-150 ${
            disabled ? "" : "group-hover:h-[5px]"
          } ${trackBg}`}
        >
          <div
            className={`absolute inset-y-0 left-0 transition-[width] duration-200 ${bufferBg}`}
            style={{ width: `${bufferedPct}%` }}
          />
          <div
            className={`absolute inset-y-0 left-0 rounded-full ${fillBg}`}
            style={{ width: `${playedPct}%` }}
          />
        </div>
        {!disabled && (
          <div
            className={`pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 ${
              onDarkBackdrop ? "bg-white" : "bg-[var(--tv-accent)]"
            }`}
            style={{ left: `${playedPct}%` }}
          />
        )}
        <input
          type="range"
          aria-label="播放进度"
          min={0}
          max={Math.max(1, duration)}
          step={0.5}
          disabled={disabled}
          value={disabled ? 0 : Math.min(currentTime, Math.max(1, duration))}
          onChange={(e) => {
            if (!disabled) {
              audioEngine.seek(Number(e.target.value));
            }
          }}
          className={`absolute inset-0 h-full w-full opacity-0 ${
            disabled ? "cursor-default" : "cursor-pointer"
          }`}
        />
      </div>
      <span className={`min-w-10 shrink-0 text-[11px] tabular-nums select-none ${timeClass}`}>
        {formatTime(duration)}
      </span>
    </div>
  );
}
