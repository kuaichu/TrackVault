import {
  type CompareItem,
  type CompareResult,
  type CompareStatus,
  type CompareSummary,
  type MusicPlatform,
  type ScanStats,
  type TransferTrack,
  normalizeScanStats,
} from "#shared";
import {
  type PreNormalizedTrack,
  compareCanonicalIndex,
  hasArtistOverlap,
  hasCompatibleVersion,
  hasIdenticalVersionTags,
  preNormalizeTrack,
} from "./track-normalizer.js";

const MAX_EXACT_WEIGHT_BUCKET_SIZE = 160;

interface TitleBucketEdge {
  readonly tier: 3 | 2 | 1;
  readonly exactArtistSet: boolean;
  readonly weight: number;
  readonly status: CompareStatus;
  readonly score: number;
  readonly reason?: string;
}

/**
 * Unified Pass 1 / 1b / 2 edge classification shared by both exact Kuhn-Munkres and
 * oversized-bucket fallback solvers.
 */
function classifyTitleBucketEdge(
  left: PreNormalizedTrack,
  right: PreNormalizedTrack,
  bucketSpan: number,
): TitleBucketEdge {
  const B = bucketSpan + 1;
  const B2 = B * B;
  const B3 = B2 * B;
  const B4 = B3 * B;

  const artistOverlap = hasArtistOverlap(left.rawArtists, right.rawArtists);
  const exactArtistSet =
    left.canonicalArtistKey.length > 0 && left.canonicalArtistKey === right.canonicalArtistKey;

  if (artistOverlap && hasIdenticalVersionTags(left, right)) {
    return {
      tier: 3,
      exactArtistSet,
      weight: B4 + (exactArtistSet ? B3 : 0),
      status: "exact",
      score: 100,
    };
  }
  if (artistOverlap && hasCompatibleVersion(left, right)) {
    return {
      tier: 2,
      exactArtistSet,
      weight: B2 + (exactArtistSet ? B : 0),
      status: "similar_title",
      score: 80,
      reason: "同名同歌手不同版本",
    };
  }
  return {
    tier: 1,
    exactArtistSet,
    weight: 1,
    status: "same_title_different_artist",
    score: 60,
  };
}

