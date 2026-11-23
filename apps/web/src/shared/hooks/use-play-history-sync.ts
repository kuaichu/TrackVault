import type { QueryClient } from "@tanstack/react-query";
import { type Song, getSongKey } from "#shared";
import { api } from "../api/endpoints.js";

const MAX_PLAY_HISTORY_ITEMS = 100;

interface RecordedPlayHistoryEntry {
  startSeq: number;
  completedSeq: number;
  song?: Song;
  items: Song[];
}

interface PlayHistorySyncState {
  seq: number;
  lastConfirmedClearSeq: number;
  records: RecordedPlayHistoryEntry[];
}

const playHistoryStateByClient = new WeakMap<QueryClient, PlayHistorySyncState>();

function getPlayHistoryState(queryClient: QueryClient): PlayHistorySyncState {
  let state = playHistoryStateByClient.get(queryClient);
  if (!state) {
    state = {
      seq: 0,
      lastConfirmedClearSeq: 0,
      records: [],
    };
    playHistoryStateByClient.set(queryClient, state);
  }
  return state;
}

function mergePlayHistoryLists(newerItems: readonly Song[], olderItems: readonly Song[]): Song[] {
  const seen = new Set<string>();
  const merged: Song[] = [];
  for (const song of newerItems) {
    const key = getSongKey(song);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(song);
    }
  }
  for (const song of olderItems) {
    const key = getSongKey(song);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(song);
    }
  }
  return merged.slice(0, MAX_PLAY_HISTORY_ITEMS);
}

function buildPostClearItems(
  records: readonly RecordedPlayHistoryEntry[],
  fallbackItems: readonly Song[] = [],
): Song[] {
  const orderedNewSongs: Song[] = [];
  for (const record of records) {
    if (record.song) {
      orderedNewSongs.push(record.song);
    } else {
      orderedNewSongs.push(...record.items);
    }
  }
  return mergePlayHistoryLists(orderedNewSongs, fallbackItems);
}

/**
 * F14: Captures a monotonic operation-start sequence BEFORE `POST /api/history/play` is sent,
 * establishing causal ordering relative to concurrent `DELETE` (clear) and `GET` operations.
 */
export function beginPlayHistoryRecord(queryClient: QueryClient): number {
  const state = getPlayHistoryState(queryClient);
  return ++state.seq;
}

/**
 * F14: Captures a monotonic operation-start sequence BEFORE `DELETE /api/history/play` is sent,
 * so older in-flight `POST` responses cannot resurrect cleared history and late `DELETE` acknowledgements
 * cannot wipe `POST` records initiated after the clear.
 */
export function beginPlayHistoryClear(queryClient: QueryClient): number {
  const state = getPlayHistoryState(queryClient);
  return ++state.seq;
}

/**
 * F14: Applies a completed `POST /api/history/play` response ordered by its initiation sequence.
 */
export function applyRecordedPlayHistory(
  queryClient: QueryClient,
  res: { items: Song[] },
  startSeq?: number,
  playedSong?: Song,
): void {
  const state = getPlayHistoryState(queryClient);
  const effectiveStartSeq = startSeq ?? ++state.seq;
  const completedSeq = ++state.seq;

  // Never allow a POST initiated before a confirmed clear to resurrect pre-clear items
  if (effectiveStartSeq <= state.lastConfirmedClearSeq) {
    return;
  }

  const inferredSong = playedSong ?? res.items[0];
  state.records.push({
    startSeq: effectiveStartSeq,
    completedSeq,
    song: inferredSong,
    items: [...res.items],
  });
  state.records.sort((a, b) => b.startSeq - a.startSeq);
  if (state.records.length > MAX_PLAY_HISTORY_ITEMS) {
    state.records.length = MAX_PLAY_HISTORY_ITEMS;
  }

  const latestRecord = state.records[0];
  if (state.lastConfirmedClearSeq > 0) {
    // Only include songs recorded strictly after the confirmed clear
    const nextItems = buildPostClearItems(state.records);
    queryClient.setQueryData<{ items: Song[] }>(["play-history"], { items: nextItems });
    return;
  }

  const newerSongs = state.records.flatMap((r) => (r.song ? [r.song] : r.items));
  const baseItems = latestRecord ? latestRecord.items : res.items;
  queryClient.setQueryData<{ items: Song[] }>(["play-history"], {
    items: mergePlayHistoryLists(newerSongs, baseItems),
  });
}

/**
 * F14: Applies a completed `DELETE /api/history/play` clear generation while preserving any `POST`
 * records initiated strictly after `clearStartSeq`.
 */
export function applyClearedPlayHistory(
  queryClient: QueryClient,
  res: { items: Song[] },
  clearStartSeq?: number,
): void {
  const state = getPlayHistoryState(queryClient);
  const effectiveClearSeq = clearStartSeq ?? ++state.seq;
  state.lastConfirmedClearSeq = Math.max(state.lastConfirmedClearSeq, effectiveClearSeq);
  state.records = state.records.filter((r) => r.startSeq > state.lastConfirmedClearSeq);

  const survivingItems = buildPostClearItems(state.records, res.items);
  queryClient.setQueryData<{ items: Song[] }>(["play-history"], { items: survivingItems });
}

/**
 * F14: Sequence-aware `GET /api/history/play` fetcher for `HistoryPage`.
 */
export async function fetchSyncedPlayHistory(queryClient: QueryClient): Promise<{ items: Song[] }> {
  const state = getPlayHistoryState(queryClient);
  const startSeq = ++state.seq;
  const res = await api.getPlayHistory();

  if (state.lastConfirmedClearSeq > startSeq) {
    return { items: buildPostClearItems(state.records) };
  }

  const newerRecords = state.records.filter(
    (r) => r.startSeq > state.lastConfirmedClearSeq && (r.startSeq > startSeq || r.completedSeq > startSeq),
  );
  if (newerRecords.length > 0) {
    const newerItems = newerRecords.flatMap((r) => (r.song ? [r.song, ...r.items] : r.items));
    return { items: mergePlayHistoryLists(newerItems, res.items) };
  }

  return res;
}
