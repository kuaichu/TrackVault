import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { QUALITY_META, type QualityLevel, type Song, getQualityLabel, getSongKey } from "#shared";
import { audioEngine } from "../engine/audio-engine.js";

const CANONICAL_LADDER: ReadonlyArray<{
  level: QualityLevel;
  title: string;
  subtitle: string;
}> = [
  { level: "hires", title: "Hi-Res", subtitle: "高解析度无损" },
  { level: "lossless", title: "FLAC", subtitle: "CD 级无损音质" },
  { level: "exhigh", title: "320K", subtitle: "极高品质" },
  { level: "standard", title: "128K", subtitle: "标准品质" },
];

const EXTRA_HIGH_LEVELS: readonly QualityLevel[] = ["jymaster", "sky", "dolby", "vivid", "jyeffect"];

export function QualitySelectorPopover({
  song,
  activeQuality,
  variant = "player-bar",
}: {
  song: Song;
  activeQuality: QualityLevel;
  variant?: "player-bar" | "fullscreen";
}) {
  const [open, setOpen] = useState(false);
  const songKey = getSongKey(song);
  const prevSongKeyRef = useRef(songKey);
  if (prevSongKeyRef.current !== songKey) {
    prevSongKeyRef.current = songKey;
    if (open) setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const items = useMemo(() => {
    const declaredMap = new Map(song.availableQualities.map((q) => [q.level, q.label]));
    const hasExplicitMultiTiers = song.availableQualities.length >= 2;
    const rows: Array<{
      level: QualityLevel;
      label: string;
      subtitle: string;
      available: boolean;
      unverified: boolean;
    }> = [];

    for (const extra of EXTRA_HIGH_LEVELS) {
      if (declaredMap.has(extra) || activeQuality === extra) {
        rows.push({
          level: extra,
          label: declaredMap.get(extra) ?? QUALITY_META[extra].shortLabel,
          subtitle: QUALITY_META[extra].label,
          available: true,
          unverified: false,
        });
      }
    }

    for (const tier of CANONICAL_LADDER) {
      if (tier.level === "standard" && (declaredMap.has("higher") || activeQuality === "higher")) {
        rows.push({
          level: "higher",
          label: declaredMap.get("higher") ?? "192K",
          subtitle: "较高品质",
          available: true,
          unverified: false,
        });
      }
      const isDeclared = declaredMap.has(tier.level) || tier.level === "standard";
      rows.push({
        level: tier.level,
        label: declaredMap.get(tier.level) ?? tier.title,
        subtitle: tier.subtitle,
        available: isDeclared || !hasExplicitMultiTiers,
        unverified: !isDeclared && !hasExplicitMultiTiers,
      });
    }

    return rows;
  }, [song.availableQualities, activeQuality]);

  const isFullscreen = variant === "fullscreen";
  const buttonTitle = isFullscreen ? "切换音质" : "切换试听音质";

  return (
    <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={buttonTitle}
        aria-label={buttonTitle}
        className={
          isFullscreen
            ? `inline-flex items-center justify-center rounded-lg px-2 py-1 text-[11.5px] font-semibold tracking-wider transition-all duration-150 ${
                open
                  ? "bg-white/14 text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white/95 active:scale-95"
              }`
            : `inline-flex items-center justify-center rounded-md px-1.5 py-1 text-[10px] font-semibold tracking-wider transition-all duration-150 ${
                open
                  ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                  : "bg-transparent text-[var(--tv-text-subtle)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] active:scale-95"
              }`
        }
      >
        <span>{getQualityLabel(activeQuality)}</span>
      </button>

      {open && (
        <div
          className={
            isFullscreen ? "absolute bottom-full right-0 mb-2.5" : "absolute bottom-full right-0 mb-3"
          }
          style={{ zIndex: "var(--tv-z-dropdown)" }}
        >
          <div
            role="menu"
            aria-label="音质选项"
            className={
              isFullscreen
                ? "tv-popover-up w-48 rounded-2xl border border-white/10 bg-[#1d1d22]/88 p-1.5 text-white shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-3xl"
                : "tv-popover-up w-46 rounded-2xl border border-[var(--tv-glass-border)] bg-[var(--tv-surface-elevated)]/92 p-1.5 shadow-[var(--tv-glass-shadow)] backdrop-blur-2xl"
            }
          >
            <div
              className={`px-2.5 py-1 text-[10.5px] font-medium ${
                isFullscreen ? "text-white/50" : "text-[var(--tv-text-subtle)]"
              }`}
            >
              试听音质选择
            </div>
            <div className="space-y-0.5">
              {items.map((item) => {
                const selected = item.level === activeQuality;
                return (
                  <button
                    key={item.level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={!item.available}
                    onClick={() => {
                      setOpen(false);
                      void audioEngine.switchPlaybackQuality(item.level);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                      !item.available
                        ? "cursor-not-allowed opacity-40"
                        : isFullscreen
                          ? selected
                            ? "bg-white/15 font-semibold text-white"
                            : "text-white/85 hover:bg-white/10 hover:text-white"
                          : selected
                            ? "bg-[var(--tv-accent-soft)] font-semibold text-[var(--tv-accent)]"
                            : "text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span>{item.label}</span>
                        <span
                          className={`truncate text-[10px] font-normal ${
                            isFullscreen ? "text-white/50" : "text-[var(--tv-text-subtle)]"
                          }`}
                        >
                          {item.subtitle}
                        </span>
                      </div>
                    </div>

                    {!item.available ? (
                      <span
                        className={`shrink-0 text-[10px] ${
                          isFullscreen ? "text-white/45" : "text-[var(--tv-text-subtle)]"
                        }`}
                      >
                        无音源
                      </span>
                    ) : selected ? (
                      <Check
                        className={`h-3.5 w-3.5 shrink-0 ${
                          isFullscreen ? "text-white" : "text-[var(--tv-accent)]"
                        }`}
                      />
                    ) : item.unverified ? (
                      <span
                        className={`shrink-0 text-[10px] ${
                          isFullscreen ? "text-white/40" : "text-[var(--tv-text-subtle)]"
                        }`}
                      >
                        自动回退
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
