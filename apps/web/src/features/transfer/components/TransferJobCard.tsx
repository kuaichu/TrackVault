import { ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import type {
  CompareResult,
  ImportAuditResult,
  JobDetailView,
  JobSummaryView,
  TransferResult,
} from "#shared";
import { useJobDetailQuery } from "../../../entities/job/index.js";
import { JOB_STATUS_LABELS } from "../transfer-constants.js";
import { CompareResultViewer } from "./CompareResultViewer.js";
import { ImportAuditResultViewer } from "./ImportAuditResultViewer.js";
import { JobExportBar } from "./JobExportBar.js";
import { TransferResultViewer } from "./TransferResultViewer.js";

function getInlineJobResult(job: JobSummaryView | JobDetailView): unknown {
  return "result" in job ? job.result : undefined;
}

export function TransferJobCard({
  job,
  isExpanded,
  onToggleExpand,
  onCancel,
  cancelPending,
}: {
  job: JobSummaryView;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onCancel: (id: string) => void;
  cancelPending: boolean;
}) {
  const inlineResult = getInlineJobResult(job);
  const needsLazyDetail = isExpanded && job.status === "completed" && inlineResult === undefined;
  const detailQuery = useJobDetailQuery(job.id, needsLazyDetail);
  const resolvedJob: JobDetailView =
    detailQuery.data?.job ?? (inlineResult !== undefined ? { ...job, result: inlineResult } : job);
  const resolvedResult = inlineResult ?? detailQuery.data?.job?.result;

  return (
    <div className="py-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--tv-text)]">{job.title}</div>
          <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">
            {job.errorMessage ?? job.subtitle ?? JOB_STATUS_LABELS[job.status]}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-[var(--tv-text-muted)]">
            {job.status === "running" ? `${job.progress}%` : JOB_STATUS_LABELS[job.status]}
          </span>
          {job.status === "completed" && (
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={onToggleExpand}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  收起详情
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  展开详情
                </>
              )}
            </button>
          )}
          {(job.status === "queued" || job.status === "running") && (
            <button
              type="button"
              disabled={cancelPending}
              onClick={() => onCancel(job.id)}
              className="rounded-md p-1 text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-danger)] disabled:opacity-40"
              aria-label="取消任务"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {isExpanded &&
        job.status === "completed" &&
        (resolvedResult === undefined && detailQuery.isLoading ? (
          <div className="flex items-center gap-2 rounded-xl bg-[var(--tv-surface)] px-4 py-4 text-xs text-[var(--tv-text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载任务详情...
          </div>
        ) : resolvedResult === undefined && detailQuery.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--tv-danger)]/25 bg-[var(--tv-danger)]/10 px-4 py-3 text-xs text-[var(--tv-danger)]">
            <span>
              加载任务详情失败：
              {detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
            </span>
            <button
              type="button"
              onClick={() => void detailQuery.refetch()}
              className="rounded-lg bg-[var(--tv-surface)] px-3 py-1 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            >
              重试
            </button>
          </div>
        ) : resolvedResult !== undefined ? (
          <>
            {job.kind === "transfer" && (
              <TransferResultViewer job={resolvedJob} result={resolvedResult as TransferResult} />
            )}
            {job.kind === "import_audit" && (
              <ImportAuditResultViewer result={resolvedResult as ImportAuditResult} />
            )}
            {job.kind === "compare" && <CompareResultViewer result={resolvedResult as CompareResult} />}
            <JobExportBar job={resolvedJob} />
          </>
        ) : (
          <JobExportBar job={resolvedJob} />
        ))}
    </div>
  );
}
