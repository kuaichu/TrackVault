import { z } from "zod";
import { MusicPlatformSchema } from "./auth.js";

export const TransferSourceProviderSchema = z.enum(["netease", "qq", "kugou", "text", "csv"]);
export type TransferSourceProvider = z.infer<typeof TransferSourceProviderSchema>;

export const TransferTrackSchema = z.object({
  source: TransferSourceProviderSchema,
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
  "paid_album",
  "trial_only",
  "copyright_unavailable",
  "restricted",
  "unknown",
]);
export type TransferAvailability = z.infer<typeof TransferAvailabilitySchema>;

export const PlayabilityStatusSchema = TransferAvailabilitySchema;
export type PlayabilityStatus = TransferAvailability;

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

export const ManualTransferDecisionSchema = z.object({
  action: z.enum(["select", "skip"]),
  targetTrackId: z.string().optional(),
  updatedAt: z.number().optional(),
});
export type ManualTransferDecision = z.infer<typeof ManualTransferDecisionSchema>;

export const InitialTrackMatchSnapshotSchema = z.object({
  status: TransferTrackStatusSchema,
  selectedCandidate: MatchCandidateSchema.optional(),
  reason: z.string().optional(),
});
export type InitialTrackMatchSnapshot = z.infer<typeof InitialTrackMatchSnapshotSchema>;

export const TransferTrackResultSchema = z.object({
  sourceTrack: TransferTrackSchema,
  status: TransferTrackStatusSchema,
  candidates: z.array(MatchCandidateSchema),
  selectedCandidate: MatchCandidateSchema.optional(),
  reason: z.string().optional(),
  initialMatch: InitialTrackMatchSnapshotSchema.optional(),
  manualDecision: ManualTransferDecisionSchema.optional(),
});
export type TransferTrackResult = z.infer<typeof TransferTrackResultSchema>;

