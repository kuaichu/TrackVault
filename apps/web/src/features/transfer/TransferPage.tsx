import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Download, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  type AuditIssueItem,
  type CompareResult,
  type CompareStatus,
  type ExportFormat,
  type ImportAuditResult,
  type JobStatus,
  type JobView,
  type MusicPlatform,
  type TransferAvailability,
  type TransferResult,
  type TransferTrackResult,
  type TransferTrackStatus,
  type UpdateTransferSelectionInput,
  sanitizeExternalUrl,
} from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { SegmentedTabs } from "../../shared/ui/primitives.js";

const PAGE_SIZE = 50;

const INPUT_CLASS =
  "w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none";

const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const TRANSFER_STATUS_LABELS: Record<TransferTrackStatus, string> = {
  matched: "已匹配",
  manual_review: "待确认",
  not_found: "未找到",
  copyright_unavailable: "无版权",
  vip_only: "会员专享",
  trial_only: "仅试听",
  duplicate: "重复",
  skipped: "已跳过",
};

const TRANSFER_STATUS_BADGE_CLASS: Record<TransferTrackStatus, string> = {
  matched: "bg-[var(--tv-success)]/15 text-[var(--tv-success)]",
  manual_review: "bg-amber-500/15 text-amber-500",
  not_found: "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]",
  copyright_unavailable: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  vip_only: "bg-amber-500/15 text-amber-500",
  trial_only: "bg-amber-500/15 text-amber-500",
  duplicate: "bg-[var(--tv-surface-active)] text-[var(--tv-text-subtle)]",
  skipped: "bg-[var(--tv-surface-active)] text-[var(--tv-text-subtle)]",
};

const AVAILABILITY_LABELS: Record<TransferAvailability, string> = {
  playable: "可播",
  vip_only: "会员专享",
  trial_only: "仅试听",
  copyright_unavailable: "无版权",
  unknown: "未知",
};

const AUDIT_ISSUE_LABELS: Record<AuditIssueItem["issueType"], string> = {
  copyright_unavailable: "无版权",
  vip_only: "会员专享",
  paid_album: "付费专辑",
  restricted: "受限",
  trial_only: "仅试听",
};

const AUDIT_ISSUE_BADGE_CLASS: Record<AuditIssueItem["issueType"], string> = {
  copyright_unavailable: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  vip_only: "bg-amber-500/15 text-amber-500",
  paid_album: "bg-amber-500/15 text-amber-500",
  restricted: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  trial_only: "bg-amber-500/15 text-amber-500",
};

const COMPARE_STATUS_LABELS: Record<CompareStatus, string> = {
  exact: "完全一致",
  similar_title: "相似歌名",
  same_title_different_artist: "同名异唱",
  left_only: "仅歌单 A",
  right_only: "仅歌单 B",
};

const COMPARE_STATUS_BADGE_CLASS: Record<CompareStatus, string> = {
  exact: "bg-[var(--tv-success)]/15 text-[var(--tv-success)]",
  similar_title: "bg-amber-500/15 text-amber-500",
  same_title_different_artist: "bg-amber-500/15 text-amber-500",
  left_only: "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]",
  right_only: "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]",
};

type TransferFilter = "all" | "manual_review" | "matched" | "issues";
type CompareFilter = "all" | CompareStatus;

