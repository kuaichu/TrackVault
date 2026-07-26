import type {
  NeteaseImportAuditItem,
  NeteaseImportAuditProgress,
  NeteaseImportedPlaylistAudit
} from "./netease-import-audit.js";
import type {
  NeteaseImportAuditJob,
  NeteaseImportAuditJobInput,
  NeteaseImportAuditJobStatus
} from "./netease-import-audit-job.js";
import { toPublicMatchCandidate, toPublicTransferTrack } from "./public-dto.js";
import type { PublicMatchCandidate, PublicTransferTrack } from "./types.js";
import { PUBLIC_ERROR_MESSAGES } from "../public-error.js";

export type PublicNeteaseImportAuditItem = {
  originalTrackId: string;
  sourceTrack: PublicTransferTrack;
  unusableReason: string;
  status: NeteaseImportAuditItem["status"];
  candidates: PublicMatchCandidate[];
  selectedCandidate?: PublicMatchCandidate;
  reason?: string;
};

export type PublicNeteaseImportedPlaylistAudit = {
  playlistId: string;
  playlistName: string;
  scannedCount: number;
  summary: {
    total: number;
    playable: number;
    suspect: number;
    replaceable: number;
    needsReview: number;
    unusable: number;
  };
  playableTrackIds: string[];
  playableTextPlaylist: string;
  items: PublicNeteaseImportAuditItem[];
  textPlaylist: string;
  unusableText: string;
  markdownReport: string;
};

export type PublicNeteaseImportAuditJob = {
  id: string;
  status: NeteaseImportAuditJobStatus;
  input: NeteaseImportAuditJobInput;
  progress: NeteaseImportAuditProgress & {
    phase: NeteaseImportAuditJob["progress"]["phase"];
  };
  result?: PublicNeteaseImportedPlaylistAudit;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function toPublicAuditItem(item: NeteaseImportAuditItem): PublicNeteaseImportAuditItem {
  return {
    originalTrackId: item.originalTrackId,
    sourceTrack: toPublicTransferTrack(item.sourceTrack),
    unusableReason: item.unusableReason,
    status: item.status,
    candidates: item.candidates.map(toPublicMatchCandidate),
    ...(item.selectedCandidate === undefined
      ? {}
      : { selectedCandidate: toPublicMatchCandidate(item.selectedCandidate) }),
    ...(item.reason === undefined ? {} : { reason: item.reason })
  };
}

export function toPublicNeteaseImportedPlaylistAudit(
  audit: NeteaseImportedPlaylistAudit
): PublicNeteaseImportedPlaylistAudit {
  return {
    playlistId: audit.playlistId,
    playlistName: audit.playlistName,
    scannedCount: audit.scannedCount,
    summary: {
      total: audit.summary.total,
      playable: audit.summary.playable,
      suspect: audit.summary.suspect,
      replaceable: audit.summary.replaceable,
      needsReview: audit.summary.needsReview,
      unusable: audit.summary.unusable
    },
    playableTrackIds: [...audit.playableTrackIds],
    playableTextPlaylist: audit.playableTextPlaylist,
    items: audit.items.map(toPublicAuditItem),
    textPlaylist: audit.textPlaylist,
    unusableText: audit.unusableText,
    markdownReport: audit.markdownReport
  };
}

export function toPublicNeteaseImportAuditJob(job: NeteaseImportAuditJob): PublicNeteaseImportAuditJob {
  return {
    id: job.id,
    status: job.status,
    input: {
      playlistId: job.input.playlistId,
      playlistName: job.input.playlistName,
      maxTracks: job.input.maxTracks,
      candidateLimit: job.input.candidateLimit,
      checkAvailability: job.input.checkAvailability
    },
    progress: {
      phase: job.progress.phase,
      scanned: job.progress.scanned,
      total: job.progress.total,
      suspect: job.progress.suspect,
      replaceable: job.progress.replaceable,
      needsReview: job.progress.needsReview,
      unusable: job.progress.unusable,
      ...(job.progress.currentTitle === undefined ? {} : { currentTitle: job.progress.currentTitle })
    },
    ...(job.result === undefined ? {} : { result: toPublicNeteaseImportedPlaylistAudit(job.result) }),
    ...(job.status === "failed"
      ? { error: PUBLIC_ERROR_MESSAGES.neteaseImportAudit }
      : job.status === "cancelled"
        ? { error: "扫描已取消" }
        : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
