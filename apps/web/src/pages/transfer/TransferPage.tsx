import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useClearFinishedJobsMutation, useJobsQuery } from "../../entities/job/index.js";
import { AuditForm, CompareForm, TransferForm, TransferJobCard } from "../../features/transfer/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { SegmentedTabs } from "../../shared/ui/primitives.js";

export function TransferPage() {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<"transfer" | "audit" | "compare">("transfer");
  const [sessionCreatedJobIds, setSessionCreatedJobIds] = useState<Set<string>>(() => new Set());
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});

  const activeKind = subTab === "transfer" ? "transfer" : subTab === "audit" ? "import_audit" : "compare";
  const jobsQuery = useJobsQuery(activeKind);

  const markCreatedJobExpanded = (jobId: string) => {
    setSessionCreatedJobIds((prev) => new Set(prev).add(jobId));
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: (res) => {
      if (res.job.status === "cancelled") {
        toast.info("已取消任务");
      } else if (res.job.status === "completed") {
        toast.info("该任务已完成，无法取消");
      } else if (res.job.status === "failed") {
        toast.info("该任务已失败结束");
      }
      void queryClient.invalidateQueries({ queryKey: ["jobs", activeKind] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "取消任务失败"),
  });

  const clearFinishedMutation = useClearFinishedJobsMutation(activeKind, {
    onSuccess: ({ removedCount }) => {
      if (removedCount > 0) {
        toast.success(`已清除 ${removedCount} 条已结束任务`);
      } else {
        toast.info("没有可清除的已结束任务");
      }
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
        {subTab === "transfer" && <TransferForm onJobCreated={markCreatedJobExpanded} />}
        {subTab === "audit" && <AuditForm onJobCreated={markCreatedJobExpanded} />}
        {subTab === "compare" && <CompareForm onJobCreated={markCreatedJobExpanded} />}
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
              onClick={() => clearFinishedMutation.mutate(activeKind)}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              清除已结束
            </button>
          </div>

          <div className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)]">
            {jobs.map((job, idx) => {
              const isExpanded = expandedOverrides[job.id] ?? (idx === 0 || sessionCreatedJobIds.has(job.id));
              return (
                <TransferJobCard
                  key={job.id}
                  job={job}
                  isExpanded={isExpanded}
                  onToggleExpand={() => setExpandedOverrides((prev) => ({ ...prev, [job.id]: !isExpanded }))}
                  onCancel={(id) => cancelMutation.mutate(id)}
                  cancelPending={cancelMutation.isPending}
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
