import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Download, FileCheck2, GitCompare, PlusCircle, XCircle } from "lucide-react";
import { useState } from "react";
import {
  type CompareResult,
  type ExportFormat,
  type ImportAuditResult,
  type JobView,
  type MusicPlatform,
  type TransferResult,
  sanitizeExternalUrl,
} from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

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

function JobExportBar({ job }: { job: JobView }) {
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
      toast.success(`已创建歌单「${res.playlistName}」，成功导入 ${res.addedCount} 首`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "一键建单失败"),
  });

  if (job.status !== "completed") return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--tv-border)]">
      {(["csv", "markdown", "text", "json"] as const).map((fmt) => (
        <button
          key={fmt}
          type="button"
          onClick={() => exportMutation.mutate(fmt)}
          className="inline-flex items-center gap-1 rounded-lg border border-[var(--tv-border)] px-2.5 py-1 text-xs text-[var(--tv-text-muted)] hover:bg-white/5 hover:text-white"
        >
          <Download className="h-3 w-3" />
          导出 {fmt.toUpperCase()}
        </button>
      ))}
      {(job.kind === "transfer" || job.kind === "import_audit") && (
        <button
          type="button"
          disabled={importMutation.isPending}
          onClick={() => importMutation.mutate()}
          className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          {importMutation.isPending ? "导入中..." : "一键创建目标歌单"}
        </button>
      )}
      {createdUrl && (
        <a
          href={createdUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-amber-300 underline"
        >
          打开新歌单
        </a>
      )}
    </div>
  );
}

