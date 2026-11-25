import type { QueryClient } from "@tanstack/react-query";
import { type Song, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";

const MAX_PLAY_HISTORY_ITEMS = 100;

export interface PlayHistoryPayload {
  items: Song[];
  revision?: number;
}

interface PlayHistorySyncState {
  seq: number;
  highestRevision: number;
  lastClearedSeq: number;
  lastClearedEndSeq: number;
  lastPostSeq: number;
  inFlightClears: Set<number>;
  postClearSongs: Map<number, Song>;
  items: Song[];
}

const playHistoryStateByClient = new WeakMap<QueryClient, PlayHistorySyncState>();

function getPlayHistoryState(queryClient: QueryClient): PlayHistorySyncState {
  let state = playHistoryStateByClient.get(queryClient);
  if (!state) {
    state = {
      seq: 0,
      highestRevision: 0,
      lastClearedSeq: 0,
      lastClearedEndSeq: 0,
      lastPostSeq: 0,
      inFlightClears: new Set(),
      postClearSongs: new Map(),
      items: [],
    };
    playHistoryStateByClient.set(queryClient, state);
  }
  return state;
}

function mergeUniqueSongs(newerItems: readonly Song[], olderItems: readonly Song[]): Song[] {
  const seen = new Set<string>();
  const merged: Song[] = [];
  for (const list of [newerItems, olderItems]) {
    for (const song of list) {
      const key = getSongKey(song);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(song);
        if (merged.length >= MAX_PLAY_HISTORY_ITEMS) return merged;
      }
    }
  }
  return merged;
}

export function beginPlayHistoryRecord(queryClient: QueryClient): number {
  return ++getPlayHistoryState(queryClient).seq;
}

export function beginPlayHistoryClear(queryClient: QueryClient): number {
  const state = getPlayHistoryState(queryClient);
  const clearSeq = ++state.seq;
  state.inFlightClears.add(clearSeq);
  return clearSeq;
}

export function abortPlayHistoryClear(queryClient: QueryClient, clearStartSeq?: number): void {
  const state = getPlayHistoryState(queryClient);
  if (clearStartSeq !== undefined) {
    state.inFlightClears.delete(clearStartSeq);
  } else {
    state.inFlightClears.clear();
  }
  if (state.items.length > 0) {
    queryClient.setQueryData<PlayHistoryPayload>(["play-history"], {
      items: state.items,
      ...(state.highestRevision > 0 ? { revision: state.highestRevision } : {}),
    });
  }
}

export function applyRecordedPlayHistory(
  queryClient: QueryClient,
  res: PlayHistoryPayload,
  startSeq?: number,
  playedSong?: Song,
): void {
  const state = getPlayHistoryState(queryClient);
  const effectiveSeq = startSeq ?? ++state.seq;

  if (res.revision !== undefined) {
    if (res.revision < state.highestRevision) return;
    state.highestRevision = res.revision;
    state.items = res.items.slice(0, MAX_PLAY_HISTORY_ITEMS);
    queryClient.setQueryData<PlayHistoryPayload>(["play-history"], {
      items: state.items,
      revision: state.highestRevision,
    });
    return;
  }

  if (effectiveSeq <= state.lastClearedSeq) return;
  state.lastPostSeq = Math.max(state.lastPostSeq, ++state.seq);
  const song = playedSong ?? res.items[0];
  if (song) {
    state.postClearSongs.set(effectiveSeq, song);
    if (state.postClearSongs.size > MAX_PLAY_HISTORY_ITEMS) {
      const oldest = state.postClearSongs.keys().next().value;
      if (oldest !== undefined) state.postClearSongs.delete(oldest);
    }
  }
  state.items = mergeUniqueSongs(res.items, state.items);
  queryClient.setQueryData<PlayHistoryPayload>(["play-history"], { items: state.items });
}

export function applyClearedPlayHistory(
  queryClient: QueryClient,
  res: PlayHistoryPayload,
  clearStartSeq?: number,
): void {
  const state = getPlayHistoryState(queryClient);
  const effectiveClearSeq = clearStartSeq ?? ++state.seq;

  if (clearStartSeq !== undefined) {
    state.inFlightClears.delete(clearStartSeq);
  } else {
    state.inFlightClears.clear();
  }

  if (res.revision !== undefined) {
    if (res.revision < state.highestRevision) return;
    state.highestRevision = res.revision;
    state.lastClearedSeq = Math.max(state.lastClearedSeq, effectiveClearSeq);
    state.lastClearedEndSeq = Math.max(state.lastClearedEndSeq, ++state.seq);
    state.items = res.items.slice(0, MAX_PLAY_HISTORY_ITEMS);
    queryClient.setQueryData<PlayHistoryPayload>(["play-history"], {
      items: state.items,
      revision: state.highestRevision,
    });
    return;
  }

  state.lastClearedSeq = Math.max(state.lastClearedSeq, effectiveClearSeq);
  state.lastClearedEndSeq = Math.max(state.lastClearedEndSeq, ++state.seq);
  const surviving: Song[] = [];
  for (const [recSeq, song] of [...state.postClearSongs].sort((a, b) => b[0] - a[0])) {
    if (recSeq > state.lastClearedSeq) {
      surviving.push(song);
    } else {
      state.postClearSongs.delete(recSeq);
    }
  }
  state.items = mergeUniqueSongs(surviving, res.items);
  queryClient.setQueryData<PlayHistoryPayload>(["play-history"], { items: state.items });
}

export async function fetchSyncedPlayHistory(queryClient: QueryClient): Promise<PlayHistoryPayload> {
  const state = getPlayHistoryState(queryClient);
  const startSeq = ++state.seq;
  const res = await api.getPlayHistory();

  if (res.revision !== undefined) {
    if (res.revision < state.highestRevision) {
      return { items: state.items, revision: state.highestRevision };
    }
    state.highestRevision = res.revision;
    state.items = res.items.slice(0, MAX_PLAY_HISTORY_ITEMS);
    return { items: state.items, revision: state.highestRevision };
  }

  if (startSeq <= state.lastClearedEndSeq || state.inFlightClears.size > 0) {
    return { items: state.items };
  }
  if (state.lastPostSeq > startSeq) {
    state.items = mergeUniqueSongs(state.items, res.items);
    return { items: state.items };
  }
  state.items = res.items.slice(0, MAX_PLAY_HISTORY_ITEMS);
  return { items: state.items };
}