export const ScanStatsSchema = z.object({
  playlistTotal: z.number().int().nonnegative(),
  sourceTotal: z.number().int().nonnegative(),
  scannedSlotCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  unprocessedCount: z.number().int().nonnegative(),
  missingDetailCount: z.number().int().nonnegative(),
  truncatedCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ScanStats = z.infer<typeof ScanStatsSchema>;

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
  sourceProvider: TransferSourceProviderSchema,
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
  sourceProvider: TransferSourceProviderSchema,
  targetProvider: MusicPlatformSchema,
  playlistName: z.string(),
  summary: TransferSummarySchema,
  results: z.array(TransferTrackResultSchema),
  scanStats: ScanStatsSchema.optional(),
  sourceTotal: z.number().int().nonnegative().optional(),
  playlistTotal: z.number().int().nonnegative().optional(),
  processedCount: z.number().int().nonnegative().optional(),
  unprocessedCount: z.number().int().nonnegative().optional(),
  missingDetailCount: z.number().int().nonnegative().optional(),
  truncatedCount: z.number().int().nonnegative().optional(),
  scannedSlotCount: z.number().int().nonnegative().optional(),
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

export const AuditIssueTypeSchema = z.enum([
  "copyright_unavailable",
  "vip_only",
  "paid_album",
  "restricted",
  "trial_only",
  "probe_error",
]);
export type AuditIssueType = z.infer<typeof AuditIssueTypeSchema>;

export const AuditIssueItemSchema = z.object({
  trackId: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional(),
  issueType: AuditIssueTypeSchema,
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
  scanStats: ScanStatsSchema.optional(),
  sourceTotal: z.number().int().nonnegative().optional(),
  unprocessedCount: z.number().int().nonnegative().optional(),
  missingDetailCount: z.number().int().nonnegative().optional(),
  truncatedCount: z.number().int().nonnegative().optional(),
  scannedSlotCount: z.number().int().nonnegative().optional(),
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
    scanStats: ScanStatsSchema.optional(),
    sourceTotal: z.number().int().nonnegative().optional(),
    unprocessedCount: z.number().int().nonnegative().optional(),
    missingDetailCount: z.number().int().nonnegative().optional(),
    truncatedCount: z.number().int().nonnegative().optional(),
    scannedSlotCount: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
  }),
  right: z.object({
    provider: MusicPlatformSchema,
    playlistId: z.string(),
    playlistName: z.string(),
    total: z.number().int().nonnegative(),
    scanStats: ScanStatsSchema.optional(),
    sourceTotal: z.number().int().nonnegative().optional(),
    unprocessedCount: z.number().int().nonnegative().optional(),
    missingDetailCount: z.number().int().nonnegative().optional(),
    truncatedCount: z.number().int().nonnegative().optional(),
    scannedSlotCount: z.number().int().nonnegative().optional(),
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

export interface ScanStatsInput {
  scanStats?: ScanStats;
  playlistTotal?: number;
  sourceTotal?: number;
  scannedSlotCount?: number;
  processedCount?: number;
  scannedCount?: number;
  total?: number;
  summary?: { total: number };
  unprocessedCount?: number;
  missingDetailCount?: number;
  truncatedCount?: number;
  beyondScanCount?: number;
  truncated?: boolean;
}

export interface ScanStatsSummary {
  stats: ScanStats;
  hasOmissions: boolean;
  parts: string[];
  summaryText: string;
}

export interface FormatScanStatsOptions {
  subjectLabel?: string;
  processedVerb?: string;
  limitLabel?: string;
}

function toNonNegInt(value: number | null | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Single canonical normalizer for playlist scan & truncation statistics.
 * Supports both the structured `scanStats` contract and legacy flat fields.
 */
export function normalizeScanStats(input?: ScanStatsInput | null, fallbackProcessedCount = 0): ScanStats {
  if (input?.scanStats) {
    return {
      playlistTotal: toNonNegInt(input.scanStats.playlistTotal),
      sourceTotal: toNonNegInt(input.scanStats.sourceTotal),
      scannedSlotCount: toNonNegInt(input.scanStats.scannedSlotCount),
      processedCount: toNonNegInt(input.scanStats.processedCount),
      unprocessedCount: toNonNegInt(input.scanStats.unprocessedCount),
      missingDetailCount: toNonNegInt(input.scanStats.missingDetailCount),
      truncatedCount: toNonNegInt(input.scanStats.truncatedCount),
      truncated: Boolean(input.scanStats.truncated),
    };
  }

  const processedCount = toNonNegInt(
    input?.processedCount ?? input?.scannedCount ?? input?.total ?? input?.summary?.total,
    toNonNegInt(fallbackProcessedCount),
  );
  const sourceTotal =
    input?.sourceTotal !== undefined
      ? toNonNegInt(input.sourceTotal)
      : input?.unprocessedCount !== undefined
        ? processedCount + toNonNegInt(input.unprocessedCount)
        : processedCount;
  const playlistTotal = input?.playlistTotal !== undefined ? toNonNegInt(input.playlistTotal) : sourceTotal;
  const unprocessedCount =
    input?.unprocessedCount !== undefined
      ? toNonNegInt(input.unprocessedCount)
      : Math.max(0, sourceTotal - processedCount);
  const rawTruncated = Boolean(input?.truncated);
  const explicitTruncatedCount =
    input?.truncatedCount !== undefined
      ? toNonNegInt(input.truncatedCount)
      : input?.beyondScanCount !== undefined
        ? toNonNegInt(input.beyondScanCount)
        : undefined;
  const missingDetailCount =
    input?.missingDetailCount !== undefined
      ? toNonNegInt(input.missingDetailCount)
      : explicitTruncatedCount !== undefined
        ? Math.max(0, unprocessedCount - explicitTruncatedCount)
        : !rawTruncated
          ? unprocessedCount
          : 0;
  const truncatedCount =
    explicitTruncatedCount !== undefined
      ? explicitTruncatedCount
      : rawTruncated
        ? Math.max(0, unprocessedCount - missingDetailCount)
        : 0;
  const truncated = rawTruncated || truncatedCount > 0;
  const scannedSlotCount =
    input?.scannedSlotCount !== undefined
      ? toNonNegInt(input.scannedSlotCount)
      : processedCount + missingDetailCount;

  return {
    playlistTotal,
    sourceTotal,
    scannedSlotCount,
    processedCount,
    unprocessedCount,
    missingDetailCount,
    truncatedCount,
    truncated,
  };
}

/**
 * Formats normalized scan statistics into standardized segments and a human-readable summary.
 */
export function formatScanStatsSummary(
  statsInput?: ScanStatsInput | null,
  options?: FormatScanStatsOptions,
): ScanStatsSummary {
  const stats = normalizeScanStats(statsInput);
  const hasOmissions = stats.truncated || stats.unprocessedCount > 0;
  if (!hasOmissions) {
    return {
      stats,
      hasOmissions: false,
      parts: [],
      summaryText: "",
    };
  }

  const subjectLabel = options?.subjectLabel ?? "源歌单";
  const processedVerb = options?.processedVerb ?? "已处理";
  const limitLabel = options?.limitLabel ?? "单次处理上限";
  const isSelectedSubset = stats.playlistTotal > stats.sourceTotal;

  const headParts: string[] = [`${subjectLabel}共 ${stats.playlistTotal} 首`];
  if (isSelectedSubset) {
    headParts.push(`已选 ${stats.sourceTotal} 首`);
  } else if (stats.truncatedCount > 0 && stats.missingDetailCount > 0) {
    headParts.push(`扫描前 ${stats.scannedSlotCount} 个位置`);
  }
  headParts.push(`${processedVerb} ${stats.processedCount} 首`);

  const detailParts: string[] = [];
  if (stats.missingDetailCount > 0) {
    detailParts.push(`缺少有效详情 ${stats.missingDetailCount} 首`);
  }
  if (stats.truncated) {
    detailParts.push(
      stats.truncatedCount > 0 ? `超出${limitLabel} ${stats.truncatedCount} 首` : `超出${limitLabel}`,
    );
  } else if (stats.unprocessedCount > 0 && detailParts.length === 0) {
    detailParts.push(`缺少有效详情 ${stats.unprocessedCount} 首`);
  }

  const omissionParts: string[] = [];
  if (stats.unprocessedCount > 0) {
    omissionParts.push(`未处理 ${stats.unprocessedCount} 首`);
  }
  omissionParts.push(...detailParts);

  const omissionText =
    stats.unprocessedCount > 0 && detailParts.length > 0
      ? `未处理 ${stats.unprocessedCount} 首：${detailParts.join("，")}`
      : omissionParts.join("，");

  const parts = [...headParts, ...omissionParts];
  const summaryText = omissionText ? `${headParts.join("，")}（${omissionText}）` : headParts.join("，");

  return {
    stats,
    hasOmissions: true,
    parts,
    summaryText,
  };
}
