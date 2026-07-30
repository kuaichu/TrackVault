import type { PlaylistTransferJob, TransferTrackResult, TransferTrackStatus } from "./types";

export type TransferResultFilter = "all" | "matched" | "review" | "not_found" | "restricted" | "duplicate";

const REVIEW_STATUSES: TransferTrackStatus[] = ["manual_review", "metadata_conflict"];
const RESTRICTED_STATUSES: TransferTrackStatus[] = ["copyright_unavailable", "vip_only", "trial_only"];

export function getDefaultTransferResultFilter(job: PlaylistTransferJob): TransferResultFilter {
  return job.summary.manualReview > 0 ? "review" : "all";
}

export function filterTransferTracks(tracks: TransferTrackResult[], filter: TransferResultFilter): TransferTrackResult[] {
  if (filter === "all") return tracks;
  return tracks.filter((track) => {
    if (filter === "matched") return track.status === "matched";
    if (filter === "review") return REVIEW_STATUSES.includes(track.status);
    if (filter === "not_found") return track.status === "not_found";
    if (filter === "restricted") return RESTRICTED_STATUSES.includes(track.status);
    return track.status === "duplicate";
  });
}

export function getDefaultTransferPlaylistName(sourcePlaylistName: string): string {
  return sourcePlaylistName.trim();
}

export function resolveTransferImportName(jobPlaylistName: string, importName: string): string {
  const trimmed = importName.trim();
  return !trimmed || trimmed === "转换后的歌单" ? jobPlaylistName : trimmed;
}

export function getCompletedTransferImportName(jobPlaylistName: string, currentName: string, userEdited: boolean): string {
  return userEdited ? currentName : jobPlaylistName;
}
