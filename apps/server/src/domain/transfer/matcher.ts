import type {
  CompareItem,
  CompareResult,
  CompareStatus,
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
  readonly canonicalArtistKey: string;
  readonly versionTags: Set<VersionTag>;
  readonly versionKey: string;
  readonly canonicalTrackKey: string;
}

function buildCanonicalArtistKey(rawArtists: readonly string[]): string {
  const set = new Set<string>();
  for (const raw of rawArtists) {
    for (const alias of expandArtistAliases(raw)) {
      set.add(alias);
    }
  }
  return [...set].sort().join("|");
}

function preNormalize(track: TransferTrack): PreNormalizedTrack {
  const title = normalizeMatchText(track.title);
  const versionTags = extractVersionTags(track.title);
  const versionKey = [...versionTags].sort().join(",");
  const canonicalArtistKey = buildCanonicalArtistKey(track.artists);
  const canonicalTrackKey = [
    canonicalArtistKey,
    versionKey,
    normalizeVersionPreservingText(track.title),
    normalizeMatchText(track.album),
    String(track.durationSeconds ?? ""),
    track.source,
    track.sourceTrackId ?? "",
  ].join("\0");

  return {
    track,
    title,
    rawArtists: track.artists,
    canonicalArtistKey,
    versionTags,
    versionKey,
    canonicalTrackKey,
  };
}

function hasCompatibleVersion(a: PreNormalizedTrack, b: PreNormalizedTrack): boolean {
  return a.versionTags.has("instrumental") === b.versionTags.has("instrumental");
}

function hasIdenticalVersionTags(a: PreNormalizedTrack, b: PreNormalizedTrack): boolean {
  return a.versionKey === b.versionKey;
}

const MAX_EXACT_WEIGHT_BUCKET_SIZE = 160;

function compareCanonicalIndex(aIdx: number, bIdx: number, norm: readonly PreNormalizedTrack[]): number {
  const keyA = norm[aIdx]?.canonicalTrackKey ?? "";
  const keyB = norm[bIdx]?.canonicalTrackKey ?? "";
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  return aIdx - bIdx;
}

/**
 * Deterministic maximum-weight bipartite matching (1-indexed Kuhn-Munkres with dummy zero-weight columns).
 * When invoked on canonically sorted left and right index slices, both total category counts and tie-broken
 * pairings are 100% invariant to arbitrary permutations of either input playlist.
 */
function solveMaxWeightBipartiteMatching(
  rowCount: number,
  colCount: number,
  getWeight: (r: number, c: number) => number,
): Array<{ row: number; col: number }> {
  if (rowCount === 0 || colCount === 0) return [];

  const n = rowCount;
  const m = Math.max(rowCount, colCount);
  const weights: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  let maxWeight = 0;

  for (let i = 1; i <= n; i += 1) {
    const wRow = weights[i];
    if (!wRow) continue;
    for (let j = 1; j <= colCount; j += 1) {
      const w = getWeight(i - 1, j - 1);
      wRow[j] = w;
      if (w > maxWeight) maxWeight = w;
    }
  }

  if (maxWeight <= 0) return [];

  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0] ?? 0;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      const wRow = weights[i0];

      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const cost = maxWeight - (wRow?.[j] ?? 0);
        const cur = cost - (u[i0] ?? 0) - (v[j] ?? 0);
        if (cur < (minv[j] ?? Number.POSITIVE_INFINITY)) {
          minv[j] = cur;
          way[j] = j0;
        }
        const candidateMin = minv[j] ?? Number.POSITIVE_INFINITY;
        if (candidateMin < delta) {
          delta = candidateMin;
          j1 = j;
        }
      }

      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          const matchedRow = p[j] ?? 0;
          u[matchedRow] = (u[matchedRow] ?? 0) + delta;
          v[j] = (v[j] ?? 0) - delta;
        } else {
          minv[j] = (minv[j] ?? Number.POSITIVE_INFINITY) - delta;
        }
      }
      j0 = j1;
    } while ((p[j0] ?? 0) !== 0);

    do {
      const j1 = way[j0] ?? 0;
      p[j0] = p[j1] ?? 0;
      j0 = j1;
    } while (j0 !== 0);
  }

  const pairs: Array<{ row: number; col: number }> = [];
  for (let j = 1; j <= colCount; j += 1) {
    const i = p[j] ?? 0;
    if (i > 0 && (weights[i]?.[j] ?? 0) > 0) {
      pairs.push({ row: i - 1, col: j - 1 });
    }
  }
  return pairs;
}

