import { CheckCircle2, Info, Music2, X, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";
import { sanitizeExternalUrl } from "#shared";
import { useToastStore } from "../store/toast-store.js";

export function CoverArt({
  src,
  alt,
  className = "h-10 w-10",
  rounded = "rounded-md",
}: {
  src?: string;
  alt: string;
  className?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const safeSrc = sanitizeExternalUrl(src);

  if (!safeSrc || failed) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-[var(--tv-surface)] text-[var(--tv-text-subtle)] ${rounded} ${className}`}
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
      className={`shrink-0 object-cover bg-[var(--tv-surface)] ${rounded} ${className}`}
    />
  );
}

export function PlatformBadge({
  platform,
  subtle = false,
}: {
  platform: "netease" | "qq";
  subtle?: boolean;
}) {
  const dotColor = platform === "netease" ? "bg-[var(--tv-netease)]" : "bg-[var(--tv-qq)]";
  const label = platform === "netease" ? "网易云" : "QQ";

  if (subtle) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[var(--tv-text-subtle)]"
        title={platform === "netease" ? "网易云音乐" : "QQ 音乐"}
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

export function EqualizerBars() {
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]" aria-label="播放中">
      <span
        className="tv-eq-bar h-full w-[2.5px] rounded-full bg-[var(--tv-accent)]"
        style={{ animationDelay: "0ms" }}
      />
      <span
        className="tv-eq-bar h-full w-[2.5px] rounded-full bg-[var(--tv-accent)]"
        style={{ animationDelay: "220ms" }}
      />
      <span
        className="tv-eq-bar h-full w-[2.5px] rounded-full bg-[var(--tv-accent)]"
        style={{ animationDelay: "440ms" }}
      />
    </span>
  );
}

export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
}: {
  items: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] p-0.5 text-xs">
      {items.map((item) => {
        const active = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`rounded-md px-3 py-1.5 font-medium transition-all ${
              active
                ? "bg-[var(--tv-surface-elevated)] text-[var(--tv-text)] shadow-xs"
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
      className="fixed bottom-36 left-4 right-4 flex flex-col gap-2 pointer-events-none md:bottom-24 md:left-auto md:right-5 md:w-full md:max-w-xs"
      style={{ zIndex: "var(--tv-z-toast)" }}
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)]/95 px-3.5 py-2.5 text-[13px] text-[var(--tv-text)] shadow-xl backdrop-blur-xl"
        >
          {item.variant === "error" ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-danger)]" />
          ) : item.variant === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-success)]" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-text-muted)]" />
          )}
          <span className="flex-1 leading-snug">{item.message}</span>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            className="text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
            aria-label="关闭提示"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </output>
  );
}
