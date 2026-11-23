import { z } from "zod";
import { MusicPlatformSchema } from "./auth.js";

export const TransferTrackSchema = z.object({
  source: z.enum(["netease", "qq", "text", "csv"]),
  sourceTrackId: z.string().max(128).optional(),
  title: z.string().min(1).max(300),
  artists: z.array(z.string().max(120)).max(20),
  album: z.string().max(300).optional(),
  durationSeconds: z.number().nonnegative().max(86_400).optional(),
});
export type TransferTrack = z.infer<typeof TransferTrackSchema>;

export const TransferAvailabilitySchema = z.enum([
  "playable",
  "vip_only",
  "trial_only",
  "copyright_unavailable",
  "unknown",
]);
export type TransferAvailability = z.infer<typeof TransferAvailabilitySchema>;

export const MatchCandidateSchema = z.object({
  provider: MusicPlatformSchema,
  targetTrackId: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional(),
  durationSeconds: z.number().optional(),
  availability: TransferAvailabilitySchema.optional(),
  confidenceScore: z.number().min(0).max(100),
  reasons: z.array(z.string()),
});
export type MatchCandidate = z.infer<typeof MatchCandidateSchema>;

export const TransferTrackStatusSchema = z.enum([
  "matched",
  "manual_review",
  "not_found",
  "copyright_unavailable",
  "vip_only",
  "trial_only",
  "duplicate",
  "skipped",
]);
export type TransferTrackStatus = z.infer<typeof TransferTrackStatusSchema>;

export const TransferTrackResultSchema = z.object({
  sourceTrack: TransferTrackSchema,
  status: TransferTrackStatusSchema,
  candidates: z.array(MatchCandidateSchema),
  selectedCandidate: MatchCandidateSchema.optional(),
  reason: z.string().optional(),
});
export type TransferTrackResult = z.infer<typeof TransferTrackResultSchema>;

export const TransferSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  manualReview: z.number().int().nonnegative(),
  notFound: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type TransferSummary = z.infer<typeof TransferSummarySchema>;

export const StartTransferInputSchema = z.object({
  sourceProvider: z.enum(["netease", "qq", "text", "csv"]),
  targetProvider: MusicPlatformSchema,
  playlistId: z.string().trim().max(128).optional(),
  playlistName: z.string().trim().max(200).optional(),
  rawText: z.string().max(200_000).optional(),
  selectedSourceTrackIds: z.array(z.string().max(128)).max(1000).optional(),
  sourceTracks: z.array(TransferTrackSchema).max(1000).optional(),
  checkAvailability: z.boolean().default(false),
});
export type StartTransferInput = z.infer<typeof StartTransferInputSchema>;

export const TransferResultSchema = z.object({
  sourceProvider: z.enum(["netease", "qq", "text", "csv"]),
  targetProvider: MusicPlatformSchema,
  playlistName: z.string(),
  summary: TransferSummarySchema,
  results: z.array(TransferTrackResultSchema),
  sourceTotal: z.number().int().nonnegative().optional(),
  processedCount: z.number().int().nonnegative().optional(),
  unprocessedCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});
export type TransferResult = z.infer<typeof TransferResultSchema>;

export const UpdateTransferSelectionInputSchema = z.object({
  index: z.number().int().min(0),
  action: z.enum(["select", "skip", "reset"]),
  targetTrackId: z.string().trim().min(1).max(128).optional(),
});
export type UpdateTransferSelectionInput = z.infer<typeof UpdateTransferSelectionInputSchema>;

export const StartImportAuditInputSchema = z.object({
  playlistId: z.string().trim().min(1).max(128),
  playlistName: z.string().trim().max(200).optional(),
  maxTracks: z.number().int().min(1).max(500).default(300),
  candidateLimit: z.number().int().min(1).max(8).default(5),
  checkAvailability: z.boolean().default(false),
});
export type StartImportAuditInput = z.infer<typeof StartImportAuditInputSchema>;

export const AuditIssueItemSchema = z.object({
  trackId: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional(),
  issueType: z.enum(["copyright_unavailable", "vip_only", "paid_album", "restricted", "trial_only"]),
  reason: z.string(),
  replacements: z.array(MatchCandidateSchema),
});
export type AuditIssueItem = z.infer<typeof AuditIssueItemSchema>;

export const ImportAuditResultSchema = z.object({
  playlistId: z.string(),
  playlistName: z.string(),
  scannedCount: z.number().int().nonnegative(),
  playableCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  playableTrackIds: z.array(z.string()),
  issues: z.array(AuditIssueItemSchema),
  sourceTotal: z.number().int().nonnegative().optional(),
  unprocessedCount: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
});
export type ImportAuditResult = z.infer<typeof ImportAuditResultSchema>;

export const CompareStatusSchema = z.enum([
  "exact",
  "same_title_different_artist",
  "similar_title",
  "left_only",
  "right_only",
]);
export type CompareStatus = z.infer<typeof CompareStatusSchema>;

export const CompareItemSchema = z.object({
  status: CompareStatusSchema,
  score: z.number().min(0).max(100),
  left: TransferTrackSchema.optional(),
  right: TransferTrackSchema.optional(),
  reason: z.string().optional(),
});
export type CompareItem = z.infer<typeof CompareItemSchema>;

export const CompareSummarySchema = z.object({
  leftTotal: z.number().int().nonnegative(),
  rightTotal: z.number().int().nonnegative(),
  exact: z.number().int().nonnegative(),
  sameTitleDifferentArtist: z.number().int().nonnegative(),
  similarTitle: z.number().int().nonnegative(),
  leftOnly: z.number().int().nonnegative(),
  rightOnly: z.number().int().nonnegative(),
});
export type CompareSummary = z.infer<typeof CompareSummarySchema>;

export const StartCompareInputSchema = z.object({
  leftProvider: MusicPlatformSchema,
  leftPlaylistId: z.string().trim().min(1).max(128),
  leftPlaylistName: z.string().trim().max(200).optional(),
  rightProvider: MusicPlatformSchema,
  rightPlaylistId: z.string().trim().min(1).max(128),
  rightPlaylistName: z.string().trim().max(200).optional(),
});
export type StartCompareInput = z.infer<typeof StartCompareInputSchema>;

export const CompareResultSchema = z.object({
  left: z.object({
    provider: MusicPlatformSchema,
    playlistId: z.string(),
    playlistName: z.string(),
    total: z.number().int().nonnegative(),
    sourceTotal: z.number().int().nonnegative().optional(),
    unprocessedCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }),
  right: z.object({
    provider: MusicPlatformSchema,
    playlistId: z.string(),
    playlistName: z.string(),
    total: z.number().int().nonnegative(),
    sourceTotal: z.number().int().nonnegative().optional(),
    unprocessedCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }),
  summary: CompareSummarySchema,
  items: z.array(CompareItemSchema),
});
export type CompareResult = z.infer<typeof CompareResultSchema>;

export const ExportFormatSchema = z.enum(["markdown", "text", "csv", "json"]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

export const ExportPayloadSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  content: z.string(),
});
export type ExportPayload = z.infer<typeof ExportPayloadSchema>;
