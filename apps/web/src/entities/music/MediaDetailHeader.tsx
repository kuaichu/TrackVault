import type { ReactNode } from "react";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { CoverArt, ExpandableText } from "../../shared/ui/primitives.js";

function toHiResCoverUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/param=\d+y\d+/, "param=800y800").replace(/T002R\d+x\d+/, "T002R800x800");
}

/**
 * Apple Music-style borderless detail header directly on the main canvas:
 * - Large high-resolution artwork (`224px–236px`) with soft ambient aura, deep shadow, and 0.5px inner rim
 * - Clean eyebrow + bold hero title + bottom-aligned action bar (no enclosing gray card box)
 */
export function MediaDetailHeader({
  coverUrl,
  coverAlt,
  coverRounded = "rounded-[12px]",
  coverClassName = "relative h-44 w-44 shrink-0 shadow-[0_24px_56px_-12px_rgba(0,0,0,0.72)] sm:h-[220px] sm:w-[220px] md:h-[236px] md:w-[236px]",
  containerAlignClass = "sm:items-end",
  eyebrow,
  title,
  titleSuffix,
  meta,
  description,
  expandLabel = "展开介绍",
  collapseLabel = "收起介绍",
  actions,
}: {
  coverUrl?: string;
  coverAlt: string;
  coverRounded?: string;
  coverClassName?: string;
  containerAlignClass?: string;
  /** Kept optional for backwards compatibility; platform text now lives cleanly inside `meta`. */
  platform?: MusicPlatform;
  eyebrow?: ReactNode;
  title: string;
  titleSuffix?: ReactNode;
  meta?: ReactNode;
  description?: string;
  expandLabel?: string;
  collapseLabel?: string;
  actions?: ReactNode;
}) {
  const hiResCoverUrl = toHiResCoverUrl(coverUrl);
  const headerGlow = sanitizeCssUrl(hiResCoverUrl ?? coverUrl);
  const isCircleCover = coverRounded.includes("rounded-full");

  return (
    <section className={`relative flex flex-col gap-6 pt-1 pb-2 sm:flex-row sm:gap-8 ${containerAlignClass}`}>
      <div className="relative shrink-0 self-start">
        {headerGlow && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-4 rounded-3xl bg-cover bg-center opacity-24 blur-3xl saturate-150"
            style={{ backgroundImage: `url("${headerGlow}")` }}
          />
        )}
        <CoverArt
          src={hiResCoverUrl ?? coverUrl}
          alt={coverAlt}
          className={coverClassName}
          rounded={coverRounded}
        />
        {!isCircleCover && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 ${coverRounded}`}
            style={{ boxShadow: "var(--tv-cover-ring)" }}
          />
        )}
      </div>

      <div className="relative min-w-0 flex-1 space-y-2 sm:space-y-2.5">
        {eyebrow && (
          <div className="text-[11.5px] font-semibold tracking-wider text-[var(--tv-text-subtle)] uppercase">
            {eyebrow}
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-2xl leading-tight font-extrabold tracking-tight text-[var(--tv-text)] sm:text-[32px] md:text-[34px]">
            {title}
          </h1>
          {titleSuffix}
        </div>
        {meta}
        {description && (
          <ExpandableText
            text={description}
            expandLabel={expandLabel}
            collapseLabel={collapseLabel}
            className="max-w-2xl"
            textClassName="whitespace-pre-line text-xs leading-relaxed text-[var(--tv-text-muted)]"
          />
        )}
        {actions}
      </div>
    </section>
  );
}
