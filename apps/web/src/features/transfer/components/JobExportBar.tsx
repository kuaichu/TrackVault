import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Plus } from "lucide-react";
import { useState } from "react";
import {
  type ExportFormat,
  type ImportAuditResult,
  type JobView,
  type TransferResult,
  sanitizeExternalUrl,
} from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";

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

export function JobExportBar({ job }: { job: JobView }) {
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
