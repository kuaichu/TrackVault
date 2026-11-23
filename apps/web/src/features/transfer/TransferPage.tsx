import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, X } from "lucide-react";
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
import { SegmentedTabs } from "../../shared/ui/primitives.js";

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
      toast.success(`已创建歌单「${res.playlistName}」，导入 ${res.addedCount} 首`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "建单失败"),
  });

  if (job.status !== "completed") return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3">
      {(["csv", "markdown", "text", "json"] as const).map((fmt) => (
        <button
          key={fmt}
          type="button"
          onClick={() => exportMutation.mutate(fmt)}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
        >
          <Download className="h-3 w-3" />
          {fmt.toUpperCase()}
        </button>
      ))}
      {(job.kind === "transfer" || job.kind === "import_audit") && (
        <button
          type="button"
          disabled={importMutation.isPending}
          onClick={() => importMutation.mutate()}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-accent)] px-3 py-1.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          {importMutation.isPending ? "导入中..." : "创建目标歌单"}
        </button>
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

const INPUT_CLASS =
  "w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none";

export function TransferPage() {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = useState<"transfer" | "audit" | "compare">("transfer");

  const [sourceProvider, setSourceProvider] = useState<"netease" | "qq" | "text" | "csv">("text");
  const [targetProvider, setTargetProvider] = useState<MusicPlatform>("netease");
  const [playlistId, setPlaylistId] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [rawText, setRawText] = useState("");

  const [auditPlaylistId, setAuditPlaylistId] = useState("");
  const [auditPlaylistName, setAuditPlaylistName] = useState("");

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
      toast.success("已开始歌单匹配");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
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
      toast.success("已开始可用性检测");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
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
      toast.success("已开始双歌单对比");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const jobs = jobsQuery.data?.jobs ?? [];

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

            <div className="pt-1">
              <button
                type="button"
                disabled={startTransferMutation.isPending}
                onClick={() => startTransferMutation.mutate()}
                className="rounded-lg bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
              >
                开始匹配
              </button>
            </div>
          </>
        )}

        {subTab === "audit" && (
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
                    className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
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
                    className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
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

      {/* Task History */}
      {jobs.length > 0 && (
        <section className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)]">
          {jobs.map((job) => (
            <div key={job.id} className="py-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[var(--tv-text)]">{job.title}</div>
                  <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">
                    {job.errorMessage ?? job.subtitle ?? job.status}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums text-[var(--tv-text-muted)]">
                    {job.status === "running"
                      ? `${job.progress}%`
                      : job.status === "completed"
                        ? "已完成"
                        : job.status === "failed"
                          ? "失败"
                          : job.status === "cancelled"
                            ? "已取消"
                            : "排队中"}
                  </span>
                  {(job.status === "queued" || job.status === "running") && (
                    <button
                      type="button"
                      onClick={() => cancelMutation.mutate(job.id)}
                      className="rounded-md p-1 text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-danger)]"
                      aria-label="取消任务"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {job.status === "completed" && job.kind === "transfer" && Boolean(job.result) && (
                <div className="max-h-64 overflow-y-auto divide-y divide-[var(--tv-border)] rounded-xl bg-[var(--tv-surface)] text-xs">
                  {(job.result as TransferResult).results.slice(0, 50).map((item, idx) => (
                    <div
                      key={`${item.sourceTrack.title}-${idx}`}
                      className="flex items-center justify-between gap-3 px-3.5 py-2"
                    >
                      <span className="truncate text-[var(--tv-text)]">
                        {item.sourceTrack.title}
                        <span className="text-[var(--tv-text-muted)]">
                          {" "}
                          — {item.sourceTrack.artists.join(" / ")}
                        </span>
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--tv-text-muted)]">
                        {item.status}
                        {item.selectedCandidate ? ` · ${item.selectedCandidate.confidenceScore}分` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {job.status === "completed" && job.kind === "import_audit" && Boolean(job.result) && (
                <div className="grid max-w-md grid-cols-3 gap-3 rounded-xl bg-[var(--tv-surface)] p-3.5 text-xs">
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">扫描总数</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
                      {(job.result as ImportAuditResult).scannedCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">正常可播</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-success)]">
                      {(job.result as ImportAuditResult).playableCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">异常曲目</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-danger)]">
                      {(job.result as ImportAuditResult).issueCount}
                    </div>
                  </div>
                </div>
              )}

              {job.status === "completed" && job.kind === "compare" && Boolean(job.result) && (
                <div className="grid max-w-lg grid-cols-4 gap-3 rounded-xl bg-[var(--tv-surface)] p-3.5 text-xs">
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">完全一致</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
                      {(job.result as CompareResult).summary.exact}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">同名异唱</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
                      {(job.result as CompareResult).summary.sameTitleDifferentArtist}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">仅歌单 A</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
                      {(job.result as CompareResult).summary.leftOnly}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--tv-text-subtle)]">仅歌单 B</div>
                    <div className="mt-0.5 text-lg font-bold tabular-nums text-[var(--tv-text)]">
                      {(job.result as CompareResult).summary.rightOnly}
                    </div>
                  </div>
                </div>
              )}

              <JobExportBar job={job} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