function triggerBrowserFileDownload(filename: string, mimeType: string, content: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function getImportableCount(job: JobView): number {
  if (job.kind === "transfer" && job.result) {
    const result = job.result as TransferResult;
    return result.results.filter(
      (item) => item.status === "matched" && Boolean(item.selectedCandidate?.targetTrackId),
    ).length;
  }
  if (job.kind === "import_audit" && job.result) {
    const result = job.result as ImportAuditResult;
    return result.playableTrackIds.length;
  }
  return 0;
}

function JobExportBar({ job }: { job: JobView }) {
  const queryClient = useQueryClient();
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: (format: ExportFormat) => api.exportTransferJob(job.id, format),
    onSuccess: (payload) => {
      triggerBrowserFileDownload(payload.filename, payload.mimeType, payload.content);
      toast.success(`已导出 ${payload.filename}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "导出失败"),
  });

  const importMutation = useMutation({
    mutationFn: () => api.importTransferJob(job.id, {}),
    onSuccess: (res) => {
      const safe = sanitizeExternalUrl(res.playlistUrl);
      setCreatedUrl(safe);
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      const skipSuffix = res.skippedCount > 0 ? `（跳过 ${res.skippedCount} 首）` : "";
      toast.success(`已创建歌单「${res.playlistName}」，导入 ${res.addedCount} 首${skipSuffix}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "建单失败"),
  });

  if (job.status !== "completed") return null;

  const canImportKind = job.kind === "transfer" || job.kind === "import_audit";
  const importableCount = canImportKind ? getImportableCount(job) : 0;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      {(["csv", "markdown", "text", "json"] as const).map((fmt) => (
        <button
          key={fmt}
          type="button"
          disabled={exportMutation.isPending}
          onClick={() => exportMutation.mutate(fmt)}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:opacity-40"
        >
          <Download className="h-3 w-3" />
          {fmt.toUpperCase()}
        </button>
      ))}
      {canImportKind && (
        <>
          <button
            type="button"
            disabled={importMutation.isPending || importableCount === 0}
            onClick={() => importMutation.mutate()}
            className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-accent)] px-3 py-1.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            {importMutation.isPending ? "导入中..." : `创建目标歌单 (${importableCount})`}
          </button>
          {importableCount === 0 && (
            <span className="text-xs text-[var(--tv-text-subtle)]">暂无可导入的匹配/可播曲目</span>
          )}
        </>
      )}
      {createdUrl && (
        <a
          href={createdUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-[var(--tv-accent)] hover:underline"
        >
          打开新歌单
        </a>
      )}
    </div>
  );
}

function matchesTransferFilter(item: TransferTrackResult, filter: TransferFilter): boolean {
  if (filter === "all") return true;
  if (filter === "manual_review") return item.status === "manual_review";
  if (filter === "matched") return item.status === "matched";
  return item.status !== "matched" && item.status !== "manual_review";
}

