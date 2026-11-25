import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Trash2, X } from "lucide-react";
import { sanitizeExternalUrl } from "#shared";
import { useClearFinishedJobsMutation, useJobsQuery } from "../../entities/job/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { EmptyState } from "../../shared/ui/primitives.js";

export function DownloadsPage() {
  const queryClient = useQueryClient();
  const jobsQuery = useJobsQuery("download");

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: (res) => {
      if (res.job.status === "cancelled") {
        toast.info("已取消下载任务");
      } else if (res.job.status === "completed") {
        toast.info("该任务已完成，无法取消");
      } else if (res.job.status === "failed") {
        toast.info("该任务已失败结束");
      } else {
        toast.info("已更新任务状态");
      }
      void queryClient.invalidateQueries({ queryKey: ["jobs", "download"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "取消下载任务失败");
    },
  });

  const clearMutation = useClearFinishedJobsMutation("download", {
    onSuccess: (res) => {
      toast.success(`已清除 ${res.removedCount} 条记录`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "清除下载记录失败");
    },
  });

  const jobs = jobsQuery.data?.jobs ?? [];
  const hasFinished = jobs.some(
    (j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled",
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">下载管理</h1>
        {hasFinished && (
          <button
            type="button"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清除已结束
          </button>
        )}
      </div>

      {jobsQuery.isLoading ? (
        <div className="space-y-2">
          {["dl1", "dl2", "dl3"].map((id) => (
            <div key={id} className="h-16 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : jobsQuery.isError ? (
        <EmptyState
          title="未能加载下载任务"
          description={jobsQuery.error instanceof Error ? jobsQuery.error.message : "请检查网络后重试"}
          action={
            <button
              type="button"
              disabled={jobsQuery.isFetching}
              onClick={() => void jobsQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
            >
              重试
            </button>
          }
        />
      ) : jobs.length === 0 ? (
        <EmptyState title="暂无下载任务" description="在任意曲目列表中点击下载图标即可添加到队列。" />
      ) : (
        <div className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)]">
          {jobs.map((job) => {
            const safeDirectUrl = sanitizeExternalUrl(job.directUrl);
            const isActive = job.status === "running" || job.status === "queued";

            return (
              <div key={job.id} className="py-4 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--tv-text)]">{job.title}</div>
                    <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">
                      {job.errorMessage ? (
                        <span className="text-[var(--tv-danger)]">{job.errorMessage}</span>
                      ) : (
                        (job.subtitle ?? (job.status === "completed" ? "已准备就绪" : "处理中"))
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-[var(--tv-text-muted)]">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          job.status === "completed"
                            ? "bg-[var(--tv-success)]"
                            : job.status === "failed"
                              ? "bg-[var(--tv-danger)]"
                              : job.status === "cancelled"
                                ? "bg-[var(--tv-text-subtle)]"
                                : "bg-[var(--tv-accent)]"
                        }`}
                      />
                      {job.status === "running"
                        ? `${job.progress}%`
                        : job.status === "queued"
                          ? "排队中"
                          : job.status === "completed"
                            ? "已完成"
                            : job.status === "cancelled"
                              ? "已取消"
                              : "失败"}
                    </span>

                    {isActive && (
                      <button
                        type="button"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(job.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-danger)] disabled:opacity-40"
                      >
                        <X className="h-3.5 w-3.5" />
                        取消
                      </button>
                    )}

                    {job.downloadReady && (
                      <a
                        href={api.getJobDownloadFileUrl(job.id)}
                        download={job.artifactFilename}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-accent)] px-3 py-1.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
                      >
                        <Download className="h-3.5 w-3.5" />
                        保存文件
                      </a>
                    )}

                    {job.artifactExpired && !job.downloadReady && !safeDirectUrl && (
                      <span className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-subtle)]">
                        临时文件已过期
                      </span>
                    )}

                    {safeDirectUrl && (
                      <a
                        href={safeDirectUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        打开直链
                      </a>
                    )}
                  </div>
                </div>

                {isActive && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--tv-surface)]">
                    <div
                      className="h-full rounded-full bg-[var(--tv-accent)] transition-[width] duration-300"
                      style={{ width: `${Math.max(4, job.progress)}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
