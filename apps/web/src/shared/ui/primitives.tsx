import { CheckCircle2, Disc3, Info, X, XCircle } from "lucide-react";
import { useState } from "react";
import { sanitizeExternalUrl } from "#shared";
import { useToastStore } from "../store/toast-store.js";

export function CoverArt({
  src,
  alt,
  className = "h-11 w-11",
}: {
  src?: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const safeSrc = sanitizeExternalUrl(src);

  if (!safeSrc || failed) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-lg bg-[var(--tv-surface-elevated)] text-[var(--tv-text-subtle)] border border-[var(--tv-border)] ${className}`}
        aria-label={alt}
      >
        <Disc3 className="h-1/2 w-1/2" />
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
      className={`shrink-0 rounded-lg object-cover border border-[var(--tv-border)] ${className}`}
    />
  );
}

export function ToastContainer() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <output
      className="fixed right-4 top-4 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
      style={{ zIndex: "var(--tv-z-toast)" }}
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-2xl backdrop-blur-md ${
            item.variant === "error"
              ? "border-rose-500/35 bg-rose-950/90 text-rose-100"
              : item.variant === "success"
                ? "border-emerald-500/35 bg-emerald-950/90 text-emerald-100"
                : "border-white/15 bg-[var(--tv-surface-elevated)]/95 text-[var(--tv-text)]"
          }`}
        >
          {item.variant === "error" ? (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          ) : item.variant === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          )}
          <span className="flex-1 leading-snug">{item.message}</span>
          <button
            type="button"
            onClick={() => dismiss(item.id)}
            className="text-current/60 hover:text-current"
            aria-label="关闭提示"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </output>
  );
}

export function PlatformBadge({ platform }: { platform: "netease" | "qq" }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${
        platform === "netease"
          ? "bg-red-500/15 text-red-300 border border-red-500/25"
          : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/25"
      }`}
    >
      {platform === "netease" ? "网易云" : "QQ音乐"}
    </span>
  );
}
