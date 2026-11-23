import type { QueryClient } from "@tanstack/react-query";
import { type Song, getSongKey } from "#shared";
import { api } from "../api/endpoints.js";

const MAX_PLAY_HISTORY_ITEMS = 100;

interface PlayHistorySyncState {
  seq: number;
  lastRecordedSeq: number;
  lastClearedSeq: number;
  latestRecordedItems: Song[];
  postClearItems: Song[];
}

const playHistoryStateByClient = new WeakMap<QueryClient, PlayHistorySyncState>();

function getPlayHistoryState(queryClient: QueryClient): PlayHistorySyncState {
  let state = playHistoryStateByClient.get(queryClient);
  if (!state) {
    state = {
      seq: 0,
      lastRecordedSeq: 0,
      lastClearedSeq: 0,
      latestRecordedItems: [],
      postClearItems: [],
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

/**
 * F14: Records a completed `POST /api/history/play` response with a monotonic sequence number
 * so an older in-flight `GET /api/history/play` resolving late can never overwrite newly played tracks.
 */
export function applyRecordedPlayHistory(queryClient: QueryClient, res: { items: Song[] }): void {
  const state = getPlayHistoryState(queryClient);
  const seq = ++state.seq;
  state.lastRecordedSeq = seq;
  state.latestRecordedItems = [...res.items];
  if (state.lastClearedSeq > 0) {
    state.postClearItems = [...res.items];
  }
  queryClient.setQueryData<{ items: Song[] }>(["play-history"], res);
}

/**
 * F14: Records a completed `DELETE /api/history/play` clear generation so an older in-flight GET
 * cannot resurrect cleared history items.
 */
export function applyClearedPlayHistory(queryClient: QueryClient, res: { items: Song[] }): void {
  const state = getPlayHistoryState(queryClient);
  const seq = ++state.seq;
  state.lastClearedSeq = seq;
  state.lastRecordedSeq = 0;
  state.latestRecordedItems = [];
  state.postClearItems = [...res.items];
  queryClient.setQueryData<{ items: Song[] }>(["play-history"], res);
}

/**
 * F14: Sequence-aware `GET /api/history/play` fetcher for `HistoryPage`.
 */
export async function fetchSyncedPlayHistory(queryClient: QueryClient): Promise<{ items: Song[] }> {
  const state = getPlayHistoryState(queryClient);
  const startSeq = ++state.seq;
  const res = await api.getPlayHistory();

  if (state.lastClearedSeq > startSeq) {
    return { items: [...state.postClearItems] };
  }

  if (state.lastRecordedSeq > startSeq) {
    return { items: mergePlayHistoryLists(state.latestRecordedItems, res.items) };
  }

  return res;
}
