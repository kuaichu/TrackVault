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
  mediaId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  availability?: TransferAvailability;
}

type VersionTag = "instrumental" | "live" | "remix" | "acoustic" | "cover";

const PUNCTUATION_RE = /[\s·・._\-—–:：'"!！?？,，()（）[\]【】]/g;

function cleanMatchChars(source: string): string {
  return source.replace(PUNCTUATION_RE, "").trim();
}

export function normalizeMatchText(value: string | undefined): string {
  const base = (value ?? "").toLocaleLowerCase().normalize("NFKC");
  const withoutBrackets = base.replace(/[（(][^）)]*[）)]|[\[【][^\]】]*[\]】]/g, "");

  // If stripping parentheticals/brackets leaves an empty string (e.g. "(Intro)"),
  // keep the inner text so distinct parenthesized titles never collide as "".
  const stripped = cleanMatchChars(withoutBrackets);
  return stripped || cleanMatchChars(base);
}

/**
 * Version-preserving normalization used for deduplication when tracks lack a platform ID
 * so "Song" and "Song (Live)" remain distinct recordings.
 */
function normalizeVersionPreservingText(value: string | undefined): string {
  const base = (value ?? "").toLocaleLowerCase().normalize("NFKC");
  return cleanMatchChars(base);
}

/**
 * Builds a transfer deduplication key that prioritizes platform track IDs first,
 * and preserves version qualifiers (e.g. Live / Remix / Acoustic) when IDs are absent.
 */
export function buildTransferDedupKey(track: TransferTrack): string {
  const trackId = track.sourceTrackId?.trim();
  if (trackId) {
    return `${track.source}:${trackId}`;
  }
  const titleKey = normalizeVersionPreservingText(track.title);
  const artistKey = track.artists
    .map((a) => normalizeMatchText(a))
    .filter(Boolean)
    .sort()
    .join(",");
  return `meta:${titleKey}::${artistKey}`;
}

export function extractVersionTags(rawTitle: string | undefined): Set<VersionTag> {
  const tags = new Set<VersionTag>();
  if (!rawTitle) return tags;
  const normalized = rawTitle.toLocaleLowerCase().normalize("NFKC");

  // Inspect bracketed/parenthesized annotations and trailing "- qualifier" suffixes
  const segments: string[] = [];
  for (const m of normalized.matchAll(/[（(]([^）)]+)[）)]|[\[【]([^\]】]+)[\]】]/g)) {
    const seg = (m[1] ?? m[2] ?? "").trim();
    if (seg) segments.push(seg);
  }
  const dashSuffix = normalized.match(/\s+[-—–]\s+([^()（）[\]【】]{2,30})$/);
  if (dashSuffix?.[1]) {
    segments.push(dashSuffix[1].trim());
  }

  for (const seg of segments) {
    if (
      /\b(?:instrumental|karaoke|off\s*vocal|inst\.?|backing\s*track)\b|伴奏|纯音乐|消音|卡拉ok/i.test(seg)
    ) {
      tags.add("instrumental");
    }
    if (/\b(?:live|concert)\b|现场|演唱会/i.test(seg)) {
      tags.add("live");
    }
    if (/\b(?:remix|dj|mashup|club\s*mix|radio\s*edit)\b|混音/i.test(seg)) {
      tags.add("remix");
    }
    if (/\b(?:acoustic|unplugged)\b|不插电|吉他版|钢琴版/i.test(seg)) {
      tags.add("acoustic");
    }
    if (/\bcover\b|翻唱/i.test(seg)) {
      tags.add("cover");
    }
  }

  return tags;
}

/**
 * Expands an artist string into canonical exact-match aliases (outer name + parenthesized alias),
 * without allowing arbitrary substring prefix collisions like "张杰" vs "张杰伦" or "Mark" vs "Mark Ronson".
 */
function expandArtistAliases(raw: string): string[] {
  const base = raw.toLocaleLowerCase().normalize("NFKC").trim();
  if (!base) return [];

  const aliases = new Set<string>();
  const whole = cleanMatchChars(base);
  if (whole) aliases.add(whole);

  const outer = cleanMatchChars(base.replace(/[（(][^）)]*[）)]|[\[【][^\]】]*[\]】]/g, ""));
  if (outer) aliases.add(outer);

  for (const m of base.matchAll(/[（(]([^）)]+)[）)]|[\[【]([^\]】]+)[\]】]/g)) {
    const inner = cleanMatchChars(m[1] ?? m[2] ?? "");
    if (inner.length >= 2) {
      aliases.add(inner);
    }
  }

  return [...aliases];
}

