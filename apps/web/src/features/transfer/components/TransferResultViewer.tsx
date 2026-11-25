import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw } from "lucide-react";
import { useState } from "react";
import {
  type JobDetailView,
  type JobSummaryView,
  type JobView,
  type JobsListResponse,
  type TransferResult,
  type TransferTrackResult,
  type UpdateTransferSelectionInput,
  formatScanStatsSummary,
} from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import {
  AVAILABILITY_LABELS,
  TRANSFER_PAGE_SIZE,
  TRANSFER_STATUS_BADGE_CLASS,
  TRANSFER_STATUS_LABELS,
  type TransferFilter,
} from "../transfer-constants.js";
import { ScanTruncationNotice } from "./ScanTruncationNotice.js";

function getInlineJobResult(job: JobSummaryView | JobDetailView): unknown {
  return "result" in job ? job.result : undefined;
}

function matchesTransferFilter(item: TransferTrackResult, filter: TransferFilter): boolean {
  if (filter === "all") return true;
  if (filter === "manual_review") return item.status === "manual_review";
  if (filter === "matched") return item.status === "matched";
  return item.status !== "matched" && item.status !== "manual_review";
}

export function TransferResultViewer({ job, result }: { job: JobView; result: TransferResult }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [visibleCount, setVisibleCount] = useState(TRANSFER_PAGE_SIZE);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  const selectionMutation = useMutation({
    mutationFn: (input: UpdateTransferSelectionInput) => api.updateTransferSelection(job.id, input),
    onMutate: (input) => {
      setPendingIndex(input.index);
    },
    onSuccess: ({ job: updatedJob }) => {
      queryClient.setQueryData<{ job: JobDetailView }>(["job", updatedJob.id], { job: updatedJob });
      queryClient.setQueryData<JobsListResponse>(["jobs", "transfer"], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          jobs: prev.jobs.map((entry) =>
            entry.id === updatedJob.id
              ? getInlineJobResult(entry) !== undefined
                ? updatedJob
                : { ...entry, ...updatedJob, result: undefined }
              : entry,
          ),
        };
      });
      void queryClient.invalidateQueries({ queryKey: ["job", updatedJob.id] });
      void queryClient.invalidateQueries({ queryKey: ["jobs", "transfer"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "更新曲目选择失败");
    },
    onSettled: () => {
      setPendingIndex(null);
    },
  });

  const indexed = result.results.map((item, originalIndex) => ({ item, originalIndex }));
  const filtered = indexed.filter(({ item }) => matchesTransferFilter(item, filter));
  const shown = filtered.slice(0, visibleCount);
  const issuesCount =
    result.summary.notFound + result.summary.unavailable + result.summary.duplicate + result.summary.skipped;
  const scanSummary = formatScanStatsSummary(result, {
    subjectLabel: "源歌单",
    processedVerb: "已处理",
    limitLabel: "单次处理上限",
  });

  return (
    <div className="space-y-3">
      <ScanTruncationNotice message={scanSummary.summaryText} />

      {/* Summary Strip */}
      <div className="grid grid-cols-2 gap-2.5 rounded-xl bg-[var(--tv-surface)] p-3 text-xs sm:grid-cols-5">
        <div>
          <div className="text-[var(--tv-text-subtle)]">已匹配</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-[var(--tv-success)]">
            {result.summary.matched}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">待确认</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-amber-500">
            {result.summary.manualReview}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">不可用</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-[var(--tv-danger)]">
            {result.summary.unavailable}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">未找到</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-[var(--tv-text-muted)]">
            {result.summary.notFound}
          </div>
        </div>
        <div>
          <div className="text-[var(--tv-text-subtle)]">重复 / 跳过</div>
          <div className="mt-0.5 text-base font-bold tabular-nums text-[var(--tv-text-subtle)]">
            {result.summary.duplicate} / {result.summary.skipped}
          </div>
        </div>
      </div>

      {/* Filter Pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {(
          [
            { id: "all", label: `全部 (${result.results.length})` },
            { id: "manual_review", label: `待确认 (${result.summary.manualReview})` },
            { id: "matched", label: `已匹配 (${result.summary.matched})` },
            { id: "issues", label: `异常与未找到 (${issuesCount})` },
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

      {/* Paginated Results List */}
      <div className="max-h-[420px] overflow-y-auto divide-y divide-[var(--tv-border)] rounded-xl bg-[var(--tv-surface)] text-xs">
        {shown.length === 0 ? (
          <div className="px-4 py-6 text-center text-[var(--tv-text-subtle)]">当前筛选下暂无曲目</div>
        ) : (
          shown.map(({ item, originalIndex }) => {
            const isRowBusy = pendingIndex === originalIndex;
            const hasCandidates = item.candidates.length > 0;
            const showCandidates =
              hasCandidates && (item.status === "manual_review" || Boolean(expandedRows[originalIndex]));

            return (
              <div
                key={`${item.sourceTrack.sourceTrackId ?? item.sourceTrack.title}-${originalIndex}`}
                className="space-y-2 px-3.5 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-[var(--tv-text)]">
                      {item.sourceTrack.title}
                      {item.sourceTrack.artists.length > 0 && (
                        <span className="font-normal text-[var(--tv-text-muted)]">
                          {" "}
                          — {item.sourceTrack.artists.join(" / ")}
                        </span>
                      )}
                    </div>
                    {item.selectedCandidate ? (
                      <div className="mt-0.5 space-y-0.5 text-[11px]">
                        <div className="truncate text-[var(--tv-text-muted)]">
                          已选：{item.selectedCandidate.title} — {item.selectedCandidate.artists.join(" / ")}{" "}
                          · {item.selectedCandidate.confidenceScore}分
                          {item.selectedCandidate.availability &&
                          item.selectedCandidate.availability !== "playable" &&
                          item.selectedCandidate.availability !== "unknown"
                            ? ` · ${AVAILABILITY_LABELS[item.selectedCandidate.availability]}`
                            : ""}
                        </div>
                        {item.status !== "matched" && item.reason && (
                          <div className="truncate text-[var(--tv-text-subtle)]">{item.reason}</div>
                        )}
                      </div>
                    ) : item.reason ? (
                      <div className="mt-0.5 truncate text-[11px] text-[var(--tv-text-subtle)]">
                        {item.reason}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {item.manualDecision && (
                      <span
                        className="rounded-md bg-[var(--tv-accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--tv-accent)]"
                        title={
                          item.initialMatch
                            ? `可点击“重置”无损恢复为初始状态：${TRANSFER_STATUS_LABELS[item.initialMatch.status]}`
                            : "已人工确认，可点击“重置”恢复"
                        }
                      >
                        {item.manualDecision.action === "select" ? "人工已选" : "人工跳过"}
                      </span>
                    )}
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${TRANSFER_STATUS_BADGE_CLASS[item.status]}`}
                    >
                      {TRANSFER_STATUS_LABELS[item.status]}
                    </span>

                    {hasCandidates && item.status !== "manual_review" && (
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() =>
                          setExpandedRows((prev) => ({
                            ...prev,
                            [originalIndex]: !prev[originalIndex],
                          }))
                        }
                        className="rounded-md bg-[var(--tv-bg)] px-2 py-0.5 text-[11px] text-[var(--tv-text-muted)] hover:text-[var(--tv-text)] disabled:opacity-40"
                      >
                        {expandedRows[originalIndex] ? "收起候选" : `候选 (${item.candidates.length})`}
                      </button>
                    )}

                    {item.status !== "skipped" && item.status !== "duplicate" && (
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() => selectionMutation.mutate({ index: originalIndex, action: "skip" })}
                        className="rounded-md bg-[var(--tv-bg)] px-2 py-0.5 text-[11px] text-[var(--tv-text-muted)] hover:text-[var(--tv-danger)] disabled:opacity-40"
                      >
                        跳过
                      </button>
                    )}

                    {(Boolean(item.manualDecision) ||
                      item.status === "skipped" ||
                      (item.status === "matched" && hasCandidates)) && (
                      <button
                        type="button"
                        disabled={isRowBusy}
                        title={
                          item.initialMatch
                            ? `无损恢复为初始状态：${TRANSFER_STATUS_LABELS[item.initialMatch.status]}`
                            : "无损恢复初始匹配状态"
                        }
                        onClick={() => selectionMutation.mutate({ index: originalIndex, action: "reset" })}
                        className="inline-flex items-center gap-0.5 rounded-md bg-[var(--tv-bg)] px-2 py-0.5 text-[11px] text-[var(--tv-text-muted)] hover:text-[var(--tv-text)] disabled:opacity-40"
                      >
                        <RotateCcw className="h-3 w-3" />
                        重置
                      </button>
                    )}
                  </div>
                </div>
                {item.manualDecision && item.initialMatch && (
                  <div className="text-[11px] text-[var(--tv-text-subtle)]">
                    可重置无损恢复为初始结果：{TRANSFER_STATUS_LABELS[item.initialMatch.status]}
                  </div>
                )}

                {showCandidates && (
                  <div className="space-y-1.5 rounded-lg bg-[var(--tv-bg)] p-2">
                    <div className="text-[11px] font-medium text-[var(--tv-text-subtle)]">
                      候选曲目（点击采用）
                    </div>
                    {item.candidates.map((candidate) => {
                      const isSelected =
                        item.status === "matched" &&
                        item.selectedCandidate?.targetTrackId === candidate.targetTrackId;
                      return (
                        <div
                          key={candidate.targetTrackId}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--tv-surface-hover)]"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[var(--tv-text)]">
                              {candidate.title}
                              {candidate.artists.length > 0 && (
                                <span className="text-[var(--tv-text-muted)]">
                                  {" "}
                                  — {candidate.artists.join(" / ")}
                                </span>
                              )}
                              {candidate.album && (
                                <span className="text-[var(--tv-text-subtle)]"> · {candidate.album}</span>
                              )}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--tv-text-subtle)]">
                              <span className="tabular-nums">{candidate.confidenceScore}分</span>
                              {candidate.availability && (
                                <span>{AVAILABILITY_LABELS[candidate.availability]}</span>
                              )}
                              {candidate.reasons.length > 0 && (
                                <span className="truncate">{candidate.reasons.join(" · ")}</span>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={isRowBusy || isSelected}
                            onClick={() =>
                              selectionMutation.mutate({
                                index: originalIndex,
                                action: "select",
                                targetTrackId: candidate.targetTrackId,
                              })
                            }
                            className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                              isSelected
                                ? "bg-[var(--tv-success)]/15 text-[var(--tv-success)]"
                                : "bg-[var(--tv-accent)] text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
                            }`}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                            {isSelected ? "已选" : "采用"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination Footer */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-subtle)]">
          <span className="tabular-nums">
            已显示 {shown.length} / {filtered.length} 首
          </span>
          {shown.length < filtered.length && (
            <button
              type="button"
              onClick={() => setVisibleCount((prev) => prev + TRANSFER_PAGE_SIZE)}
              className="rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            >
              加载更多（剩余 {filtered.length - shown.length} 首）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
