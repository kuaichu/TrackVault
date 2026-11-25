import {
  QUALITY_FALLBACK_ORDER,
  QUALITY_META,
  QUALITY_RANK,
  type QualityLevel,
  classifyAudioFormat,
} from "#shared";

/**
 * Deterministic downward-only fallback list starting from requestedLevel.
 * Fixes legacy bug that fell back upward to hires/lossless when a lower tier was missing.
 */
export function buildDownwardQualityOrder(
  requestedLevel: QualityLevel,
  availableLevels?: readonly QualityLevel[],
): QualityLevel[] {
  const requestedRank = QUALITY_RANK[requestedLevel];
  const orderedDownward = QUALITY_FALLBACK_ORDER.filter((level) => QUALITY_RANK[level] <= requestedRank);
  // Ensure requestedLevel is always tried first
  const candidates = [requestedLevel, ...orderedDownward.filter((l) => l !== requestedLevel)];

  if (!availableLevels || availableLevels.length === 0) {
    return candidates;
  }

  const availSet = new Set(availableLevels);
  const matching = candidates.filter((level) => availSet.has(level));
  return matching.length > 0 ? matching : [requestedLevel, "standard"];
}

export function isTrialDuration(
  expectedDurationSeconds: number | undefined,
  actualDurationSeconds: number | null | undefined,
  hasTrialFlag: boolean,
): boolean {
  if (hasTrialFlag) return true;
  if (!expectedDurationSeconds || expectedDurationSeconds <= 0) return false;
  if (!actualDurationSeconds || actualDurationSeconds <= 0) return false;
  return actualDurationSeconds + 5 < expectedDurationSeconds;
}

export function isQualityDowngraded(
  requestedLevel: QualityLevel,
  actual: { bitrate: number | null; format: string; level: QualityLevel },
): boolean {
  if (requestedLevel === "standard") return false;
  const requestedRank = QUALITY_RANK[requestedLevel] ?? 1;
  const actualRank = QUALITY_RANK[actual.level] ?? 1;

  // Priority 1: compare actual resolved tier rank directly (fixes Hi-Res -> lossless FLAC reporting downgraded:false)
  if (actualRank < requestedRank) {
    return true;
  }

  const meta = QUALITY_META[requestedLevel];
  const { isLossless, isExplicitLossy } = classifyAudioFormat(actual.format);

  if (meta.lossless) {
    if (isLossless) return false;
    if (isExplicitLossy) return true;
    if (actual.bitrate && actual.bitrate >= meta.minBitrate) return false;
    return true;
  }

  if (actual.bitrate !== null && actual.bitrate > 0 && actual.bitrate < meta.minBitrate) {
    return true;
  }
  return false;
}
