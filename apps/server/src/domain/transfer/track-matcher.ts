import type {
  MatchCandidate,
  MusicPlatform,
  QualityLevel,
  TransferAvailability,
  TransferSummary,
  TransferTrack,
  TransferTrackResult,
} from "#shared";
import {
  type VersionTag,
  extractVersionTags,
  hasArtistOverlap,
  normalizeMatchText,
} from "./track-normalizer.js";

export type CandidateProbeStatus = "verified_playable" | "verified_restricted" | "probe_error" | "unprobed";

export interface ProviderCandidateTrack {
  provider: MusicPlatform;
  id: string;
  mediaId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  availableLevels?: readonly QualityLevel[];
  availability?: TransferAvailability;
  probeStatus?: CandidateProbeStatus;
  probeError?: string;
}

function getAvailabilityRank(availability: TransferAvailability | undefined): number {
  switch (availability) {
    case "playable":
      return 5;
    case "unknown":
    case undefined:
      return 4;
    case "vip_only":
      return 3;
    case "paid_album":
    case "restricted":
      return 2;
    case "trial_only":
      return 1;
    case "copyright_unavailable":
      return 0;
  }
}

function isPlayableAvailability(availability: TransferAvailability | undefined): boolean {
  return availability === "playable" || availability === "unknown" || availability === undefined;
}

function getProbeStatusRank(status: CandidateProbeStatus | undefined): number {
  if (status === "verified_playable") return 2;
  if (status === "verified_restricted") return 0;
  return 1;
}

export function scoreTrackMatch(
  source: TransferTrack,
  candidate: ProviderCandidateTrack,
): { score: number; reasons: string[]; hasTitleMatch: boolean } {
  const sourceTitle = normalizeMatchText(source.title);
  const candidateTitle = normalizeMatchText(candidate.title);
  const sourceAlbum = normalizeMatchText(source.album);
  const candidateAlbum = normalizeMatchText(candidate.album);
  const artistOverlap = hasArtistOverlap(source.artists, candidate.artists);

  const sourceTags = extractVersionTags(source.title);
  const candidateTags = extractVersionTags(candidate.title);

  const reasons: string[] = [];
  let score = 0;
  let hasTitleMatch = false;

  if (sourceTitle && candidateTitle) {
    if (sourceTitle === candidateTitle) {
      score += 55;
      hasTitleMatch = true;
      reasons.push("歌名完全一致");
    } else if (
      sourceTitle.length >= 2 &&
      candidateTitle.length >= 2 &&
      (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle))
    ) {
      score += 35;
      hasTitleMatch = true;
      reasons.push("歌名高度相似");
    }
  }

  if (artistOverlap) {
    score += 30;
    reasons.push("歌手匹配");
  }

  if (sourceAlbum && candidateAlbum && sourceAlbum === candidateAlbum) {
    score += 10;
    reasons.push("专辑一致");
  }

  if (
    typeof source.durationSeconds === "number" &&
    typeof candidate.durationSeconds === "number" &&
    Math.abs(source.durationSeconds - candidate.durationSeconds) <= 3
  ) {
    score += 5;
    reasons.push("时长接近");
  }

  // Version qualifier mismatch penalties (prevents original song auto-matching instrumental/Live)
  let versionPenalty = 0;
  if (sourceTags.has("instrumental") !== candidateTags.has("instrumental")) {
    versionPenalty += 45;
    reasons.push("版本不一致（伴奏/原版）");
  } else {
    const otherTags: readonly VersionTag[] = ["live", "remix", "acoustic", "cover"];
    const hasModifierMismatch = otherTags.some((tag) => sourceTags.has(tag) !== candidateTags.has(tag));
    if (hasModifierMismatch) {
      versionPenalty += 20;
      reasons.push("版本修饰词不一致");
    }
  }

  // Require non-empty normalized title and compatible version before awarding exact 100
  if (
    versionPenalty === 0 &&
    sourceTitle.length > 0 &&
    sourceTitle === candidateTitle &&
    artistOverlap &&
    (!sourceAlbum || sourceAlbum === candidateAlbum)
  ) {
    score = 100;
  } else if (versionPenalty > 0) {
    score = Math.max(0, score - versionPenalty);
  }

  return { score: Math.min(100, score), reasons, hasTitleMatch };
}

export function rankHighConfidenceCandidates(
  sourceTrack: TransferTrack,
  candidates: readonly ProviderCandidateTrack[],
): ProviderCandidateTrack[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreTrackMatch(sourceTrack, candidate).score,
    }))
    .filter((entry) => entry.score >= 85)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return getAvailabilityRank(b.candidate.availability) - getAvailabilityRank(a.candidate.availability);
    })
    .map((entry) => entry.candidate);
}