/**
 * Fallback deterministic augmenting-path solver for oversized (>160) pathological buckets,
 * breaking ties strictly by canonical track keys on both sides before original indices.
 */
function solveDeterministicBipartiteMatching(
  leftIndices: readonly number[],
  leftNorm: readonly PreNormalizedTrack[],
  rightNorm: readonly PreNormalizedTrack[],
  buildEdges: (leftIdx: number, leftItem: PreNormalizedTrack) => Array<{ rIdx: number; tier: number }>,
): Array<{ lIdx: number; rIdx: number }> {
  const adjByLeft = new Map<number, number[]>();
  const bestTierByLeft = new Map<number, number>();

  for (const lIdx of leftIndices) {
    const leftItem = leftNorm[lIdx];
    if (!leftItem) continue;
    const rawEdges = buildEdges(lIdx, leftItem);
    if (rawEdges.length === 0) continue;
    rawEdges.sort((a, b) => b.tier - a.tier || compareCanonicalIndex(a.rIdx, b.rIdx, rightNorm));
    adjByLeft.set(
      lIdx,
      rawEdges.map((e) => e.rIdx),
    );
    bestTierByLeft.set(lIdx, rawEdges[0]?.tier ?? 0);
  }

  const orderedLeft = [...adjByLeft.keys()].sort((a, b) => {
    const degDiff = (adjByLeft.get(a)?.length ?? 0) - (adjByLeft.get(b)?.length ?? 0);
    if (degDiff !== 0) return degDiff;
    const tierDiff = (bestTierByLeft.get(b) ?? 0) - (bestTierByLeft.get(a) ?? 0);
    if (tierDiff !== 0) return tierDiff;
    return compareCanonicalIndex(a, b, leftNorm);
  });

  const matchRightToLeft = new Map<number, number>();

  const tryAugment = (lIdx: number, visitedRight: Set<number>): boolean => {
    const neighbors = adjByLeft.get(lIdx);
    if (!neighbors) return false;
    for (const rIdx of neighbors) {
      if (visitedRight.has(rIdx)) continue;
      visitedRight.add(rIdx);
      const existingLeft = matchRightToLeft.get(rIdx);
      if (existingLeft === undefined || tryAugment(existingLeft, visitedRight)) {
        matchRightToLeft.set(rIdx, lIdx);
        return true;
      }
    }
    return false;
  };

  for (const lIdx of orderedLeft) {
    tryAugment(lIdx, new Set<number>());
  }

  const pairs: Array<{ lIdx: number; rIdx: number }> = [];
  for (const [rIdx, lIdx] of matchRightToLeft.entries()) {
    pairs.push({ lIdx, rIdx });
  }
  return pairs;
}

