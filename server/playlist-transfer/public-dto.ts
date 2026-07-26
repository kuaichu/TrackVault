import type {
  MatchCandidate,
  PlaylistTransferJob,
  PublicMatchCandidate,
  PublicPlaylistTransferJob,
  PublicTransferTrackResult,
  TransferTrack,
  TransferImportRequest,
  TransferTrackResult
} from "./types.js";

function toPublicTransferTrack(track: TransferTrack): TransferTrack {
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

function toPublicMatchCandidate(candidate: MatchCandidate): PublicMatchCandidate {
  return {
    provider: candidate.provider,
    targetTrackId: candidate.targetTrackId,
    title: candidate.title,
    artists: [...candidate.artists],
    ...(candidate.album === undefined ? {} : { album: candidate.album }),
    ...(candidate.durationSeconds === undefined ? {} : { durationSeconds: candidate.durationSeconds }),
    ...(candidate.availability === undefined ? {} : {
      availability: {
        status: candidate.availability.status,
        ...(candidate.availability.reason === undefined ? {} : { reason: candidate.availability.reason })
      }
    }),
    confidenceScore: candidate.confidenceScore,
    reasons: [...candidate.reasons]
  };
}

function toPublicTransferTrackResult(result: TransferTrackResult): PublicTransferTrackResult {
  return {
    sourceTrack: toPublicTransferTrack(result.sourceTrack),
    status: result.status,
    candidates: result.candidates.map(toPublicMatchCandidate),
    ...(result.selectedCandidate === undefined
      ? {}
      : { selectedCandidate: toPublicMatchCandidate(result.selectedCandidate) }),
    ...(result.reason === undefined ? {} : { reason: result.reason })
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

export function toPublicTransferImportRequest(input: TransferImportRequest): TransferImportRequest {
  return {
    sourceProvider: input.sourceProvider,
    targetProvider: input.targetProvider,
    ...(input.playlistName === undefined ? {} : { playlistName: input.playlistName }),
    ...(input.playlistId === undefined ? {} : { playlistId: input.playlistId }),
    ...(input.sourceTrackIds === undefined ? {} : { sourceTrackIds: [...input.sourceTrackIds] }),
    ...(input.sourceTracks === undefined
      ? {}
      : { sourceTracks: input.sourceTracks.map(toPublicTransferTrack) }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.checkAvailability === undefined ? {} : { checkAvailability: input.checkAvailability })
  };
}
