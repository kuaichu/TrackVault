import { useState } from "react";
import { type CompareResult, formatScanStatsSummary } from "#shared";
import {
  COMPARE_STATUS_BADGE_CLASS,
  COMPARE_STATUS_LABELS,
  type CompareFilter,
  TRANSFER_PAGE_SIZE,
} from "../transfer-constants.js";
import { ScanTruncationNotice } from "./ScanTruncationNotice.js";

export function CompareResultViewer({ result }: { result: CompareResult }) {
  const [filter, setFilter] = useState<CompareFilter>("all");
  const [visibleCount, setVisibleCount] = useState(TRANSFER_PAGE_SIZE);

  const filtered = filter === "all" ? result.items : result.items.filter((item) => item.status === filter);
  const shown = filtered.slice(0, visibleCount);

  const leftSummary = formatScanStatsSummary(result.left, {
    subjectLabel: "歌单 A",
    processedVerb: "已获取",
    limitLabel: "单次对比上限",
  });
  const rightSummary = formatScanStatsSummary(result.right, {
    subjectLabel: "歌单 B",
    processedVerb: "已获取",
    limitLabel: "单次对比上限",
  });
  const combinedTruncationText = [leftSummary.summaryText, rightSummary.summaryText]
    .filter(Boolean)
    .join("；");

  return (
    <div className="space-y-3">
      <ScanTruncationNotice message={combinedTruncationText ? `${combinedTruncationText}。` : ""} />

      <div className="grid grid-cols-2 gap-3 rounded-xl bg-[var(--tv-surface)] p-3.5 text-xs sm:grid-cols-5">
        <div>
          <div className="text-[var(--tv-text-subtle)]">完全一致</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-success)]">
            {result.summary.exact}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">相似歌名</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-amber-500">
            {result.summary.similarTitle}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">同名异唱</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-amber-500">
            {result.summary.sameTitleDifferentArtist}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">仅歌单 A</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
            {result.summary.leftOnly}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">仅歌单 B</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
            {result.summary.rightOnly}
          </div>
        </div>
      </div>

      {/* Filter Pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {(
          [
            { id: "all", label: `全部 (${result.items.length})` },
            { id: "exact", label: `完全一致 (${result.summary.exact})` },
            { id: "similar_title", label: `相似歌名 (${result.summary.similarTitle})` },
            {
              id: "same_title_different_artist",
              label: `同名异唱 (${result.summary.sameTitleDifferentArtist})`,
            },
            { id: "left_only", label: `仅歌单 A (${result.summary.leftOnly})` },
            { id: "right_only", label: `仅歌单 B (${result.summary.rightOnly})` },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setFilter(tab.id);
              setVisibleCount(TRANSFER_PAGE_SIZE);
            }}
            className={`rounded-full px-3 py-1 transition-colors ${
              filter === tab.id
                ? "bg-[var(--tv-accent)] font-medium text-[var(--tv-accent-fg)]"
                : "bg-[var(--tv-surface)] text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Diff Items List */}
      <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--tv-border)] rounded-xl bg-[var(--tv-surface)] text-xs">
        {shown.length === 0 ? (
          <div className="px-4 py-6 text-center text-[var(--tv-text-subtle)]">当前筛选下暂无对比条目</div>
        ) : (
          shown.map((item, idx) => (
            <div
              key={`${item.status}-${item.left?.title ?? ""}-${item.right?.title ?? ""}-${idx}`}
              className="flex flex-wrap items-start justify-between gap-2 px-3.5 py-2.5"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                {item.left && (
                  <div className="truncate text-[var(--tv-text)]">
                    <span className="mr-1.5 font-semibold text-[var(--tv-text-subtle)]">A</span>
                    {item.left.title}
                    {item.left.artists.length > 0 && (
                      <span className="text-[var(--tv-text-muted)]"> — {item.left.artists.join(" / ")}</span>
                    )}
                  </div>
                )}
                {item.right && (
                  <div className="truncate text-[var(--tv-text)]">
                    <span className="mr-1.5 font-semibold text-[var(--tv-text-subtle)]">B</span>
                    {item.right.title}
                    {item.right.artists.length > 0 && (
                      <span className="text-[var(--tv-text-muted)]"> — {item.right.artists.join(" / ")}</span>
                    )}
                  </div>
                )}
                {item.reason && <div className="text-[11px] text-[var(--tv-text-subtle)]">{item.reason}</div>}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {item.score > 0 && (
                  <span className="tabular-nums text-[11px] text-[var(--tv-text-subtle)]">
                    {item.score}分
                  </span>
                )}
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${COMPARE_STATUS_BADGE_CLASS[item.status]}`}
                >
                  {COMPARE_STATUS_LABELS[item.status]}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-subtle)]">
          <span className="tabular-nums">
            已显示 {shown.length} / {filtered.length} 项
          </span>
          {shown.length < filtered.length && (
            <button
              type="button"
              onClick={() => setVisibleCount((prev) => prev + TRANSFER_PAGE_SIZE)}
              className="rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            >
              加载更多（剩余 {filtered.length - shown.length} 项）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
