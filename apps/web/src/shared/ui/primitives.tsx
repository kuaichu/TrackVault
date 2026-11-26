import { CheckCircle2, ChevronDown, ChevronUp, Info, Music2, X, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type MusicPlatform,
  getPlatformDisplayName,
  getPlatformShortName,
  sanitizeExternalUrl,
} from "#shared";
import { useToastStore } from "../store/toast-store.js";
export { AppleSelect, type AppleSelectOption } from "./AppleSelect.js";
export { CanvasAmbientGlow, MAIN_AMBIENT_SLOT_ID } from "./CanvasAmbientGlow.js";

export function CoverArt({
  src,
  alt,
  className = "h-10 w-10",
  rounded = "rounded-md",
  darkBackdrop = false,
}: {
  src?: string;
  alt: string;
  className?: string;
  rounded?: string;
  darkBackdrop?: boolean;
}) {
  const safeSrc = sanitizeExternalUrl(src);
  const [prevSafeSrc, setPrevSafeSrc] = useState<string | null>(safeSrc);
  const [failed, setFailed] = useState(false);

  // U07: Clear failure state whenever safeSrc transitions (so A(fail) -> B(ok) -> A retries loading A)
  if (safeSrc !== prevSafeSrc) {
    setPrevSafeSrc(safeSrc);
    if (failed) {
      setFailed(false);
    }
  }

  const fallbackClass = darkBackdrop
    ? "bg-white/10 text-white/45"
    : "bg-[var(--tv-surface)] text-[var(--tv-text-subtle)]";
  const imgSurfaceClass = darkBackdrop ? "bg-white/10" : "bg-[var(--tv-surface)]";

  if (!safeSrc || failed) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center ${fallbackClass} ${rounded} ${className}`}
        aria-label={alt}
      >
        <Music2 className="h-[42%] w-[42%] stroke-[1.6]" />
      </div>
    );
  }

  return (
    <img
      src={safeSrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`shrink-0 object-cover ${imgSurfaceClass} ${rounded} ${className}`}
    />
  );
}

export function ExpandableText({
  text,
  clampClass = "line-clamp-2",
  expandLabel = "展开",
  collapseLabel = "收起",
  className = "",
  textClassName = "",
}: {
  text: string;
  clampClass?: string;
  expandLabel?: string;
  collapseLabel?: string;
  className?: string;
  textClassName?: string;
}) {
  const [expandedForText, setExpandedForText] = useState<string | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const expanded = expandedForText === text;

  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded || !text || !clampClass) {
      if (!text) setIsOverflowing(false);
      return;
    }

    const measure = () => {
      if (!textRef.current) return;
      setIsOverflowing(textRef.current.scrollHeight - textRef.current.clientHeight > 1);
    };

    measure();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, expanded, clampClass]);

  return (
    <div className={className}>
      <p ref={textRef} className={`${textClassName} ${expanded ? "" : clampClass}`.trim()}>
        {text}
      </p>
      {(expanded || isOverflowing) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpandedForText((prev) => (prev === text ? null : text))}
          className="mt-1 inline-flex items-center gap-0.5 rounded text-[11px] font-medium text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)]"
        >
          {expanded ? (
            <>
              {collapseLabel} <ChevronUp className="h-3 w-3" />
            </>
          ) : (
            <>
              {expandLabel} <ChevronDown className="h-3 w-3" />
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function PlatformBadge({
  platform,
  subtle = false,
}: {
  platform: MusicPlatform;
  subtle?: boolean;
}) {
  const dotColor =
    platform === "netease"
      ? "bg-[var(--tv-netease)]"
      : platform === "qq"
        ? "bg-[var(--tv-qq)]"
        : "bg-[var(--tv-kugou)]";
  const label = getPlatformShortName(platform);

  if (subtle) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--tv-text-subtle)]"
        title={getPlatformDisplayName(platform)}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        {label}
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[var(--tv-surface)] text-[var(--tv-text-muted)]">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      {label}
    </span>
  );
}

export function EqualizerBars({ tone = "accent" }: { tone?: "accent" | "light" } = {}) {
  const barColorClass = tone === "light" ? "bg-white/90" : "bg-[var(--tv-accent)]";
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-label="播放中">
      <span
        className={`tv-eq-bar h-full w-[2.5px] rounded-full ${barColorClass}`}
        style={{ animationDelay: "0ms" }}
      />
      <span
        className={`tv-eq-bar h-full w-[2.5px] rounded-full ${barColorClass}`}
        style={{ animationDelay: "220ms" }}
      />
      <span
        className={`tv-eq-bar h-full w-[2.5px] rounded-full ${barColorClass}`}
        style={{ animationDelay: "440ms" }}
      />
    </span>
  );
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  fullWidthOnMobile = false,
  compact = false,
}: {
  items: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  fullWidthOnMobile?: boolean;
  compact?: boolean;
}) {
  return (
    <div
      className={`items-center rounded-[9px] bg-[var(--tv-lcd-bg)] p-[3px] ring-1 ring-[var(--tv-sidebar-border)] ring-inset ${
        fullWidthOnMobile ? "grid w-full grid-cols-2 sm:inline-flex sm:w-auto" : "inline-flex"
      } ${compact ? "text-[11.5px]" : "text-xs"}`}
    >
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`rounded-[7px] text-center font-medium transition-all duration-150 ${
              compact
                ? "px-2.5 py-[3.5px]"
                : fullWidthOnMobile
                  ? "px-3 py-1.5 sm:px-2.5 sm:py-1"
                  : "px-2.5 py-1"
            } ${
              active
                ? "bg-[var(--tv-nav-active)] text-[var(--tv-text)] shadow-xs"
                : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-sm font-medium text-[var(--tv-text)]">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-xs text-[var(--tv-text-muted)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ToastContainer() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <output
      className="fixed bottom-36 left-4 right-4 flex flex-col gap-2 pointer-events-none md:bottom-26 md:left-auto md:right-6 md:w-full md:max-w-xs"
      style={{ zIndex: "var(--tv-z-toast)" }}
      aria-live="polite"
    >
      {items.map((item) => {
        const safeActionHref = item.action ? sanitizeExternalUrl(item.action.href) : null;
        return (
          <div
            key={item.id}
            className="tv-toast-enter pointer-events-auto flex items-start gap-2.5 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)]/95 px-3.5 py-2.5 text-[13px] text-[var(--tv-text)] shadow-xl backdrop-blur-xl"
          >
            {item.variant === "error" ? (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-danger)]" />
            ) : item.variant === "success" ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-success)]" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-text-muted)]" />
            )}
            <div className="min-w-0 flex-1 space-y-1.5 leading-snug">
              <span className="block break-words">{item.message}</span>
              {item.action && safeActionHref && (
                <a
                  href={safeActionHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => dismiss(item.id)}
                  className="inline-flex items-center rounded-md bg-[var(--tv-accent)] px-2.5 py-1 text-xs font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)]"
                >
                  {item.action.label}
                </a>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
              aria-label="关闭提示"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </output>
  );
}
