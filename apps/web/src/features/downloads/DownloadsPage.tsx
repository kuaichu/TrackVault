import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Trash2, XCircle } from "lucide-react";
import { sanitizeExternalUrl } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

export function DownloadsPage() {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ["jobs", "download"],
    queryFn: () => api.listJobs("download"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => {
      toast.info("已取消下载任务");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearFinishedJobs("download"),
    onSuccess: (res) => {
      toast.success(`已清理 ${res.removedCount} 条已结束任务`);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const jobs = jobsQuery.data?.jobs ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">统一下载中心</h1>
          <p className="text-xs text-[var(--tv-text-muted)]">
            通过 SSE 实时推送进度（零轮询风暴）；服务端受控流式写标签后提供单次安全取回
          </p>
        </div>
        {jobs.some((j) => j.status === "completed" || j.status === "failed" || j.status === "cancelled") && (
          <button
            type="button"
            onClick={() => clearMutation.mutate()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] px-3 py-1.5 text-xs text-[var(--tv-text-muted)] hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空已结束
          </button>
        )}
      </div>

      {jobsQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">加载下载任务...</div>
      ) : jobs.length === 0 ? (
        <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] py-16 text-center text-sm text-[var(--tv-text-muted)]">
          暂无下载任务，在任意歌曲列表点击下载按钮即可开始
        </div>
      ) : (
        <div className="space-y-2.5">
          {jobs.map((job) => {
            const safeDirectUrl = sanitizeExternalUrl(job.directUrl);
            return (
              <div
                key={job.id}
                className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-4 space-y-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{job.title}</div>
                    <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">
                      {job.errorMessage ? (
                        <span className="text-rose-400">{job.errorMessage}</span>
                      ) : (
                        (job.subtitle ?? job.status)
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        job.status === "completed"
                          ? "bg-emerald-500/15 text-emerald-300"
                          : job.status === "failed"
                            ? "bg-rose-500/15 text-rose-300"
                            : job.status === "cancelled"
                              ? "bg-white/10 text-white/60"
                              : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
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

                    {(job.status === "queued" || job.status === "running") && (
                      <button
                        type="button"
                        onClick={() => cancelMutation.mutate(job.id)}
                        className="inline-flex items-center gap-1 rounded-xl border border-rose-500/30 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        取消
                      </button>
                    )}

                    {job.downloadReady && (
                      <a
                        href={api.getJobDownloadFileUrl(job.id)}
                        download={job.artifactFilename}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-300"
                      >
                        <Download className="h-3.5 w-3.5" />
                        保存到本地
                      </a>
                    )}

                    {safeDirectUrl && (
                      <a
                        href={safeDirectUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-amber-400/40 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-400/10"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        打开直链
                      </a>
                    )}
                  </div>
                </div>

                {(job.status === "running" || job.status === "queued") && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-amber-400 transition-[width] duration-300"
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