function computePass3EdgeWeight(left: PreNormalizedTrack, right: PreNormalizedTrack): number {
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
 * Fallback deterministic augmenting-path solver ONLY for pathological oversized (>160)
 * single connected components, breaking ties strictly by canonical track keys on both sides.
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

function assignTitleBucketPair(
  lIdx: number,
  rIdx: number,
  edge: Pick<TitleBucketEdge, "status" | "score" | "reason">,
  leftNorm: readonly PreNormalizedTrack[],
  rightNorm: readonly PreNormalizedTrack[],
  matchedRightIndexes: Set<number>,
  leftAssignments: Array<CompareItem | undefined>,
): void {
  const left = leftNorm[lIdx];
  const right = rightNorm[rIdx];
  if (!left || !right) return;
  matchedRightIndexes.add(rIdx);
  leftAssignments[lIdx] = {
    status: edge.status,
    score: edge.score,
    left: left.track,
    right: right.track,
    ...(edge.reason ? { reason: edge.reason } : {}),
  };
}

export interface ComparePlaylistSideInput {
  provider: MusicPlatform;
  playlistId: string;
  playlistName: string;
  tracks: TransferTrack[];
  scanStats?: ScanStats;
}

/**
 * Cooperative multi-pass async playlist comparator:
 * - Passes 1 + 1b + 2 (joint per-title-bucket weighted bipartite matching):
 *   1) exact matches (exact normalized title + identical version tags + artist overlap; exact artist set preferred)
 *   1b) same normalized title + artist overlap + different non-instrumental version (e.g. Studio vs Live -> similar_title)
 *   2) same exact normalized title with different artist (or incompatible instrumental version)
 * - Pass 3: artist-indexed connected-component maximum-weight bipartite matching for cross-bucket similar titles.
 * Invariant to arbitrary permutations of BOTH left and right playlists while yielding cooperatively to the event loop.
 */
export async function comparePlaylistsAsync(input: {
  left: ComparePlaylistSideInput;
  right: ComparePlaylistSideInput;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<CompareResult> {
  const leftNorm = input.left.tracks.map(preNormalizeTrack);
  const rightNorm = input.right.tracks.map(preNormalizeTrack);

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
      const matched = solveMaxWeightBipartiteMatching(orderedLeft.length, orderedRight.length, (r, c) => {
        const lIdx = orderedLeft[r];
        const rIdx = orderedRight[c];
        const left = lIdx !== undefined ? leftNorm[lIdx] : undefined;
        const right = rIdx !== undefined ? rightNorm[rIdx] : undefined;
        if (!left || !right) return 0;
        return classifyTitleBucketEdge(left, right, bucketSpan).weight;
      });

      for (const { row, col } of matched) {
        const lIdx = orderedLeft[row];
        const rIdx = orderedRight[col];
        if (lIdx === undefined || rIdx === undefined) continue;
        const left = leftNorm[lIdx];
        const right = rightNorm[rIdx];
        if (!left || !right) continue;
        const edge = classifyTitleBucketEdge(left, right, bucketSpan);
        assignTitleBucketPair(lIdx, rIdx, edge, leftNorm, rightNorm, matchedRightIndexes, leftAssignments);
      }
    } else {
      // Pathological oversized same-title bucket (>160): unify Pass 1 & 1b via classifyTitleBucketEdge
      for (const targetTier of [3, 2] as const) {
        const unmatchedLeft = orderedLeft.filter((idx) => !leftAssignments[idx]);
        if (unmatchedLeft.length === 0) break;
        const tierPairs = solveDeterministicBipartiteMatching(
          unmatchedLeft,
          leftNorm,
          rightNorm,
          (_lIdx, left) => {
            const edges: Array<{ rIdx: number; tier: number }> = [];
            for (const rIdx of orderedRight) {
              if (matchedRightIndexes.has(rIdx)) continue;
              const right = rightNorm[rIdx];
              if (!right) continue;
              const edge = classifyTitleBucketEdge(left, right, bucketSpan);
              if (edge.tier === targetTier) {
                edges.push({ rIdx, tier: edge.exactArtistSet ? 2 : 1 });
              }
            }
            return edges;
          },
        );
        for (const { lIdx, rIdx } of tierPairs) {
          const left = leftNorm[lIdx];
          const right = rightNorm[rIdx];
          if (!left || !right) continue;
          const edge = classifyTitleBucketEdge(left, right, bucketSpan);
          assignTitleBucketPair(lIdx, rIdx, edge, leftNorm, rightNorm, matchedRightIndexes, leftAssignments);
        }
      }

      for (const lIdx of orderedLeft) {
        if (leftAssignments[lIdx]) continue;
        const left = leftNorm[lIdx];
        if (!left) continue;
        for (const rIdx of orderedRight) {
          if (matchedRightIndexes.has(rIdx)) continue;
          const right = rightNorm[rIdx];
          if (!right) continue;
          const edge = classifyTitleBucketEdge(left, right, bucketSpan);
          assignTitleBucketPair(lIdx, rIdx, edge, leftNorm, rightNorm, matchedRightIndexes, leftAssignments);
          break;
        }
      }
    }
  }

  // Pass 3: Artist-indexed connected-component exact maximum-weight bipartite matching
  const remainingPass3 = leftNorm
    .map((_, idx) => idx)
    .filter((idx) => !leftAssignments[idx] && (leftNorm[idx]?.title.length ?? 0) >= 2)
    .sort((a, b) => compareCanonicalIndex(a, b, leftNorm));

  const remainingRightPass3 = rightNorm
    .map((_, idx) => idx)
    .filter((idx) => !matchedRightIndexes.has(idx) && (rightNorm[idx]?.title.length ?? 0) >= 2)
    .sort((a, b) => compareCanonicalIndex(a, b, rightNorm));

  if (remainingPass3.length > 0 && remainingRightPass3.length > 0) {
    const rightByArtistAlias = new Map<string, number[]>();
    for (const rIdx of remainingRightPass3) {
      const right = rightNorm[rIdx];
      if (!right) continue;
      for (const alias of right.artistAliases) {
        const list = rightByArtistAlias.get(alias);
        if (list) list.push(rIdx);
        else rightByArtistAlias.set(alias, [rIdx]);
      }
    }

    const pass3EdgeWeights = new Map<number, Map<number, number>>();
    const rightAdj = new Map<number, number[]>();

    for (const lIdx of remainingPass3) {
      const left = leftNorm[lIdx];
      if (!left || left.artistAliases.length === 0) continue;

      const candidateRightSet = new Set<number>();
      for (const alias of left.artistAliases) {
        const bucket = rightByArtistAlias.get(alias);
        if (!bucket) continue;
        for (const rIdx of bucket) {
          candidateRightSet.add(rIdx);
        }
      }

      if (candidateRightSet.size === 0) continue;

      const weightedEdges = new Map<number, number>();
      for (const rIdx of candidateRightSet) {
        const right = rightNorm[rIdx];
        if (!right) continue;
        const w = computePass3EdgeWeight(left, right);
        if (w <= 0) continue;
        weightedEdges.set(rIdx, w);
        const rev = rightAdj.get(rIdx);
        if (rev) rev.push(lIdx);
        else rightAdj.set(rIdx, [lIdx]);
      }

      if (weightedEdges.size > 0) {
        pass3EdgeWeights.set(lIdx, weightedEdges);
      }
    }

    const visitedLeft = new Set<number>();
    const visitedRight = new Set<number>();
    const components: Array<{ compLeft: number[]; compRight: number[] }> = [];

    for (const startLeft of remainingPass3) {
      if (visitedLeft.has(startLeft) || !pass3EdgeWeights.has(startLeft)) continue;
      const compLeft: number[] = [];
      const compRight: number[] = [];
      const leftQueue: number[] = [startLeft];
      visitedLeft.add(startLeft);

      while (leftQueue.length > 0) {
        const curLeft = leftQueue.shift();
        if (curLeft === undefined) continue;
        compLeft.push(curLeft);

        const neighbors = pass3EdgeWeights.get(curLeft);
        if (!neighbors) continue;
        for (const rIdx of neighbors.keys()) {
          if (visitedRight.has(rIdx)) continue;
          visitedRight.add(rIdx);
          compRight.push(rIdx);
          for (const nextLeft of rightAdj.get(rIdx) ?? []) {
            if (!visitedLeft.has(nextLeft)) {
              visitedLeft.add(nextLeft);
              leftQueue.push(nextLeft);
            }
          }
        }
      }

      compLeft.sort((a, b) => compareCanonicalIndex(a, b, leftNorm));
      compRight.sort((a, b) => compareCanonicalIndex(a, b, rightNorm));
      components.push({ compLeft, compRight });
    }

    for (let cIdx = 0; cIdx < components.length; cIdx += 1) {
      await yieldIfNeeded(cIdx, 65, 30, components.length);
      const comp = components[cIdx];
      if (!comp) continue;
      const { compLeft, compRight } = comp;
      const span = Math.max(compLeft.length, compRight.length);

      if (span <= MAX_EXACT_WEIGHT_BUCKET_SIZE) {
        const matched = solveMaxWeightBipartiteMatching(compLeft.length, compRight.length, (r, c) => {
          const l = compLeft[r];
          const rgt = compRight[c];
          if (l === undefined || rgt === undefined) return 0;
          return pass3EdgeWeights.get(l)?.get(rgt) ?? 0;
        });

        for (const { row, col } of matched) {
          const lIdx = compLeft[row];
          const rIdx = compRight[col];
          if (lIdx === undefined || rIdx === undefined) continue;
          assignTitleBucketPair(
            lIdx,
            rIdx,
            { status: "similar_title", score: 80 },
            leftNorm,
            rightNorm,
            matchedRightIndexes,
            leftAssignments,
          );
        }
      } else {
        const pairs = solveDeterministicBipartiteMatching(compLeft, leftNorm, rightNorm, (lIdx) => {
          const edges: Array<{ rIdx: number; tier: number }> = [];
          for (const [rIdx, weight] of pass3EdgeWeights.get(lIdx)?.entries() ?? []) {
            if (!matchedRightIndexes.has(rIdx)) {
              edges.push({ rIdx, tier: weight });
            }
          }
          return edges;
        });
        for (const { lIdx, rIdx } of pairs) {
          assignTitleBucketPair(
            lIdx,
            rIdx,
            { status: "similar_title", score: 80 },
            leftNorm,
            rightNorm,
            matchedRightIndexes,
            leftAssignments,
          );
        }
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

  const buildSideOutput = (side: ComparePlaylistSideInput, total: number) => {
    const scanStats = side.scanStats ? normalizeScanStats({ scanStats: side.scanStats }, total) : undefined;
    return {
      provider: side.provider,
      playlistId: side.playlistId,
      playlistName: side.playlistName,
      total,
      ...(scanStats ? { scanStats } : {}),
    };
  };

  return {
    left: buildSideOutput(input.left, leftNorm.length),
    right: buildSideOutput(input.right, rightNorm.length),
    summary,
    items,
  };
}