function TransferResultViewer({ job, result }: { job: JobView; result: TransferResult }) {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TransferFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);

  const selectionMutation = useMutation({
    mutationFn: (input: UpdateTransferSelectionInput) => api.updateTransferSelection(job.id, input),
    onMutate: (input) => {
      setPendingIndex(input.index);
    },
    onSuccess: ({ job: updatedJob }) => {
      queryClient.setQueryData<{ jobs: JobView[] }>(["jobs", "transfer"], (prev) => {
        if (!prev) return prev;
        return {
          jobs: prev.jobs.map((entry) => (entry.id === updatedJob.id ? updatedJob : entry)),
        };
      });
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

  const processedCount = result.processedCount ?? result.results.length;
  const unprocessedCount =
    result.unprocessedCount ??
    (result.sourceTotal !== undefined ? Math.max(0, result.sourceTotal - processedCount) : 0);

  return (
    <div className="space-y-3">
      {result.truncated && result.sourceTotal !== undefined && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            源歌单共 {result.sourceTotal} 首，本次已处理前 {processedCount} 首（未处理 {unprocessedCount}{" "}
            首）。
          </span>
        </div>
      )}

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
              setVisibleCount(PAGE_SIZE);
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
                      <div className="mt-0.5 truncate text-[11px] text-[var(--tv-text-muted)]">
                        已选：{item.selectedCandidate.title} — {item.selectedCandidate.artists.join(" / ")} ·{" "}
                        {item.selectedCandidate.confidenceScore}分
                        {item.selectedCandidate.availability &&
                        item.selectedCandidate.availability !== "playable" &&
                        item.selectedCandidate.availability !== "unknown"
                          ? ` · ${AVAILABILITY_LABELS[item.selectedCandidate.availability]}`
                          : ""}
                      </div>
                    ) : item.reason ? (
                      <div className="mt-0.5 truncate text-[11px] text-[var(--tv-text-subtle)]">
                        {item.reason}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
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

                    {(item.status === "skipped" || (item.status === "matched" && hasCandidates)) && (
                      <button
                        type="button"
                        disabled={isRowBusy}
                        onClick={() => selectionMutation.mutate({ index: originalIndex, action: "reset" })}
                        className="inline-flex items-center gap-0.5 rounded-md bg-[var(--tv-bg)] px-2 py-0.5 text-[11px] text-[var(--tv-text-muted)] hover:text-[var(--tv-text)] disabled:opacity-40"
                      >
                        <RotateCcw className="h-3 w-3" />
                        重选
                      </button>
                    )}
                  </div>
                </div>

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
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
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

function ImportAuditResultViewer({ result }: { result: ImportAuditResult }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const shownIssues = result.issues.slice(0, visibleCount);
  const unprocessedCount =
    result.unprocessedCount ??
    (result.sourceTotal !== undefined ? Math.max(0, result.sourceTotal - result.scannedCount) : 0);

  return (
    <div className="space-y-3">
      {result.truncated && result.sourceTotal !== undefined && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            源歌单共 {result.sourceTotal} 首，本次已扫描前 {result.scannedCount} 首（未处理 {unprocessedCount}{" "}
            首）。
          </span>
        </div>
      )}

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
                onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
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

function CompareResultViewer({ result }: { result: CompareResult }) {
  const [filter, setFilter] = useState<CompareFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filtered = filter === "all" ? result.items : result.items.filter((item) => item.status === filter);
  const shown = filtered.slice(0, visibleCount);

  const truncationMessages: string[] = [];
  if (result.left.truncated && result.left.sourceTotal !== undefined) {
    truncationMessages.push(`歌单 A 共 ${result.left.sourceTotal} 首，本次对比前 ${result.left.total} 首`);
  }
  if (result.right.truncated && result.right.sourceTotal !== undefined) {
    truncationMessages.push(`歌单 B 共 ${result.right.sourceTotal} 首，本次对比前 ${result.right.total} 首`);
  }

  return (
    <div className="space-y-3">
      {truncationMessages.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{truncationMessages.join("；")}。</span>
        </div>
      )}

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
              setVisibleCount(PAGE_SIZE);
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
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
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

export function TransferPage() {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<"transfer" | "audit" | "compare">("transfer");

  const [sourceProvider, setSourceProvider] = useState<"netease" | "qq" | "text" | "csv">("text");
  const [targetProvider, setTargetProvider] = useState<MusicPlatform>("netease");
  const [playlistId, setPlaylistId] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [rawText, setRawText] = useState("");
  const [checkAvailability, setCheckAvailability] = useState(false);

  const [auditPlaylistId, setAuditPlaylistId] = useState("");
  const [auditPlaylistName, setAuditPlaylistName] = useState("");
  const [auditCheckAvailability, setAuditCheckAvailability] = useState(false);

  const [leftProvider, setLeftProvider] = useState<MusicPlatform>("netease");
  const [leftPlaylistId, setLeftPlaylistId] = useState("");
  const [rightProvider, setRightProvider] = useState<MusicPlatform>("qq");
  const [rightPlaylistId, setRightPlaylistId] = useState("");

  const activeKind = subTab === "transfer" ? "transfer" : subTab === "audit" ? "import_audit" : "compare";
  const jobsQuery = useQuery({
    queryKey: ["jobs", activeKind],
    queryFn: () => api.listJobs(activeKind),
  });

  const canStartTransfer =
    sourceProvider === "netease" || sourceProvider === "qq"
      ? playlistId.trim().length > 0
      : rawText.trim().length > 0;

  const startTransferMutation = useMutation({
    mutationFn: () =>
      api.startTransferJob({
        sourceProvider,
        targetProvider,
        playlistId: sourceProvider === "netease" || sourceProvider === "qq" ? playlistId.trim() : undefined,
        playlistName: playlistName.trim() || undefined,
        rawText: sourceProvider === "text" || sourceProvider === "csv" ? rawText : undefined,
        checkAvailability,
      }),
    onSuccess: () => {
      toast.success("已开始歌单匹配");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  const startAuditMutation = useMutation({
    mutationFn: () =>
      api.startImportAuditJob({
        playlistId: auditPlaylistId.trim(),
        playlistName: auditPlaylistName.trim() || undefined,
        maxTracks: 300,
        candidateLimit: 5,
        checkAvailability: auditCheckAvailability,
      }),
    onSuccess: () => {
      toast.success("已开始可用性检测");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  const startCompareMutation = useMutation({
    mutationFn: () =>
      api.startCompareJob({
        leftProvider,
        leftPlaylistId: leftPlaylistId.trim(),
        rightProvider,
        rightPlaylistId: rightPlaylistId.trim(),
      }),
    onSuccess: () => {
      toast.success("已开始双歌单对比");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : "取消任务失败"),
  });

  const clearFinishedMutation = useMutation({
    mutationFn: () => api.clearFinishedJobs(activeKind),
    onSuccess: ({ removedCount }) => {
      if (removedCount > 0) {
        toast.success(`已清除 ${removedCount} 条已结束任务`);
      } else {
        toast.info("没有可清除的已结束任务");
      }
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "清除任务失败"),
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const hasFinishedJobs = jobs.some(
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled",
  );

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">歌单迁移</h1>
        <SegmentedTabs
          value={subTab}
          onChange={setSubTab}
          items={[
            { id: "transfer", label: "跨平台互转" },
            { id: "audit", label: "灰歌检测" },
            { id: "compare", label: "双歌单对比" },
          ]}
        />
      </div>

      {/* Form Sheet */}
      <section className="rounded-2xl bg-[var(--tv-surface)] p-6 space-y-4">
        {subTab === "transfer" && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs">
                <span className="font-medium text-[var(--tv-text-muted)]">来源</span>
                <select
                  value={sourceProvider}
                  onChange={(e) => setSourceProvider(e.target.value as typeof sourceProvider)}
                  className={INPUT_CLASS}
                >
                  <option value="text">纯文本曲目列表</option>
                  <option value="csv">CSV 表格</option>
                  <option value="netease">网易云歌单 ID</option>
                  <option value="qq">QQ 音乐歌单 ID</option>
                </select>
              </label>

              <label className="space-y-1.5 text-xs">
                <span className="font-medium text-[var(--tv-text-muted)]">目标平台</span>
                <select
                  value={targetProvider}
                  onChange={(e) => setTargetProvider(e.target.value as MusicPlatform)}
                  className={INPUT_CLASS}
                >
                  <option value="netease">网易云音乐</option>
                  <option value="qq">QQ 音乐</option>
                </select>
              </label>

              <label className="space-y-1.5 text-xs">
                <span className="font-medium text-[var(--tv-text-muted)]">新歌单名称（可选）</span>
                <input
                  type="text"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="用于导出或一键建单"
                  className={INPUT_CLASS}
                />
              </label>
            </div>

            {sourceProvider === "netease" || sourceProvider === "qq" ? (
              <input
                type="text"
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                placeholder="输入源平台歌单 ID"
                className={INPUT_CLASS}
              />
            ) : (
              <textarea
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={"每行一首曲目，例如：\n1. 晴天 - 周杰伦 - 叶惠美\n2. 七里香 - 周杰伦"}
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--tv-text-muted)] select-none">
                <input
                  type="checkbox"
                  checked={checkAvailability}
                  onChange={(e) => setCheckAvailability(e.target.checked)}
                  className="h-3.5 w-3.5 rounded accent-[var(--tv-accent)]"
                />
                <span>实测音源可用性（较慢，可识别仅试听曲目）</span>
              </label>

              <button
                type="button"
                disabled={!canStartTransfer || startTransferMutation.isPending}
                onClick={() => startTransferMutation.mutate()}
                className="rounded-lg bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
              >
                开始匹配
              </button>
            </div>
          </>
        )}

        {subTab === "audit" && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-[220px] flex-1 space-y-1.5 text-xs">
                <span className="font-medium text-[var(--tv-text-muted)]">网易云歌单 ID</span>
                <input
                  type="text"
                  value={auditPlaylistId}
                  onChange={(e) => setAuditPlaylistId(e.target.value)}
                  placeholder="输入需要检测的网易云歌单 ID"
                  className={INPUT_CLASS}
                />
              </label>
              <label className="min-w-[180px] flex-1 space-y-1.5 text-xs">
                <span className="font-medium text-[var(--tv-text-muted)]">备注名称（可选）</span>
                <input
                  type="text"
                  value={auditPlaylistName}
                  onChange={(e) => setAuditPlaylistName(e.target.value)}
                  placeholder="便于区分任务"
                  className={INPUT_CLASS}
                />
              </label>
              <button
                type="button"
                disabled={!auditPlaylistId.trim() || startAuditMutation.isPending}
                onClick={() => startAuditMutation.mutate()}
                className="h-[38px] rounded-lg bg-[var(--tv-accent)] px-5 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
              >
                开始检测
              </button>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--tv-text-muted)] select-none">
              <input
                type="checkbox"
                checked={auditCheckAvailability}
                onChange={(e) => setAuditCheckAvailability(e.target.checked)}
                className="h-3.5 w-3.5 rounded accent-[var(--tv-accent)]"
              />
              <span>实测音源可用性（较慢，可识别仅试听曲目）</span>
            </label>
          </div>
        )}

        {subTab === "compare" && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[var(--tv-text-muted)]">歌单 A</div>
                <div className="flex gap-2">
                  <select
                    value={leftProvider}
                    onChange={(e) => setLeftProvider(e.target.value as MusicPlatform)}
                    className="shrink-0 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
                  >
                    <option value="netease">网易云</option>
                    <option value="qq">QQ 音乐</option>
                  </select>
                  <input
                    type="text"
                    value={leftPlaylistId}
                    onChange={(e) => setLeftPlaylistId(e.target.value)}
                    placeholder="歌单 ID"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-[var(--tv-text-muted)]">歌单 B</div>
                <div className="flex gap-2">
                  <select
                    value={rightProvider}
                    onChange={(e) => setRightProvider(e.target.value as MusicPlatform)}
                    className="shrink-0 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
                  >
                    <option value="netease">网易云</option>
                    <option value="qq">QQ 音乐</option>
                  </select>
                  <input
                    type="text"
                    value={rightPlaylistId}
                    onChange={(e) => setRightPlaylistId(e.target.value)}
                    placeholder="歌单 ID"
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              disabled={!leftPlaylistId.trim() || !rightPlaylistId.trim() || startCompareMutation.isPending}
              onClick={() => startCompareMutation.mutate()}
              className="rounded-lg bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
            >
              开始对比
            </button>
          </div>
        )}
      </section>

      {/* Error State */}
      {jobsQuery.isError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--tv-danger)]/25 bg-[var(--tv-danger)]/10 px-4 py-3 text-xs text-[var(--tv-danger)]">
          <span>
            加载任务列表失败：
            {jobsQuery.error instanceof Error ? jobsQuery.error.message : "请稍后重试"}
          </span>
          <button
            type="button"
            onClick={() => void jobsQuery.refetch()}
            className="rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
          >
            重试
          </button>
        </div>
      )}

      {/* Task History */}
      {jobs.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--tv-text)]">任务记录</h2>
            <button
              type="button"
              disabled={!hasFinishedJobs || clearFinishedMutation.isPending}
              onClick={() => clearFinishedMutation.mutate()}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              清除已结束
            </button>
          </div>

          <div className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)]">
            {jobs.map((job) => (
              <div key={job.id} className="py-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--tv-text)]">{job.title}</div>
                    <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">
                      {job.errorMessage ?? job.subtitle ?? JOB_STATUS_LABELS[job.status]}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs tabular-nums text-[var(--tv-text-muted)]">
                      {job.status === "running" ? `${job.progress}%` : JOB_STATUS_LABELS[job.status]}
                    </span>
                    {(job.status === "queued" || job.status === "running") && (
                      <button
                        type="button"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(job.id)}
                        className="rounded-md p-1 text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-danger)] disabled:opacity-40"
                        aria-label="取消任务"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                {job.status === "completed" && job.kind === "transfer" && Boolean(job.result) && (
                  <TransferResultViewer job={job} result={job.result as TransferResult} />
                )}

                {job.status === "completed" && job.kind === "import_audit" && Boolean(job.result) && (
                  <ImportAuditResultViewer result={job.result as ImportAuditResult} />
                )}

                {job.status === "completed" && job.kind === "compare" && Boolean(job.result) && (
                  <CompareResultViewer result={job.result as CompareResult} />
                )}

                <JobExportBar job={job} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
