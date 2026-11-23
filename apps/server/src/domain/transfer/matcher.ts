import type {
  CompareItem,
  CompareResult,
  CompareSummary,
  MatchCandidate,
  MusicPlatform,
  TransferAvailability,
  TransferSummary,
  TransferTrack,
  TransferTrackResult,
} from "#shared";

export interface ProviderCandidateTrack {
  provider: MusicPlatform;
  id: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  availability?: TransferAvailability;
}

export function normalizeMatchText(value: string | undefined): string {
  const base = (value ?? "").toLocaleLowerCase().normalize("NFKC");
  const withoutParens = base.replace(/[（(][^）)]*[）)]/g, "");
  const clean = (source: string) => source.replace(/[\s·・._\-—–:：'"!！?？,，()（）]/g, "").trim();

  // If stripping parentheticals leaves an empty string (e.g. a title that is purely "(Intro)"),
  // keep the inner text so two distinct parenthesized titles never collide as "".
  const stripped = clean(withoutParens);
  return stripped || clean(base);
}

export function hasArtistOverlap(
  normalizedSourceArtists: readonly string[],
  normalizedTargetArtists: readonly string[],
): boolean {
  if (normalizedSourceArtists.length === 0 || normalizedTargetArtists.length === 0) {
    return false;
  }

  return normalizedSourceArtists.some((src) =>
    normalizedTargetArtists.some((dst) => {
      if (src === dst) return true;
      // Avoid false positives on single-character names (e.g. "A" or "李") using substring match
      if (src.length < 2 || dst.length < 2) return false;
      return src.includes(dst) || dst.includes(src);
    }),
  );
}

export function scoreTrackMatch(
  source: TransferTrack,
  candidate: ProviderCandidateTrack,
): { score: number; reasons: string[] } {
  const sourceTitle = normalizeMatchText(source.title);
  const candidateTitle = normalizeMatchText(candidate.title);
  const sourceAlbum = normalizeMatchText(source.album);
  const candidateAlbum = normalizeMatchText(candidate.album);
  const sourceArtists = source.artists.map(normalizeMatchText).filter(Boolean);
  const candidateArtists = candidate.artists.map(normalizeMatchText).filter(Boolean);
  const artistOverlap = hasArtistOverlap(sourceArtists, candidateArtists);

  const reasons: string[] = [];
  let score = 0;

  if (sourceTitle && candidateTitle) {
    if (sourceTitle === candidateTitle) {
      score += 55;
      reasons.push("歌名完全一致");
    } else if (
      sourceTitle.length >= 2 &&
      candidateTitle.length >= 2 &&
      (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle))
    ) {
      score += 35;
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

  // Must require non-empty normalized title before awarding exact 100
  if (
    sourceTitle.length > 0 &&
    sourceTitle === candidateTitle &&
    artistOverlap &&
    (!sourceAlbum || sourceAlbum === candidateAlbum)
  ) {
    score = 100;
  }

  return { score: Math.min(100, score), reasons };
}

export function matchTransferTrack(
  sourceTrack: TransferTrack,
  candidates: readonly ProviderCandidateTrack[],
): TransferTrackResult {
  const ranked: MatchCandidate[] = candidates
    .map((candidate) => {
      const scored = scoreTrackMatch(sourceTrack, candidate);
      return {
        provider: candidate.provider,
        targetTrackId: candidate.id,
        title: candidate.title,
        artists: candidate.artists,
        album: candidate.album,
        durationSeconds: candidate.durationSeconds,
        availability: candidate.availability,
        confidenceScore: scored.score,
        reasons: scored.reasons,
      };
    })
    .filter((item) => item.confidenceScore > 0)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, 5);

  const best = ranked[0];
  if (!best) {
    return {
      sourceTrack,
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到匹配候选",
    };
  }

  if (best.availability === "copyright_unavailable") {
    return {
      sourceTrack,
      status: "copyright_unavailable",
      candidates: ranked,
      selectedCandidate: best,
      reason: "目标平台曲目无版权",
    };
  }
  if (best.availability === "vip_only") {
    return {
      sourceTrack,
      status: "vip_only",
      candidates: ranked,
      selectedCandidate: best,
      reason: "目标平台曲目为 VIP 专享",
    };
  }
  if (best.availability === "trial_only") {
    return {
      sourceTrack,
      status: "trial_only",
      candidates: ranked,
      selectedCandidate: best,
      reason: "目标平台仅提供试听片段",
    };
  }

  if (best.confidenceScore >= 85) {
    return {
      sourceTrack,
      status: "matched",
      candidates: ranked,
      selectedCandidate: best,
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

interface PreNormalizedTrack {
  readonly track: TransferTrack;
  readonly title: string;
  readonly artists: readonly string[];
  readonly album: string;
}

function preNormalize(track: TransferTrack): PreNormalizedTrack {
  return {
    track,
    title: normalizeMatchText(track.title),
    artists: track.artists.map(normalizeMatchText).filter(Boolean),
    album: normalizeMatchText(track.album),
  };
}

/**
 * Cooperative async playlist comparator with pre-normalized keys and event-loop yielding,
 * preventing synchronous O(N*M) CPU DoS on large playlists.
 */
export async function comparePlaylistsAsync(input: {
  left: { provider: MusicPlatform; playlistId: string; playlistName: string; tracks: TransferTrack[] };
  right: { provider: MusicPlatform; playlistId: string; playlistName: string; tracks: TransferTrack[] };
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<CompareResult> {
  const leftNorm = input.left.tracks.map(preNormalize);
  const rightNorm = input.right.tracks.map(preNormalize);

  // Index exact titles on right side for O(1) fast path
  const rightByTitle = new Map<string, number[]>();
  rightNorm.forEach((item, idx) => {
    if (!item.title) return;
    const bucket = rightByTitle.get(item.title);
    if (bucket) bucket.push(idx);
    else rightByTitle.set(item.title, [idx]);
  });

  const matchedRightIndexes = new Set<number>();
  const items: CompareItem[] = [];
  const summary: CompareSummary = {
    leftTotal: leftNorm.length,
    rightTotal: rightNorm.length,
    exact: 0,
    sameTitleDifferentArtist: 0,
    similarTitle: 0,
    leftOnly: 0,
    rightOnly: 0,
  };

  for (let i = 0; i < leftNorm.length; i += 1) {
    if (input.signal?.aborted) {
      throw new Error("歌单对比已取消");
    }
    if (i > 0 && i % 40 === 0) {
      input.onProgress?.(Math.min(95, Math.round((i / Math.max(1, leftNorm.length)) * 95)));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const left = leftNorm[i];
    if (!left) continue;

    let bestIdx = -1;
    let bestScore = 0;
    let bestStatus: CompareItem["status"] = "left_only";

    // Fast path: exact title bucket first
    const exactBucket = left.title ? (rightByTitle.get(left.title) ?? []) : [];
    for (const rIdx of exactBucket) {
      if (matchedRightIndexes.has(rIdx)) continue;
      const right = rightNorm[rIdx];
      if (!right) continue;
      const overlap = hasArtistOverlap(left.artists, right.artists);
      if (overlap) {
        bestIdx = rIdx;
        bestScore = 100;
        bestStatus = "exact";
        break;
      }
      if (bestScore < 60) {
        bestIdx = rIdx;
        bestScore = 60;
        bestStatus = "same_title_different_artist";
      }
    }

    // Fallback scan only if not exact match
    if (bestStatus !== "exact" && left.title.length >= 2) {
      for (let rIdx = 0; rIdx < rightNorm.length; rIdx += 1) {
        if (matchedRightIndexes.has(rIdx)) continue;
        const right = rightNorm[rIdx];
        if (!right || right.title.length < 2) continue;
        if (left.title.includes(right.title) || right.title.includes(left.title)) {
          const overlap = hasArtistOverlap(left.artists, right.artists);
          const candidateScore = overlap ? 80 : 45;
          if (candidateScore > bestScore) {
            bestIdx = rIdx;
            bestScore = candidateScore;
            bestStatus = overlap ? "similar_title" : "similar_title";
          }
        }
      }
    }

    if (bestIdx >= 0 && bestScore >= 60) {
      matchedRightIndexes.add(bestIdx);
      const matchedRight = rightNorm[bestIdx];
      items.push({
        status: bestStatus,
        score: bestScore,
        left: left.track,
        right: matchedRight?.track,
      });
      if (bestStatus === "exact") summary.exact += 1;
      else if (bestStatus === "same_title_different_artist") summary.sameTitleDifferentArtist += 1;
      else summary.similarTitle += 1;
    } else {
      items.push({ status: "left_only", score: 0, left: left.track });
      summary.leftOnly += 1;
    }
  }

  for (let rIdx = 0; rIdx < rightNorm.length; rIdx += 1) {
    if (matchedRightIndexes.has(rIdx)) continue;
    const right = rightNorm[rIdx];
    if (!right) continue;
    items.push({ status: "right_only", score: 0, right: right.track });
    summary.rightOnly += 1;
  }

  input.onProgress?.(100);

  return {
    left: {
      provider: input.left.provider,
      playlistId: input.left.playlistId,
      playlistName: input.left.playlistName,
      total: leftNorm.length,
    },
    right: {
      provider: input.right.provider,
      playlistId: input.right.playlistId,
      playlistName: input.right.playlistName,
      total: rightNorm.length,
    },
    summary,
    items,
  };
}