export function hasArtistOverlap(
  sourceArtists: readonly string[],
  targetArtists: readonly string[],
): boolean {
  if (sourceArtists.length === 0 || targetArtists.length === 0) {
    return false;
  }

  const targetAliases = new Set<string>();
  for (const raw of targetArtists) {
    for (const alias of expandArtistAliases(raw)) {
      targetAliases.add(alias);
    }
  }

  if (targetAliases.size === 0) return false;

  for (const raw of sourceArtists) {
    for (const alias of expandArtistAliases(raw)) {
      if (targetAliases.has(alias)) {
        return true;
      }
    }
  }

  return false;
}

function getAvailabilityRank(availability: TransferAvailability | undefined): number {
  switch (availability) {
    case "playable":
      return 4;
    case "unknown":
    case undefined:
      return 3;
    case "vip_only":
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

  // Must require non-empty normalized title and compatible version before awarding exact 100
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

export function matchTransferTrack(
  sourceTrack: TransferTrack,
  candidates: readonly ProviderCandidateTrack[],
): TransferTrackResult {
  const scoredList = candidates
    .map((candidate) => {
      const scored = scoreTrackMatch(sourceTrack, candidate);
      return {
        hasTitleMatch: scored.hasTitleMatch,
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
      return getAvailabilityRank(b.candidate.availability) - getAvailabilityRank(a.candidate.availability);
    })
    .slice(0, 5);

  const ranked = scoredList.map((entry) => entry.candidate);
  let bestEntry = scoredList[0];

  if (!bestEntry) {
    return {
      sourceTrack,
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到匹配候选",
    };
  }

  // Prefer any high-confidence (>= 85) playable candidate over an unavailable one (T08)
  if (
    bestEntry.candidate.confidenceScore >= 85 &&
    !isPlayableAvailability(bestEntry.candidate.availability)
  ) {
    const playableHighConfidence = scoredList.find(
      (entry) =>
        entry.candidate.confidenceScore >= 85 && isPlayableAvailability(entry.candidate.availability),
    );
    if (playableHighConfidence) {
      bestEntry = playableHighConfidence;
    }
  }

  const best = bestEntry.candidate;

  // T07: Verify candidate is actually a confident match (>= 85) BEFORE concluding copyright/VIP status
  if (best.confidenceScore >= 85) {
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

    return {
      sourceTrack,
      status: "matched",
      candidates: ranked,
      selectedCandidate: best,
    };
  }

  // Unrelated same-artist-only candidates without any title similarity are not matches (T07)
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

interface PreNormalizedTrack {
  readonly track: TransferTrack;
  readonly title: string;
  readonly rawArtists: readonly string[];
  readonly versionTags: Set<VersionTag>;
}

function preNormalize(track: TransferTrack): PreNormalizedTrack {
  return {
    track,
    title: normalizeMatchText(track.title),
    rawArtists: track.artists,
    versionTags: extractVersionTags(track.title),
  };
}

function hasCompatibleVersion(a: PreNormalizedTrack, b: PreNormalizedTrack): boolean {
  return a.versionTags.has("instrumental") === b.versionTags.has("instrumental");
}

/**
 * Cooperative 3-pass async playlist comparator:
 * - Pass 1: all exact matches (exact title + artist overlap + compatible version)
 * - Pass 2: exact title with different artist (prevents short substring matches from stealing exact titles)
 * - Pass 3: similar title with artist overlap (substring ratio >= 0.5)
 * Order-independent across left-playlist rearrangements and yields cooperatively to the event loop.
 */
export async function comparePlaylistsAsync(input: {
  left: {
    provider: MusicPlatform;
    playlistId: string;
    playlistName: string;
    tracks: TransferTrack[];
    sourceTotal?: number;
    unprocessedCount?: number;
    truncated?: boolean;
  };
  right: {
    provider: MusicPlatform;
    playlistId: string;
    playlistName: string;
    tracks: TransferTrack[];
    sourceTotal?: number;
    unprocessedCount?: number;
    truncated?: boolean;
  };
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<CompareResult> {
  const leftNorm = input.left.tracks.map(preNormalize);
  const rightNorm = input.right.tracks.map(preNormalize);

  const rightByTitle = new Map<string, number[]>();
  rightNorm.forEach((item, idx) => {
    if (!item.title) return;
    const bucket = rightByTitle.get(item.title);
    if (bucket) bucket.push(idx);
    else rightByTitle.set(item.title, [idx]);
  });

  const matchedRightIndexes = new Set<number>();
  const leftAssignments = new Array<CompareItem | undefined>(leftNorm.length);

  const yieldIfNeeded = async (step: number, basePct: number, spanPct: number, total: number) => {
    if (input.signal?.aborted) {
      throw new Error("歌单对比已取消");
    }
    if (step > 0 && step % 40 === 0) {
      const pct = Math.min(95, Math.round(basePct + (step / Math.max(1, total)) * spanPct));
      input.onProgress?.(pct);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  // Pass 1: Exact matches (exact title + artist overlap + compatible instrumental tag)
  for (let i = 0; i < leftNorm.length; i += 1) {
    await yieldIfNeeded(i, 0, 35, leftNorm.length);
    const left = leftNorm[i];
    if (!left || !left.title) continue;

    const bucket = rightByTitle.get(left.title) ?? [];
    for (const rIdx of bucket) {
      if (matchedRightIndexes.has(rIdx)) continue;
      const right = rightNorm[rIdx];
      if (!right) continue;
      if (hasArtistOverlap(left.rawArtists, right.rawArtists) && hasCompatibleVersion(left, right)) {
        matchedRightIndexes.add(rIdx);
        leftAssignments[i] = {
          status: "exact",
          score: 100,
          left: left.track,
          right: right.track,
        };
        break;
      }
    }
  }

  // Pass 2: Same exact title with different artist (or incompatible version)
  for (let i = 0; i < leftNorm.length; i += 1) {
    if (leftAssignments[i]) continue;
    await yieldIfNeeded(i, 35, 25, leftNorm.length);
    const left = leftNorm[i];
    if (!left || !left.title) continue;

    const bucket = rightByTitle.get(left.title) ?? [];
    for (const rIdx of bucket) {
      if (matchedRightIndexes.has(rIdx)) continue;
      const right = rightNorm[rIdx];
      if (!right) continue;
      matchedRightIndexes.add(rIdx);
      leftAssignments[i] = {
        status: "same_title_different_artist",
        score: 60,
        left: left.track,
        right: right.track,
      };
      break;
    }
  }

  // Pass 3: Similar title with artist overlap on remaining unmatched tracks
  for (let i = 0; i < leftNorm.length; i += 1) {
    if (leftAssignments[i]) continue;
    await yieldIfNeeded(i, 60, 35, leftNorm.length);
    const left = leftNorm[i];
    if (!left || left.title.length < 2) continue;

    let bestIdx = -1;
    let bestRatio = 0;
    for (let rIdx = 0; rIdx < rightNorm.length; rIdx += 1) {
      if (matchedRightIndexes.has(rIdx)) continue;
      const right = rightNorm[rIdx];
      if (!right || right.title.length < 2) continue;
      if (!hasCompatibleVersion(left, right)) continue;
      if (!hasArtistOverlap(left.rawArtists, right.rawArtists)) continue;

      if (left.title.includes(right.title) || right.title.includes(left.title)) {
        const minLen = Math.min(left.title.length, right.title.length);
        const maxLen = Math.max(left.title.length, right.title.length);
        const ratio = minLen / maxLen;
        if (ratio >= 0.5 && ratio > bestRatio) {
          bestRatio = ratio;
          bestIdx = rIdx;
        }
      }
    }

    if (bestIdx >= 0) {
      matchedRightIndexes.add(bestIdx);
      leftAssignments[i] = {
        status: "similar_title",
        score: 80,
        left: left.track,
        right: rightNorm[bestIdx]?.track,
      };
    }
  }

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
    const assigned = leftAssignments[i];
    if (assigned) {
      items.push(assigned);
      if (assigned.status === "exact") summary.exact += 1;
      else if (assigned.status === "same_title_different_artist") summary.sameTitleDifferentArtist += 1;
      else if (assigned.status === "similar_title") summary.similarTitle += 1;
    } else {
      const left = leftNorm[i];
      if (left) {
        items.push({ status: "left_only", score: 0, left: left.track });
        summary.leftOnly += 1;
      }
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
      ...(input.left.sourceTotal !== undefined ? { sourceTotal: input.left.sourceTotal } : {}),
      ...(input.left.unprocessedCount !== undefined ? { unprocessedCount: input.left.unprocessedCount } : {}),
      ...(input.left.truncated !== undefined ? { truncated: input.left.truncated } : {}),
    },
    right: {
      provider: input.right.provider,
      playlistId: input.right.playlistId,
      playlistName: input.right.playlistName,
      total: rightNorm.length,
      ...(input.right.sourceTotal !== undefined ? { sourceTotal: input.right.sourceTotal } : {}),
      ...(input.right.unprocessedCount !== undefined
        ? { unprocessedCount: input.right.unprocessedCount }
        : {}),
      ...(input.right.truncated !== undefined ? { truncated: input.right.truncated } : {}),
    },
    summary,
    items,
  };
}
