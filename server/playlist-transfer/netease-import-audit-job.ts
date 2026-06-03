import crypto from "node:crypto";
import {
  buildNeteaseImportedPlaylistAudit,
  type NeteaseAuditSourceEntry,
  type NeteaseImportAuditProgress,
  type NeteaseImportedPlaylistAudit
} from "./netease-import-audit.js";
import type { MatchCandidate, ProviderTrack, TransferExportFormat, TransferExportResult, TransferTrack } from "./types.js";

export type NeteaseImportAuditJobStatus = "queued" | "loading" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type NeteaseImportAuditJobInput = {
  playlistId: string;
  playlistName: string;
  maxTracks: number;
  candidateLimit: number;
  checkAvailability: boolean;
};

export type NeteaseImportAuditJob = {
  id: string;
  status: NeteaseImportAuditJobStatus;
  input: NeteaseImportAuditJobInput;
  progress: NeteaseImportAuditProgress & {
    phase: "queued" | "loading" | "scanning" | "completed" | "failed" | "cancelled";
  };
  result?: NeteaseImportedPlaylistAudit;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type InternalJob = NeteaseImportAuditJob & {
  cancelRequested: boolean;
};

type NeteaseImportAuditJobDeps = {
  loadEntries: (playlistId: string, maxTracks: number) => Promise<NeteaseAuditSourceEntry[]>;
  searchCandidates: (track: TransferTrack) => Promise<ProviderTrack[]>;
  checkCandidateAvailability?: (candidate: MatchCandidate) => Promise<{ status: "copyright_unavailable" | "vip_only" | "trial_only"; reason: string } | null>;
};

const jobs = new Map<string, InternalJob>();

function nowIso() {
  return new Date().toISOString();
}

function publicJob(job: InternalJob): NeteaseImportAuditJob {
  const { cancelRequested: _cancelRequested, ...rest } = job;
  return rest;
}

function updateJob(job: InternalJob, patch: Partial<NeteaseImportAuditJob>) {
  Object.assign(job, patch, {
    updatedAt: nowIso()
  });
}

function assertNotCancelled(job: InternalJob) {
  if (job.cancelRequested) {
    throw new Error("扫描已取消");
  }
}

async function runJob(job: InternalJob, deps: NeteaseImportAuditJobDeps) {
  try {
    updateJob(job, {
      status: "loading",
      progress: {
        ...job.progress,
        phase: "loading"
      }
    });

    const entries = await deps.loadEntries(job.input.playlistId, job.input.maxTracks);
    assertNotCancelled(job);
    updateJob(job, {
      status: "running",
      progress: {
        ...job.progress,
        phase: "scanning",
        total: entries.length
      }
    });

    const result = await buildNeteaseImportedPlaylistAudit({
      playlistId: job.input.playlistId,
      playlistName: job.input.playlistName,
      tracks: entries,
      candidateLimit: job.input.candidateLimit,
      searchCandidates: deps.searchCandidates,
      checkCandidateAvailability: job.input.checkAvailability ? deps.checkCandidateAvailability : undefined,
      shouldCancel: () => job.cancelRequested,
      onProgress: (progress) => {
        updateJob(job, {
          progress: {
            ...progress,
            phase: "scanning"
          }
        });
      }
    });

    updateJob(job, {
      status: "completed",
      result,
      progress: {
        ...job.progress,
        phase: "completed",
        scanned: result.scannedCount,
        total: result.scannedCount
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "扫描失败";
    if (job.cancelRequested || message.includes("扫描已取消")) {
      updateJob(job, {
        status: "cancelled",
        error: "扫描已取消",
        progress: {
          ...job.progress,
          phase: "cancelled"
        }
      });
      return;
    }

    updateJob(job, {
      status: "failed",
      error: message,
      progress: {
        ...job.progress,
        phase: "failed"
      }
    });
  }
}

export function startNeteaseImportAuditJob(input: NeteaseImportAuditJobInput, deps: NeteaseImportAuditJobDeps) {
  const createdAt = nowIso();
  const job: InternalJob = {
    id: crypto.randomUUID(),
    status: "queued",
    input,
    progress: {
      phase: "queued",
      scanned: 0,
      total: Math.max(1, input.maxTracks),
      suspect: 0,
      replaceable: 0,
      needsReview: 0,
      unusable: 0
    },
    createdAt,
    updatedAt: createdAt,
    cancelRequested: false
  };

  jobs.set(job.id, job);
  setTimeout(() => {
    void runJob(job, deps);
  }, 0);
  return publicJob(job);
}

export function getNeteaseImportAuditJob(id: string) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function cancelNeteaseImportAuditJob(id: string) {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return publicJob(job);
  }

  job.cancelRequested = true;
  updateJob(job, {
    status: "cancelling"
  });
  return publicJob(job);
}

function csvValue(value: string | number | undefined) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function formatCsv(audit: NeteaseImportedPlaylistAudit) {
  const rows = [["status", "source_title", "source_artists", "reason", "target_title", "target_artists", "score"]];
  for (const item of audit.items) {
    rows.push([
      item.status,
      item.sourceTrack.title,
      item.sourceTrack.artists.join(" / ") || "未知歌手",
      item.unusableReason,
      item.selectedCandidate?.title ?? "",
      item.selectedCandidate?.artists.join(" / ") ?? "",
      String(item.selectedCandidate?.confidenceScore ?? "")
    ]);
  }

  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

function formatText(audit: NeteaseImportedPlaylistAudit) {
  const sections = [
    "# 可重新导入的文字歌单",
    audit.textPlaylist || "无",
    "",
    "# 完全不可用或暂无替代",
    audit.unusableText || "无"
  ];

  return `${sections.join("\n")}\n`;
}

export function formatNeteaseImportAuditJobExport(audit: NeteaseImportedPlaylistAudit, format: TransferExportFormat): TransferExportResult {
  const baseName = `${audit.playlistName}-导入歌单清理`;

  if (format === "json") {
    return {
      filename: `${baseName}.json`,
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(audit, null, 2)
    };
  }

  if (format === "csv") {
    return {
      filename: `${baseName}.csv`,
      contentType: "text/csv; charset=utf-8",
      content: formatCsv(audit)
    };
  }

  if (format === "markdown") {
    return {
      filename: `${baseName}.md`,
      contentType: "text/markdown; charset=utf-8",
      content: `${audit.markdownReport}\n`
    };
  }

  return {
    filename: `${baseName}.txt`,
    contentType: "text/plain; charset=utf-8",
    content: formatText(audit)
  };
}
