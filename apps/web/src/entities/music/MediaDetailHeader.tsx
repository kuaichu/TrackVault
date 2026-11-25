import type { ReactNode } from "react";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { CoverArt, ExpandableText, PlatformBadge } from "../../shared/ui/primitives.js";

/**
 * Shared glassmorphic header banner for Album, Artist, Chart, and Playlist detail views.
 */
export function MediaDetailHeader({
  coverUrl,
  coverAlt,
  coverRounded = "rounded-xl",
  coverClassName = "relative h-32 w-32 shrink-0 shadow-2xl sm:h-44 sm:w-44",
  containerAlignClass = "sm:items-end",
  platform,
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
  platform: MusicPlatform;
  title: string;
  titleSuffix?: ReactNode;
  meta?: ReactNode;
  description?: string;
  expandLabel?: string;
  collapseLabel?: string;
  actions?: ReactNode;
}) {
  const headerGlow = sanitizeCssUrl(coverUrl);

  return (
    <section
      className={`relative flex flex-col gap-5 overflow-hidden rounded-2xl bg-[var(--tv-surface)]/55 p-4 sm:flex-row sm:gap-6 sm:p-6 ${containerAlignClass}`}
    >
      {headerGlow && (
        <div
          className="pointer-events-none absolute -top-24 left-0 h-72 w-72 rounded-full bg-cover bg-center opacity-20 blur-3xl"
          style={{ backgroundImage: `url("${headerGlow}")` }}
        />
      )}

      <CoverArt src={coverUrl} alt={coverAlt} className={coverClassName} rounded={coverRounded} />

      <div className="relative min-w-0 flex-1 space-y-2.5 sm:space-y-3">
        <PlatformBadge platform={platform} subtle />
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-3xl">{title}</h1>
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
