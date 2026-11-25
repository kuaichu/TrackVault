import { useState } from "react";
import { type ImportAuditResult, formatScanStatsSummary } from "#shared";
import {
  AUDIT_ISSUE_BADGE_CLASS,
  AUDIT_ISSUE_LABELS,
  AVAILABILITY_LABELS,
  TRANSFER_PAGE_SIZE,
} from "../transfer-constants.js";
import { ScanTruncationNotice } from "./ScanTruncationNotice.js";

export function ImportAuditResultViewer({ result }: { result: ImportAuditResult }) {
  const [visibleCount, setVisibleCount] = useState(TRANSFER_PAGE_SIZE);
  const shownIssues = result.issues.slice(0, visibleCount);
  const scanSummary = formatScanStatsSummary(result, {
    subjectLabel: "源歌单",
    processedVerb: "已扫描",
    limitLabel: "单次扫描上限",
  });

  return (
    <div className="space-y-3">
      <ScanTruncationNotice message={scanSummary.summaryText} />

      <div className="grid max-w-md grid-cols-3 gap-3 rounded-xl bg-[var(--tv-surface)] p-3.5 text-xs">
        <div>
          <div className="text-[var(--tv-text-subtle)]">扫描总数</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
            {result.scannedCount}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">正常可播</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-success)]">
            {result.playableCount}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">异常曲目</div>
          <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-danger)]">
            {result.issueCount}
          </div>
        </div>
      </div>

      {result.issues.length === 0 ? (
        <div className="rounded-xl bg-[var(--tv-surface)] px-4 py-3 text-xs text-[var(--tv-text-muted)]">
          未发现异常曲目，所有已扫描曲目均可正常播放。
        </div>
      ) : (
        <>
          <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--tv-border)] rounded-xl bg-[var(--tv-surface)] text-xs">
            {shownIssues.map((issue, idx) => (
              <div key={`${issue.trackId}-${idx}`} className="space-y-2 px-3.5 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--tv-text)]">
                      {issue.title}
                      {issue.artists.length > 0 && (
                        <span className="font-normal text-[var(--tv-text-muted)]">
                          {" "}
                          — {issue.artists.join(" / ")}
                        </span>
                      )}
                      {issue.album && (
                        <span className="font-normal text-[var(--tv-text-subtle)]"> · {issue.album}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--tv-text-subtle)]">{issue.reason}</div>
                  </div>
                  <span
                    className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${AUDIT_ISSUE_BADGE_CLASS[issue.issueType]}`}
                  >
                    {AUDIT_ISSUE_LABELS[issue.issueType]}
                  </span>
                </div>

                {issue.replacements.length > 0 && (
                  <div className="space-y-1 rounded-lg bg-[var(--tv-bg)] p-2">
                    <div className="text-[11px] font-medium text-[var(--tv-text-subtle)]">
                      替代候选（{issue.replacements.length}）
                    </div>
                    {issue.replacements.map((rep) => (
                      <div
                        key={rep.targetTrackId}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="truncate text-[var(--tv-text)]">
                          {rep.title}
                          {rep.artists.length > 0 && (
                            <span className="text-[var(--tv-text-muted)]"> — {rep.artists.join(" / ")}</span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums text-[var(--tv-text-subtle)]">
                          {rep.confidenceScore}分
                          {rep.availability ? ` · ${AVAILABILITY_LABELS[rep.availability]}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-subtle)]">
            <span className="tabular-nums">
              已显示 {shownIssues.length} / {result.issues.length} 首异常曲目
            </span>
            {shownIssues.length < result.issues.length && (
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + TRANSFER_PAGE_SIZE)}
                className="rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
              >
                加载更多（剩余 {result.issues.length - shownIssues.length} 首）
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
