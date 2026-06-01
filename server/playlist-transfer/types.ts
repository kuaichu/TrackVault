export type TransferSourceProvider = "netease" | "qq" | "text" | "csv";
export type TransferTargetProvider = "netease" | "qq" | "text";
export type TransferExportFormat = "markdown" | "text" | "csv" | "json";

export type TransferTrackStatus =
  | "matched"
  | "manual_review"
  | "not_found"
  | "copyright_unavailable"
  | "vip_only"
  | "trial_only"
  | "duplicate"
  | "metadata_conflict"
  | "skipped";

export type TransferTrack = {
  source: TransferSourceProvider;
  sourceTrackId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  rawText?: string;
};

export type ProviderTrack = {
  provider: "netease" | "qq";
  id: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
};

export type MatchCandidate = {
  provider: "netease" | "qq";
  targetTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  confidenceScore: number;
  reasons: string[];
};

export type TransferTrackResult = {
  sourceTrack: TransferTrack;
  status: TransferTrackStatus;
  candidates: MatchCandidate[];
  selectedCandidate?: MatchCandidate;
  reason?: string;
};

export type TransferSummary = {
  total: number;
  matched: number;
  manualReview: number;
  notFound: number;
  unavailable: number;
  duplicate: number;
  skipped: number;
};

export type PlaylistTransferJob = {
  id: string;
  ownerKey: string;
  sourceProvider: TransferSourceProvider;
  targetProvider: TransferTargetProvider;
  playlistName: string;
  tracks: TransferTrackResult[];
  summary: TransferSummary;
  createdAt: string;
  updatedAt: string;
};

export type TransferImportRequest = {
  sourceProvider: TransferSourceProvider;
  targetProvider: TransferTargetProvider;
  playlistName?: string;
  playlistId?: string;
  text?: string;
  checkAvailability?: boolean;
};

export type TransferExportResult = {
  filename: string;
  contentType: string;
  content: string;
};