/**
 * Cooperative multi-pass async playlist comparator:
 * - Passes 1 + 1b + 2 (joint per-title-bucket weighted bipartite matching):
 *   1) exact matches (exact normalized title + identical version tags + artist overlap; exact artist set preferred)
 *   1b) same normalized title + artist overlap + different non-instrumental version (e.g. Studio vs Live -> similar_title)
 *   2) same exact normalized title with different artist (or incompatible instrumental version)
 * - Pass 3: cross-bucket similar title with artist overlap (substring ratio >= 0.5), solved canonically per component.
 * Invariant to arbitrary permutations of BOTH left and right playlists while yielding cooperatively to the event loop.
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

  const leftByTitle = new Map<string, number[]>();
  leftNorm.forEach((item, idx) => {
    if (!item.title) return;
    const bucket = leftByTitle.get(item.title);
    if (bucket) bucket.push(idx);
    else leftByTitle.set(item.title, [idx]);
  });

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

  const titleGroups = [...leftByTitle.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  // Joint Passes 1, 1b & 2 per normalized-title bucket
  for (let g = 0; g < titleGroups.length; g += 1) {
    await yieldIfNeeded(g, 0, 65, titleGroups.length);
    const [title, leftBucket] = titleGroups[g] ?? ["", []];
    const rightBucket = rightByTitle.get(title);
    if (!rightBucket || rightBucket.length === 0 || leftBucket.length === 0) continue;

    const orderedLeft = [...leftBucket].sort((a, b) => compareCanonicalIndex(a, b, leftNorm));
    const orderedRight = [...rightBucket].sort((a, b) => compareCanonicalIndex(a, b, rightNorm));
    const bucketSpan = Math.max(orderedLeft.length, orderedRight.length);

    if (bucketSpan <= MAX_EXACT_WEIGHT_BUCKET_SIZE) {
      // Strictly hierarchical base B ensures:
      // 1) max #exact -> 2) max #exact-artist-set -> 3) max #pass1b-similar -> 4) max #pass1b-exact-artist -> 5) max #pass2
      const B = bucketSpan + 1;
      const B2 = B * B;
      const B3 = B2 * B;
      const B4 = B3 * B;

      const classifyEdge = (
        left: PreNormalizedTrack,
        right: PreNormalizedTrack,
      ): { weight: number; status: CompareStatus; score: number; reason?: string } => {
        const artistOverlap = hasArtistOverlap(left.rawArtists, right.rawArtists);
        const exactArtistSet =
          left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;
        if (artistOverlap && hasIdenticalVersionTags(left, right)) {
          return {
            weight: B4 + (exactArtistSet ? B3 : 0),
            status: "exact",
            score: 100,
          };
        }
        if (artistOverlap && hasCompatibleVersion(left, right)) {
          return {
            weight: B2 + (exactArtistSet ? B : 0),
            status: "similar_title",
            score: 80,
            reason: "同名同歌手不同版本",
          };
        }
        return {
          weight: 1,
          status: "same_title_different_artist",
          score: 60,
        };
      };

      const matched = solveMaxWeightBipartiteMatching(orderedLeft.length, orderedRight.length, (r, c) => {
        const lIdx = orderedLeft[r];
        const rIdx = orderedRight[c];
        const left = lIdx !== undefined ? leftNorm[lIdx] : undefined;
        const right = rIdx !== undefined ? rightNorm[rIdx] : undefined;
        if (!left || !right) return 0;
        return classifyEdge(left, right).weight;
      });

      for (const { row, col } of matched) {
        const lIdx = orderedLeft[row];
        const rIdx = orderedRight[col];
        if (lIdx === undefined || rIdx === undefined) continue;
        const left = leftNorm[lIdx];
        const right = rightNorm[rIdx];
        if (!left || !right) continue;
        const info = classifyEdge(left, right);
        matchedRightIndexes.add(rIdx);
        leftAssignments[lIdx] = {
          status: info.status,
          score: info.score,
          left: left.track,
          right: right.track,
          ...(info.reason ? { reason: info.reason } : {}),
        };
      }
    } else {
      // Oversized bucket fallback with canonical tie-breaking on both sides
      const pass1Pairs = solveDeterministicBipartiteMatching(
        orderedLeft,
        leftNorm,
        rightNorm,
        (_lIdx, left) => {
          const edges: Array<{ rIdx: number; tier: number }> = [];
          for (const rIdx of orderedRight) {
            if (matchedRightIndexes.has(rIdx)) continue;
            const right = rightNorm[rIdx];
            if (!right || !hasIdenticalVersionTags(left, right)) continue;
            if (!hasArtistOverlap(left.rawArtists, right.rawArtists)) continue;
            const exactArtistSet =
              left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;
            edges.push({ rIdx, tier: exactArtistSet ? 2 : 1 });
          }
          return edges;
        },
      );
      for (const { lIdx, rIdx } of pass1Pairs) {
        const left = leftNorm[lIdx];
        const right = rightNorm[rIdx];
        if (!left || !right) continue;
        matchedRightIndexes.add(rIdx);
        leftAssignments[lIdx] = { status: "exact", score: 100, left: left.track, right: right.track };
      }

      const unmatched1b = orderedLeft.filter((idx) => !leftAssignments[idx]);
      const pass1bPairs = solveDeterministicBipartiteMatching(
        unmatched1b,
        leftNorm,
        rightNorm,
        (_lIdx, left) => {
          const edges: Array<{ rIdx: number; tier: number }> = [];
          for (const rIdx of orderedRight) {
            if (matchedRightIndexes.has(rIdx)) continue;
            const right = rightNorm[rIdx];
            if (!right || !hasCompatibleVersion(left, right)) continue;
            if (!hasArtistOverlap(left.rawArtists, right.rawArtists)) continue;
            const exactArtistSet =
              left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;
            edges.push({ rIdx, tier: exactArtistSet ? 2 : 1 });
          }
          return edges;
        },
      );
      for (const { lIdx, rIdx } of pass1bPairs) {
        const left = leftNorm[lIdx];
        const right = rightNorm[rIdx];
        if (!left || !right) continue;
        matchedRightIndexes.add(rIdx);
        leftAssignments[lIdx] = {
          status: "similar_title",
          score: 80,
          left: left.track,
          right: right.track,
          reason: "同名同歌手不同版本",
        };
      }

      for (const lIdx of orderedLeft) {
        if (leftAssignments[lIdx]) continue;
        const left = leftNorm[lIdx];
        if (!left) continue;
        for (const rIdx of orderedRight) {
          if (matchedRightIndexes.has(rIdx)) continue;
          const right = rightNorm[rIdx];
          if (!right) continue;
          matchedRightIndexes.add(rIdx);
          leftAssignments[lIdx] = {
            status: "same_title_different_artist",
            score: 60,
            left: left.track,
            right: right.track,
          };
          break;
        }
      }
    }
  }

  // Pass 3: Similar title with artist overlap on remaining unmatched tracks (canonically ordered on both sides)
  const remainingPass3 = leftNorm
    .map((_, idx) => idx)
    .filter((idx) => !leftAssignments[idx] && (leftNorm[idx]?.title.length ?? 0) >= 2)
    .sort((a, b) => compareCanonicalIndex(a, b, leftNorm));

  const remainingRightPass3 = rightNorm
    .map((_, idx) => idx)
    .filter((idx) => !matchedRightIndexes.has(idx) && (rightNorm[idx]?.title.length ?? 0) >= 2)
    .sort((a, b) => compareCanonicalIndex(a, b, rightNorm));

  if (
    remainingPass3.length > 0 &&
    remainingRightPass3.length > 0 &&
    Math.max(remainingPass3.length, remainingRightPass3.length) <= MAX_EXACT_WEIGHT_BUCKET_SIZE
  ) {
    await yieldIfNeeded(1, 65, 30, 1);
    const pass3Matched = solveMaxWeightBipartiteMatching(
      remainingPass3.length,
      remainingRightPass3.length,
      (r, c) => {
        const lIdx = remainingPass3[r];
        const rIdx = remainingRightPass3[c];
        const left = lIdx !== undefined ? leftNorm[lIdx] : undefined;
        const right = rIdx !== undefined ? rightNorm[rIdx] : undefined;
        if (!left || !right) return 0;
        if (!hasCompatibleVersion(left, right)) return 0;
        if (!hasArtistOverlap(left.rawArtists, right.rawArtists)) return 0;
        if (!(left.title.includes(right.title) || right.title.includes(left.title))) return 0;
        const minLen = Math.min(left.title.length, right.title.length);
        const maxLen = Math.max(left.title.length, right.title.length);
        const ratio = minLen / maxLen;
        if (ratio < 0.5) return 0;
        const exactArtistSet =
          left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;
        return 1_000_000 + Math.round(ratio * 10_000) * 4 + (exactArtistSet ? 2 : 1);
      },
    );

    for (const { row, col } of pass3Matched) {
      const lIdx = remainingPass3[row];
      const rIdx = remainingRightPass3[col];
      if (lIdx === undefined || rIdx === undefined) continue;
      const left = leftNorm[lIdx];
      const right = rightNorm[rIdx];
      if (!left || !right) continue;
      matchedRightIndexes.add(rIdx);
      leftAssignments[lIdx] = {
        status: "similar_title",
        score: 80,
        left: left.track,
        right: right.track,
      };
    }
  } else {
    for (let step = 0; step < remainingPass3.length; step += 1) {
      await yieldIfNeeded(step, 65, 30, remainingPass3.length);
      const i = remainingPass3[step];
      if (i === undefined || leftAssignments[i]) continue;
      const left = leftNorm[i];
      if (!left || left.title.length < 2) continue;

      let bestIdx = -1;
      let bestScore = 0;
      for (const rIdx of remainingRightPass3) {
        if (matchedRightIndexes.has(rIdx)) continue;
        const right = rightNorm[rIdx];
        if (!right || right.title.length < 2) continue;
        if (!hasCompatibleVersion(left, right)) continue;
        if (!hasArtistOverlap(left.rawArtists, right.rawArtists)) continue;

        if (left.title.includes(right.title) || right.title.includes(left.title)) {
          const minLen = Math.min(left.title.length, right.title.length);
          const maxLen = Math.max(left.title.length, right.title.length);
          const ratio = minLen / maxLen;
          if (ratio >= 0.5) {
            const exactArtistSet =
              left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;
            const candidateScore = Math.round(ratio * 10_000) * 4 + (exactArtistSet ? 2 : 1);
            if (candidateScore > bestScore) {
              bestScore = candidateScore;
              bestIdx = rIdx;
            }
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
