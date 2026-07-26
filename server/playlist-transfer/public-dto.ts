import type {
  MatchCandidate,
  PlaylistTransferJob,
  PublicMatchCandidate,
  PublicPlaylistTransferJob,
  PublicTransferTrack,
  PublicTransferTrackResult,
  TransferTrack,
  TransferImportRequest,
  TransferTrackResult
} from "./types.js";
import { parseTransferImportRequest } from "./transfer-import-request.js";
import { toPublicTrackAvailability } from "./availability-public-policy.js";

export function toPublicTransferTrack(track: TransferTrack): PublicTransferTrack {
  return {
    source: track.source,
    ...(track.sourceTrackId === undefined ? {} : { sourceTrackId: track.sourceTrackId }),
    title: track.title,
    artists: [...track.artists],
    ...(track.album === undefined ? {} : { album: track.album }),
    ...(track.durationSeconds === undefined ? {} : { durationSeconds: track.durationSeconds }),
    ...(track.rawText === undefined ? {} : { rawText: track.rawText })
  };
}

export function toPublicMatchCandidate(candidate: MatchCandidate): PublicMatchCandidate {
  return {
    provider: candidate.provider,
    targetTrackId: candidate.targetTrackId,
    title: candidate.title,
    artists: [...candidate.artists],
    ...(candidate.album === undefined ? {} : { album: candidate.album }),
    ...(candidate.durationSeconds === undefined ? {} : { durationSeconds: candidate.durationSeconds }),
    ...(candidate.availability === undefined
      ? {}
      : { availability: toPublicTrackAvailability(candidate.availability) }),
    confidenceScore: candidate.confidenceScore,
    reasons: [...candidate.reasons]
  };
}

function toPublicTransferTrackResult(result: TransferTrackResult): PublicTransferTrackResult {
  const publicReason = result.reason === undefined
    ? undefined
    : result.status === "manual_review"
      ? "存在相似候选，需要人工确认"
      : result.status === "not_found"
        ? "目标平台未找到候选歌曲"
        : result.status === "copyright_unavailable" || result.status === "vip_only" || result.status === "trial_only"
          ? toPublicTrackAvailability({ status: result.status, reason: result.reason }).reason
          : result.status === "duplicate"
            ? "导入列表中已存在相同歌名和歌手"
            : result.status === "metadata_conflict"
              ? "歌曲信息存在冲突，需要人工确认"
              : result.status === "skipped"
                ? "该歌曲已跳过"
                : undefined;

  return {
    sourceTrack: toPublicTransferTrack(result.sourceTrack),
    status: result.status,
    candidates: result.candidates.map(toPublicMatchCandidate),
    ...(result.selectedCandidate === undefined
      ? {}
      : { selectedCandidate: toPublicMatchCandidate(result.selectedCandidate) }),
    ...(publicReason === undefined ? {} : { reason: publicReason })
  };
}

export function toPublicPlaylistTransferJob(job: PlaylistTransferJob): PublicPlaylistTransferJob {
  return {
    id: job.id,
    sourceProvider: job.sourceProvider,
    targetProvider: job.targetProvider,
    playlistName: job.playlistName,
    tracks: job.tracks.map(toPublicTransferTrackResult),
    summary: {
      total: job.summary.total,
      matched: job.summary.matched,
      manualReview: job.summary.manualReview,
      notFound: job.summary.notFound,
      unavailable: job.summary.unavailable,
      duplicate: job.summary.duplicate,
      skipped: job.summary.skipped
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export function toPublicTransferImportRequest(input: unknown): TransferImportRequest {
  return parseTransferImportRequest(input);
}
