import { type PlayerState, type Song, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";

const REMOTE_SYNC_INTERVAL_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 400;
const MAX_PERSISTED_QUEUE_LENGTH = 200;
/** Keep well below the browser's 64 KiB shared hard limit for fetch(..., { keepalive: true }). */
export const KEEPALIVE_MAX_BYTES = 58 * 1024;

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return new Blob([text]).size;
}

/**
 * Serializes a bounded window (at most `maxItems`) of `queue` centered around `currentTrack`
 * so the active track and its surrounding neighbors are always preserved even past index 200.
 */
export function serializeQueueWindow(
  queue: readonly Song[],
  currentTrack: Song | null,
  maxItems = MAX_PERSISTED_QUEUE_LENGTH,
): Song[] {
  if (maxItems <= 0 || queue.length === 0) return [];
  if (queue.length <= maxItems) return [...queue];

  const currentIdx = currentTrack
    ? queue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
    : -1;
  if (currentIdx < 0) {
    return queue.slice(0, maxItems);
  }

  const half = Math.floor(maxItems / 2);
  const start = Math.max(0, Math.min(currentIdx - half, queue.length - maxItems));
  return queue.slice(start, start + maxItems);
}

/**
 * Ensures a `pagehide` keepalive payload fits safely under the browser's 64 KiB keepalive cap
 * by progressively shrinking the centered queue window until serialized UTF-8 bytes <= `maxBytes`.
 */
export function buildBoundedKeepalivePlayerState(
  state: PlayerState,
  maxBytes = KEEPALIVE_MAX_BYTES,
): PlayerState {
  const fullJson = JSON.stringify(state);
  if (utf8ByteLength(fullJson) <= maxBytes) {
    return state;
  }

  let lo = 0;
  let hi = state.playQueue.length - 1;
  let best: PlayerState | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate: PlayerState = {
      ...state,
      playQueue: mid === 0 ? [] : serializeQueueWindow(state.playQueue, state.currentTrack, mid),
    };
    if (utf8ByteLength(JSON.stringify(candidate)) <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best ?? { ...state, playQueue: [] };
}

/**
 * Coordinates debounced, periodic, and `pagehide` keepalive persistence for `PlayerState`.
 */
export class PlayerPersistenceManager {
  #lastPersistAt = 0;
  #persistDebounceId: ReturnType<typeof setTimeout> | null = null;
  #pagehideHandler: (() => void) | null = null;

  bindPagehide(): void {
    if (this.#pagehideHandler || typeof window === "undefined") return;
    this.#pagehideHandler = () => this.persistNow({ keepalive: true });
    window.addEventListener("pagehide", this.#pagehideHandler);
  }

  unbindPagehide(): void {
    if (this.#pagehideHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.#pagehideHandler);
      this.#pagehideHandler = null;
    }
  }

  clearDebounce(): void {
    if (this.#persistDebounceId !== null) {
      globalThis.clearTimeout(this.#persistDebounceId);
      this.#persistDebounceId = null;
    }
  }

  reset(): void {
    this.clearDebounce();
    this.#lastPersistAt = 0;
  }

  shouldPeriodicSync(): boolean {
    return Date.now() - this.#lastPersistAt >= REMOTE_SYNC_INTERVAL_MS;
  }

  buildPayload(keepalive = false): PlayerState {
    const state = usePlayerStore.getState();
    const { currentTime } = usePlaybackClockStore.getState();
    const base: PlayerState = {
      currentTrack: state.currentTrack,
      playQueue: serializeQueueWindow(state.queue, state.currentTrack, MAX_PERSISTED_QUEUE_LENGTH),
      playbackSeconds: Math.floor(currentTime),
      volume: state.muted ? 0 : state.volume,
      muted: state.muted,
      lastNonZeroVolume: state.lastNonZeroVolume,
      playbackMode: state.playbackMode,
    };
    return keepalive ? buildBoundedKeepalivePlayerState(base) : base;
  }

  persistNow(options?: { keepalive?: boolean }): void {
    this.clearDebounce();
    if (!usePlayerStore.getState().hydrated) return;
    this.#lastPersistAt = Date.now();
    const payload = this.buildPayload(Boolean(options?.keepalive));
    void api
      .savePlayerState(payload, options?.keepalive ? { keepalive: true } : undefined)
      .catch(() => undefined);
  }

  schedulePersist(delayMs = PERSIST_DEBOUNCE_MS): void {
    if (!usePlayerStore.getState().hydrated) return;
    this.clearDebounce();
    this.#persistDebounceId = globalThis.setTimeout(() => {
      this.#persistDebounceId = null;
      this.persistNow();
    }, delayMs);
  }
}