export function matchTransferTrack(
  sourceTrack: TransferTrack,
  candidates: readonly ProviderCandidateTrack[],
  options?: { checkAvailability?: boolean },
): TransferTrackResult {
  const checkAvailability = Boolean(options?.checkAvailability);
  const allScored = candidates
    .map((candidate) => {
      const scored = scoreTrackMatch(sourceTrack, candidate);
      return {
        hasTitleMatch: scored.hasTitleMatch,
        probeStatus: candidate.probeStatus,
        probeError: candidate.probeError,
        candidate: {
          provider: candidate.provider,
          targetTrackId: candidate.id,
          title: candidate.title,
          artists: candidate.artists,
          album: candidate.album,
          durationSeconds: candidate.durationSeconds,
          availability: candidate.availability,
          confidenceScore: scored.score,
          reasons: scored.reasons,
        } satisfies MatchCandidate,
      };
    })
    .filter((entry) => entry.candidate.confidenceScore > 0)
    .sort((a, b) => {
      const scoreDiff = b.candidate.confidenceScore - a.candidate.confidenceScore;
      if (scoreDiff !== 0) return scoreDiff;
      if (checkAvailability) {
        const probeDiff = getProbeStatusRank(b.probeStatus) - getProbeStatusRank(a.probeStatus);
        if (probeDiff !== 0) return probeDiff;
      }
      return getAvailabilityRank(b.candidate.availability) - getAvailabilityRank(a.candidate.availability);
    });

  let bestEntry = allScored[0];

  if (!bestEntry) {
    return {
      sourceTrack,
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到匹配候选",
    };
  }

  // Prefer verified playable (when checkAvailability) or statically playable high-confidence (>= 85)
  // candidates across ALL candidates BEFORE slicing the 5-item UI candidate list (PP-01).
  if (checkAvailability) {
    const verifiedPlayable = allScored.find(
      (entry) =>
        entry.candidate.confidenceScore >= 85 &&
        entry.probeStatus === "verified_playable" &&
        entry.candidate.availability === "playable",
    );
    if (verifiedPlayable) {
      bestEntry = verifiedPlayable;
    } else if (
      bestEntry.candidate.confidenceScore >= 85 &&
      !isPlayableAvailability(bestEntry.candidate.availability)
    ) {
      const unverifiedPlayable = allScored.find(
        (entry) =>
          entry.candidate.confidenceScore >= 85 && isPlayableAvailability(entry.candidate.availability),
      );
      if (unverifiedPlayable) {
        bestEntry = unverifiedPlayable;
      }
    }
  } else if (
    bestEntry.candidate.confidenceScore >= 85 &&
    !isPlayableAvailability(bestEntry.candidate.availability)
  ) {
    const playableHighConfidence = allScored.find(
      (entry) =>
        entry.candidate.confidenceScore >= 85 && isPlayableAvailability(entry.candidate.availability),
    );
    if (playableHighConfidence) {
      bestEntry = playableHighConfidence;
    }
  }

  const top5 = allScored.slice(0, 5).map((entry) => entry.candidate);
  const ranked = top5.some((c) => c.targetTrackId === bestEntry.candidate.targetTrackId)
    ? top5
    : top5.length < 5
      ? [...top5, bestEntry.candidate]
      : [...top5.slice(0, 4), bestEntry.candidate];

  const best = bestEntry.candidate;
  const formatRestrictedReason = (baseReason: string): string => {
    if (checkAvailability && bestEntry.probeStatus === "probe_error") {
      return `音源实测未完成（${bestEntry.probeError ?? "音源探测失败"}）：${baseReason}`;
    }
    return baseReason;
  };

  if (best.confidenceScore >= 85) {
    if (best.availability === "copyright_unavailable") {
      return {
        sourceTrack,
        status: "copyright_unavailable",
        candidates: ranked,
        selectedCandidate: best,
        reason: formatRestrictedReason("目标平台曲目无版权"),
      };
    }
    if (best.availability === "vip_only") {
      return {
        sourceTrack,
        status: "vip_only",
        candidates: ranked,
        selectedCandidate: best,
        reason: formatRestrictedReason("目标平台曲目为 VIP 专享"),
      };
    }
    if (best.availability === "paid_album") {
      return {
        sourceTrack,
        status: "vip_only",
        candidates: ranked,
        selectedCandidate: best,
        reason: formatRestrictedReason("目标平台曲目需购买数字专辑"),
      };
    }
    if (best.availability === "restricted") {
      return {
        sourceTrack,
        status: "copyright_unavailable",
        candidates: ranked,
        selectedCandidate: best,
        reason: formatRestrictedReason("目标平台曲目当前受限不可播"),
      };
    }
    if (best.availability === "trial_only") {
      return {
        sourceTrack,
        status: "trial_only",
        candidates: ranked,
        selectedCandidate: best,
        reason: formatRestrictedReason("目标平台仅提供试听片段"),
      };
    }

    if (
      checkAvailability &&
      (bestEntry.probeStatus !== "verified_playable" || best.availability !== "playable")
    ) {
      return {
        sourceTrack,
        status: "manual_review",
        candidates: ranked,
        reason:
          bestEntry.probeStatus === "probe_error"
            ? bestEntry.probeError
              ? `音源实测未完成（${bestEntry.probeError}），请人工确认可用性`
              : "音源实测未完成，请人工确认可用性"
            : "已达单曲实测上限，候选未经音源实测，请人工确认可用性",
      };
    }

    return {
      sourceTrack,
      status: "matched",
      candidates: ranked,
      selectedCandidate: best,
    };
  }

  if (!bestEntry.hasTitleMatch) {
    return {
      sourceTrack,
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到歌名匹配的候选",
    };
  }

  return {
    sourceTrack,
    status: "manual_review",
    candidates: ranked,
    reason: "存在相似候选，建议人工确认",
  };
}

export function summarizeTransferResults(results: readonly TransferTrackResult[]): TransferSummary {
  const summary: TransferSummary = {
    total: results.length,
    matched: 0,
    manualReview: 0,
    notFound: 0,
    unavailable: 0,
    duplicate: 0,
    skipped: 0,
  };

  for (const item of results) {
    switch (item.status) {
      case "matched":
        summary.matched += 1;
        break;
      case "manual_review":
        summary.manualReview += 1;
        break;
      case "not_found":
        summary.notFound += 1;
        break;
      case "copyright_unavailable":
      case "vip_only":
      case "trial_only":
        summary.unavailable += 1;
        break;
      case "duplicate":
        summary.duplicate += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
    }
  }
  return summary;
}
