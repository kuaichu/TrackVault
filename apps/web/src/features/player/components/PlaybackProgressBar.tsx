import { audioEngine } from "../engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * Isolated leaf hairline progress stripe for the mobile Liquid Glass mini player (~4Hz updates).
 */
export function MiniProgressStripe() {
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const duration = usePlaybackClockStore((s) => s.duration);
  const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-0 h-[2px] overflow-hidden rounded-full bg-[var(--tv-slider-track)]">
      <div
        className="h-full rounded-full bg-[var(--tv-slider-fill)] transition-[width] duration-150"
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
  stackedTimestamps = false,
  variant,
}: {
  compact?: boolean;
  onDarkBackdrop?: boolean;
  /** Apple Music full-width layout: stretches bar flush with album cover and places subtle timestamps underneath. */
  stackedTimestamps?: boolean;
  /**
   * - `inline`: classic horizontal `[00:29] ━━━ [04:26]`
   * - `stacked`: full-width bar with subtle timestamps underneath (FullscreenPlayer)
   * - `lcd`: docked along the bottom edge of the floating desktop capsule, freeing vertical space around song text
   */
  variant?: "inline" | "stacked" | "lcd";
}) {
  const resolvedVariant = variant ?? (stackedTimestamps ? "stacked" : "inline");
  const hasTrack = usePlayerStore((s) => s.currentTrack !== null);
  const currentTime = usePlaybackClockStore((s) => s.currentTime);
  const duration = usePlaybackClockStore((s) => s.duration);
  const bufferedTime = usePlaybackClockStore((s) => s.bufferedTime);

  const disabled = !hasTrack || duration <= 0;
  const safeDuration = duration > 0 ? duration : 1;
  const playedPct = duration > 0 ? Math.min(100, (currentTime / safeDuration) * 100) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, (bufferedTime / safeDuration) * 100) : 0;

  if (resolvedVariant === "lcd") {
    return (
      <div
        data-layout="lcd"
        className="group/scrubber absolute inset-x-5 bottom-[1px] flex h-3.5 items-center"
      >
        <div
          className={`pointer-events-none absolute inset-x-0 -top-3.5 flex items-center justify-between text-[10px] font-medium tracking-tight text-[var(--tv-text-subtle)] opacity-0 transition-opacity duration-150 tabular-nums select-none ${
            disabled ? "" : "group-hover/scrubber:opacity-80"
          }`}
        >
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>

        <div
          className={`relative h-[2px] w-full overflow-hidden rounded-full bg-[var(--tv-slider-track)] transition-[height] duration-150 ${
            disabled ? "" : "group-hover/scrubber:h-[4px]"
          }`}
        >
          <div
            className="absolute inset-y-0 left-0 bg-[var(--tv-slider-buffer)] transition-[width] duration-200"
            style={{ width: `${bufferedPct}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--tv-slider-fill)]"
            style={{ width: `${playedPct}%` }}
          />
        </div>

        {!disabled && (
          <div
            className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--tv-text)] opacity-0 shadow-xs transition-opacity duration-150 group-hover/scrubber:opacity-100"
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
    );
  }

  const isStacked = resolvedVariant === "stacked";
  const timeClass = onDarkBackdrop
    ? isStacked
      ? "text-white/40"
      : "text-white/55"
    : "text-[var(--tv-text-subtle)]";
  const trackBg = onDarkBackdrop ? "bg-white/18" : "bg-[var(--tv-slider-track)]";
  const bufferBg = onDarkBackdrop ? "bg-white/28" : "bg-[var(--tv-slider-buffer)]";
  const fillBg = onDarkBackdrop
    ? isStacked
      ? "bg-white/80 transition-colors group-hover:bg-white"
      : "bg-white"
    : "bg-[var(--tv-slider-fill)]";

  const sliderBar = (
    <div className={`relative flex items-center ${isStacked ? "h-4 w-full" : "h-4 flex-1"}`}>
      <div
        className={`relative w-full overflow-hidden rounded-full transition-[height] duration-150 ${
          isStacked ? "h-[4px]" : "h-[3px]"
        } ${disabled ? "" : isStacked ? "group-hover:h-[6px]" : "group-hover:h-[4.5px]"} ${trackBg}`}
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
            onDarkBackdrop ? "bg-white" : "bg-[var(--tv-text)]"
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
  );

  if (isStacked) {
    return (
      <div data-layout="stacked-timestamps" className="group w-full">
        {sliderBar}
        <div className="mt-1 flex items-center justify-between text-[10.5px] font-medium tracking-wide tabular-nums select-none">
          <span className={timeClass}>{formatTime(currentTime)}</span>
          <span className={timeClass}>{formatTime(duration)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`group flex items-center gap-2.5 ${compact ? "w-full" : "w-full max-w-[520px]"}`}>
      <span className={`min-w-10 shrink-0 text-right text-[11px] tabular-nums select-none ${timeClass}`}>
        {formatTime(currentTime)}
      </span>
      {sliderBar}
      <span className={`min-w-10 shrink-0 text-[11px] tabular-nums select-none ${timeClass}`}>
        {formatTime(duration)}
      </span>
    </div>
  );
}
