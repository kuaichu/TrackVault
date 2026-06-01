import type { MatchCandidate, ProviderTrack, TransferTrack, TransferTrackResult } from "./types.js";

function normalizeText(value: string | undefined) {
  return (value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\s·・._\-—:：'"]/g, "")
    .trim();
}

function normalizeArtists(artists: string[]) {
  return artists.map(normalizeText).filter(Boolean);
}

function hasArtistOverlap(sourceArtists: string[], targetArtists: string[]) {
  const normalizedSource = normalizeArtists(sourceArtists);
  const normalizedTarget = normalizeArtists(targetArtists);
  if (normalizedSource.length === 0 || normalizedTarget.length === 0) {
    return false;
  }

  return normalizedSource.some((sourceArtist) =>
    normalizedTarget.some((targetArtist) => sourceArtist === targetArtist || sourceArtist.includes(targetArtist) || targetArtist.includes(sourceArtist))
  );
}

function scoreCandidate(source: TransferTrack, candidate: ProviderTrack) {
  const sourceTitle = normalizeText(source.title);
  const candidateTitle = normalizeText(candidate.title);
  const sourceAlbum = normalizeText(source.album);
  const candidateAlbum = normalizeText(candidate.album);
  const reasons: string[] = [];
  let score = 0;

  if (sourceTitle && sourceTitle === candidateTitle) {
    score += 55;
    reasons.push("歌名完全一致");
  } else if (sourceTitle && candidateTitle && (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle))) {
    score += 35;
    reasons.push("歌名高度相似");
  }

  if (hasArtistOverlap(source.artists, candidate.artists)) {
    score += 30;
    reasons.push("歌手匹配");
  }

  if (sourceAlbum && candidateAlbum && sourceAlbum === candidateAlbum) {
    score += 10;
    reasons.push("专辑一致");
  }

  if (
    Number.isFinite(source.durationSeconds) &&
    Number.isFinite(candidate.durationSeconds) &&
    Math.abs(Number(source.durationSeconds) - Number(candidate.durationSeconds)) <= 3
  ) {
    score += 5;
    reasons.push("时长接近");
  }

  if (sourceTitle === candidateTitle && hasArtistOverlap(source.artists, candidate.artists) && (!sourceAlbum || sourceAlbum === candidateAlbum)) {
    score = 100;
  }

  return {
    score: Math.min(100, score),
    reasons
  };
}

function toCandidate(source: TransferTrack, candidate: ProviderTrack): MatchCandidate {
  const scored = scoreCandidate(source, candidate);

  return {
    provider: candidate.provider,
    targetTrackId: candidate.id,
    title: candidate.title,
    artists: candidate.artists,
    album: candidate.album,
    durationSeconds: candidate.durationSeconds,
    confidenceScore: scored.score,
    reasons: scored.reasons
  };
}

export function matchTransferTrack(sourceTrack: TransferTrack, candidates: ProviderTrack[]): TransferTrackResult {
  const rankedCandidates = candidates
    .map((candidate) => toCandidate(sourceTrack, candidate))
    .filter((candidate) => candidate.confidenceScore > 0)
    .sort((left, right) => right.confidenceScore - left.confidenceScore)
    .slice(0, 5);

  if (rankedCandidates.length === 0) {
    return {
      sourceTrack,
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到候选歌曲"
    };
  }

  const best = rankedCandidates[0];
  if (best.confidenceScore >= 90) {
    return {
      sourceTrack,
      status: "matched",
      candidates: rankedCandidates,
      selectedCandidate: best
    };
  }

  return {
    sourceTrack,
    status: "manual_review",
    candidates: rankedCandidates,
    reason: "存在相似候选，需要人工确认"
  };
}

export function summarizeTransferResults(results: TransferTrackResult[]) {
  return {
    total: results.length,
    matched: results.filter((item) => item.status === "matched").length,
    manualReview: results.filter((item) => item.status === "manual_review" || item.status === "metadata_conflict").length,
    notFound: results.filter((item) => item.status === "not_found").length,
    unavailable: results.filter((item) => item.status === "copyright_unavailable" || item.status === "vip_only" || item.status === "trial_only").length,
    duplicate: results.filter((item) => item.status === "duplicate").length,
    skipped: results.filter((item) => item.status === "skipped").length
  };
}
