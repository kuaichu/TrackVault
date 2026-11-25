import {
  type PlaybackMode,
  type PreferenceQualityLevel,
  QUALITY_RANK,
  type QualityLevel,
  type Song,
  getSongKey,
} from "#shared";
import { isSongPlayable } from "../../../entities/song/index.js";

export function positiveMod(idx: number, len: number): number {
  return ((idx % len) + len) % len;
}

/**
 * Computes the effective quality badge/selection for the current track based on its available tiers
 * so the UI never displays a higher tier (e.g. Hi-Res) than the track actually supports.
 */
export function resolveEffectivePlaybackQuality(
  song: Song | null,
  activeQualityOverride: QualityLevel | null,
  defaultPlaybackQuality: PreferenceQualityLevel,
): QualityLevel {
  const desired: QualityLevel = activeQualityOverride ?? defaultPlaybackQuality;
  if (!song || song.availableQualities.length === 0) {
    return desired;
  }

  if (song.availableQualities.some((q) => q.level === desired)) {
    return desired;
  }

  // Lightweight upstream list items (e.g. un-enriched QQ/persisted entries) may only carry default [128K];
  // honor an explicit manual override while keeping default clamping intact.
  if (
    activeQualityOverride &&
    song.availableQualities.length === 1 &&
    song.availableQualities[0]?.level === "standard"
  ) {
    return activeQualityOverride;
  }

  const desiredRank = QUALITY_RANK[desired] ?? 0;
  let bestAtOrBelow: QualityLevel | null = null;
  let bestAtOrBelowRank = -1;
  let lowestAvailable: QualityLevel | null = null;
  let lowestAvailableRank = Number.POSITIVE_INFINITY;

  for (const option of song.availableQualities) {
    const rank = QUALITY_RANK[option.level] ?? 0;
    if (rank <= desiredRank && rank > bestAtOrBelowRank) {
      bestAtOrBelow = option.level;
      bestAtOrBelowRank = rank;
    }
    if (rank < lowestAvailableRank) {
      lowestAvailable = option.level;
      lowestAvailableRank = rank;
    }
  }

  return bestAtOrBelow ?? lowestAvailable ?? desired;
}

export function cyclePlaybackModeValue(current: PlaybackMode): PlaybackMode {
  const order: PlaybackMode[] = ["sequential", "shuffle", "repeat-one"];
  return order[(order.indexOf(current) + 1) % order.length] ?? "sequential";
}

export function addSongToQueue(queue: readonly Song[], song: Song): Song[] {
  const targetKey = getSongKey(song);
  if (queue.some((item) => getSongKey(item) === targetKey)) {
    return [...queue];
  }
  return [...queue, song];
}

export function insertSongNextInQueue(params: {
  queue: readonly Song[];
  priorityQueue: readonly Song[];
  currentTrack: Song | null;
  song: Song;
}): { queue: Song[]; priorityQueue: Song[] } {
  const targetKey = getSongKey(params.song);
  const filteredQueue = params.queue.filter((item) => getSongKey(item) !== targetKey);
  const filteredPriority = params.priorityQueue.filter((item) => getSongKey(item) !== targetKey);
  const priorityQueue = [params.song, ...filteredPriority];

  if (!params.currentTrack) {
    return { queue: [params.song, ...filteredQueue], priorityQueue };
  }
  const curKey = getSongKey(params.currentTrack);
  const curIdx = filteredQueue.findIndex((item) => getSongKey(item) === curKey);
  if (curIdx < 0) {
    return { queue: [params.song, ...filteredQueue], priorityQueue };
  }
  const queue = [...filteredQueue];
  queue.splice(curIdx + 1, 0, params.song);
  return { queue, priorityQueue };
}

export function removeSongFromQueues(params: {
  queue: readonly Song[];
  priorityQueue: readonly Song[];
  songKey: string;
}): { queue: Song[]; priorityQueue: Song[] } {
  return {
    queue: params.queue.filter((item) => getSongKey(item) !== params.songKey),
    priorityQueue: params.priorityQueue.filter((item) => getSongKey(item) !== params.songKey),
  };
}

export function computeQueuesOnPlay(params: {
  currentQueue: readonly Song[];
  currentPriorityQueue: readonly Song[];
  song: Song;
  explicitQueue?: Song[];
  preservePriorityQueue?: boolean;
}): { queue: Song[]; priorityQueue: Song[] } {
  const songKey = getSongKey(params.song);
  const replacingQueue = Boolean(params.explicitQueue) && !params.preservePriorityQueue;
  const queue = params.explicitQueue
    ? params.explicitQueue
    : params.currentQueue.some((item) => getSongKey(item) === songKey)
      ? [...params.currentQueue]
      : [...params.currentQueue, params.song];
  // P11: Replacing the playlist clears stale priorityQueue entries from the previous playlist
  const priorityQueue = replacingQueue
    ? []
    : params.currentPriorityQueue.filter((item) => getSongKey(item) !== songKey);
  return { queue, priorityQueue };
}

export function dequeueNextPriorityTrack(priorityQueue: readonly Song[]): {
  track: Song | null;
  remaining: Song[];
} {
  const remaining = [...priorityQueue];
  while (remaining.length > 0) {
    const nextPriority = remaining.shift();
    if (isSongPlayable(nextPriority)) {
      return { track: nextPriority, remaining };
    }
  }
  return { track: null, remaining: [] };
}

export function selectNextQueueTrack(params: {
  queue: readonly Song[];
  currentTrack: Song | null;
  playbackMode: PlaybackMode;
}): Song | null {
  const { queue, currentTrack, playbackMode } = params;
  if (queue.length === 0) return null;

  if (playbackMode === "shuffle") {
    const playableOthers = queue.filter(
      (item) => isSongPlayable(item) && (!currentTrack || getSongKey(item) !== getSongKey(currentTrack)),
    );
    if (playableOthers.length > 0) {
      return playableOthers[Math.floor(Math.random() * playableOthers.length)] ?? null;
    }
    const anyPlayable = queue.filter((item) => isSongPlayable(item));
    if (anyPlayable.length > 0) {
      return anyPlayable[Math.floor(Math.random() * anyPlayable.length)] ?? null;
    }
    return null;
  }

  const currentIdx = currentTrack
    ? queue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
    : -1;
  for (let step = 1; step <= queue.length; step += 1) {
    const candidate = queue[positiveMod(currentIdx + step, queue.length)];
    if (isSongPlayable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function selectPreviousQueueTrack(params: {
  sourceList: readonly Song[];
  currentTrack: Song | null;
  fmMode: boolean;
  fmCursorIndex: number;
}): Song | null {
  const { sourceList, currentTrack, fmMode, fmCursorIndex } = params;
  if (sourceList.length === 0) return null;

  const directIdx = currentTrack
    ? sourceList.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
    : -1;
  const baseIdx =
    directIdx >= 0
      ? directIdx
      : fmMode && fmCursorIndex >= 0
        ? Math.min(fmCursorIndex + 1, sourceList.length)
        : 0;

  for (let step = 1; step <= sourceList.length; step += 1) {
    const candidate = sourceList[positiveMod(baseIdx - step, sourceList.length)];
    if (isSongPlayable(candidate)) {
      return candidate;
    }
  }
  return null;
}