export function TransferPage() {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<"transfer" | "audit" | "compare">("transfer");

  // Sub-tab 1: Transfer state (strictly isolated)
  const [sourceProvider, setSourceProvider] = useState<"netease" | "qq" | "text" | "csv">("text");
  const [targetProvider, setTargetProvider] = useState<MusicPlatform>("netease");
  const [playlistId, setPlaylistId] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [rawText, setRawText] = useState("");

  // Sub-tab 2: Audit state (strictly isolated)
  const [auditPlaylistId, setAuditPlaylistId] = useState("");
  const [auditPlaylistName, setAuditPlaylistName] = useState("");

  // Sub-tab 3: Compare state (strictly isolated)
  const [leftProvider, setLeftProvider] = useState<MusicPlatform>("netease");
  const [leftPlaylistId, setLeftPlaylistId] = useState("");
  const [rightProvider, setRightProvider] = useState<MusicPlatform>("qq");
  const [rightPlaylistId, setRightPlaylistId] = useState("");

  const activeKind = subTab === "transfer" ? "transfer" : subTab === "audit" ? "import_audit" : "compare";
  const jobsQuery = useQuery({
    queryKey: ["jobs", activeKind],
    queryFn: () => api.listJobs(activeKind),
  });

  const startTransferMutation = useMutation({
    mutationFn: () =>
      api.startTransferJob({
        sourceProvider,
        targetProvider,
        playlistId: sourceProvider === "netease" || sourceProvider === "qq" ? playlistId : undefined,
        playlistName: playlistName || undefined,
        rawText: sourceProvider === "text" || sourceProvider === "csv" ? rawText : undefined,
        checkAvailability: false,
      }),
    onSuccess: () => {
      toast.success("已提交跨平台歌单互转任务");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交互转失败"),
  });

  const startAuditMutation = useMutation({
    mutationFn: () =>
      api.startImportAuditJob({
        playlistId: auditPlaylistId,
        playlistName: auditPlaylistName || undefined,
        maxTracks: 300,
        candidateLimit: 5,
        checkAvailability: false,
      }),
    onSuccess: () => {
      toast.success("已提交歌单可用性审计任务");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交审计失败"),
  });

  const startCompareMutation = useMutation({
    mutationFn: () =>
      api.startCompareJob({
        leftProvider,
        leftPlaylistId,
        rightProvider,
        rightPlaylistId,
      }),
    onSuccess: () => {
      toast.success("已提交双歌单对比任务");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交对比失败"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const jobs = jobsQuery.data?.jobs ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">歌单互转与分析工作台</h1>
          <p className="text-xs text-[var(--tv-text-muted)]">
            互转、审计、对比三大工作流完全解耦，所有任务强制按成员隔离并通过 SSE 实时同步
          </p>
        </div>

        <div className="inline-flex rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-1 text-xs">
          <button
            type="button"
            onClick={() => setSubTab("transfer")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${
              subTab === "transfer" ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
            }`}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            跨平台互转
          </button>
          <button
            type="button"
            onClick={() => setSubTab("audit")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${
              subTab === "audit" ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
            }`}
          >
            <FileCheck2 className="h-3.5 w-3.5" />
            网易云可用性审计
          </button>
          <button
            type="button"
            onClick={() => setSubTab("compare")}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${
              subTab === "compare" ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
            }`}
          >
            <GitCompare className="h-3.5 w-3.5" />
            双歌单对比
          </button>
        </div>
      </div>

      {/* Form Panel */}
      <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-5 space-y-4">
        {subTab === "transfer" && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs">
                <span className="text-[var(--tv-text-muted)]">来源类型</span>
                <select
                  value={sourceProvider}
                  onChange={(e) => setSourceProvider(e.target.value as typeof sourceProvider)}
                  className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
                >
                  <option value="text">纯文本歌单</option>
                  <option value="csv">CSV 歌单（支持 RFC4180 引号）</option>
                  <option value="netease">网易云歌单 ID</option>
                  <option value="qq">QQ 音乐歌单 ID</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-[var(--tv-text-muted)]">目标平台</span>
                <select
                  value={targetProvider}
                  onChange={(e) => setTargetProvider(e.target.value as MusicPlatform)}
                  className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
                >
                  <option value="netease">网易云音乐</option>
                  <option value="qq">QQ 音乐</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-[var(--tv-text-muted)]">任务名称</span>
                <input
                  type="text"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="可选，用于导出与建单命名"
                  className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
                />
              </label>
            </div>

            {sourceProvider === "netease" || sourceProvider === "qq" ? (
              <input
                type="text"
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                placeholder="输入源平台歌单 ID"
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2 text-sm text-white"
              />
            ) : (
              <textarea
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={"每行一首，例如：\n1. 晴天 - 周杰伦 - 叶惠美\n2. 七里香 - 周杰伦"}
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] p-3 text-xs text-white"
              />
            )}

            <button
              type="button"
              disabled={startTransferMutation.isPending}
              onClick={() => startTransferMutation.mutate()}
              className="rounded-xl bg-amber-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
            >
              开始互转匹配
            </button>
          </>
        )}

        {subTab === "audit" && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex-1 min-w-[200px] space-y-1 text-xs">
              <span className="text-[var(--tv-text-muted)]">网易云歌单 ID</span>
              <input
                type="text"
                value={auditPlaylistId}
                onChange={(e) => setAuditPlaylistId(e.target.value)}
                placeholder="输入要审计的网易云歌单 ID"
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2 text-sm text-white"
              />
            </label>
            <label className="flex-1 min-w-[180px] space-y-1 text-xs">
              <span className="text-[var(--tv-text-muted)]">歌单名称（可选）</span>
              <input
                type="text"
                value={auditPlaylistName}
                onChange={(e) => setAuditPlaylistName(e.target.value)}
                placeholder="用于结果展示"
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2 text-sm text-white"
              />
            </label>
            <button
              type="button"
              disabled={!auditPlaylistId.trim() || startAuditMutation.isPending}
              onClick={() => startAuditMutation.mutate()}
              className="rounded-xl bg-amber-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
            >
              开始可用性扫描
            </button>
          </div>
        )}

        {subTab === "compare" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)]/60 p-3">
              <div className="text-xs font-medium text-[var(--tv-text-muted)]">左侧歌单</div>
              <div className="flex gap-2">
                <select
                  value={leftProvider}
                  onChange={(e) => setLeftProvider(e.target.value as MusicPlatform)}
                  className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="netease">网易云</option>
                  <option value="qq">QQ音乐</option>
                </select>
                <input
                  type="text"
                  value={leftPlaylistId}
                  onChange={(e) => setLeftPlaylistId(e.target.value)}
                  placeholder="左侧歌单 ID"
                  className="flex-1 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-3 py-1.5 text-xs text-white"
                />
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)]/60 p-3">
              <div className="text-xs font-medium text-[var(--tv-text-muted)]">右侧歌单</div>
              <div className="flex gap-2">
                <select
                  value={rightProvider}
                  onChange={(e) => setRightProvider(e.target.value as MusicPlatform)}
                  className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-white"
                >
                  <option value="netease">网易云</option>
                  <option value="qq">QQ音乐</option>
                </select>
                <input
                  type="text"
                  value={rightPlaylistId}
                  onChange={(e) => setRightPlaylistId(e.target.value)}
                  placeholder="右侧歌单 ID"
                  className="flex-1 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-3 py-1.5 text-xs text-white"
                />
              </div>
            </div>

            <div className="sm:col-span-2">
              <button
                type="button"
                disabled={!leftPlaylistId.trim() || !rightPlaylistId.trim() || startCompareMutation.isPending}
                onClick={() => startCompareMutation.mutate()}
                className="rounded-xl bg-amber-400 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
              >
                开始对比
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Job Results */}
      <div className="space-y-3">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white">{job.title}</div>
                <div className="text-xs text-[var(--tv-text-muted)]">
                  {job.errorMessage ?? job.subtitle ?? job.status}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-amber-300">
                  {job.status === "running" ? `${job.progress}%` : job.status}
                </span>
                {(job.status === "queued" || job.status === "running") && (
                  <button
                    type="button"
                    onClick={() => cancelMutation.mutate(job.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 px-2 py-1 text-xs text-rose-300"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    取消
                  </button>
                )}
              </div>
            </div>

            {job.status === "completed" && job.kind === "transfer" && Boolean(job.result) && (
              <div className="max-h-60 overflow-y-auto divide-y divide-[var(--tv-border)] rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)]/50 text-xs">
                {(job.result as TransferResult).results.slice(0, 50).map((item, idx) => (
                  <div
                    key={`${item.sourceTrack.title}-${idx}`}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="truncate text-white">
                      {item.sourceTrack.title} - {item.sourceTrack.artists.join(" / ")}
                    </span>
                    <span className="shrink-0 text-[var(--tv-text-muted)]">
                      {item.status}
                      {item.selectedCandidate ? ` (${item.selectedCandidate.confidenceScore}分)` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {job.status === "completed" && job.kind === "import_audit" && Boolean(job.result) && (
              <div className="text-xs text-[var(--tv-text-muted)]">
                扫描 {(job.result as ImportAuditResult).scannedCount} 首 · 正常可播{" "}
                {(job.result as ImportAuditResult).playableCount} 首 · 异常{" "}
                {(job.result as ImportAuditResult).issueCount} 首
              </div>
            )}

            {job.status === "completed" && job.kind === "compare" && Boolean(job.result) && (
              <div className="text-xs text-[var(--tv-text-muted)]">
                完全一致 {(job.result as CompareResult).summary.exact} · 同名异唱{" "}
                {(job.result as CompareResult).summary.sameTitleDifferentArtist} · 仅左{" "}
                {(job.result as CompareResult).summary.leftOnly} · 仅右{" "}
                {(job.result as CompareResult).summary.rightOnly}
              </div>
            )}

            <JobExportBar job={job} />
          </div>
        ))}
      </div>
    </div>
  );
}
