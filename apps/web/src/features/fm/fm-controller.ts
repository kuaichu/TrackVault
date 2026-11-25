import { type MusicPlatform, type QualityLevel, type Song, getSongKey } from "#shared";
import { isSongPlayable } from "../../entities/song/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

export interface FmPlayTrackOptions {
  queue?: Song[];
  level?: QualityLevel;
  startAtSeconds?: number;
  preservePriorityQueue?: boolean;
  preservePreferredQuality?: boolean;
  naturalAdvance?: boolean;
}

export interface FmStateSnapshot {
  currentTrack: Song | null;
  fmMode: boolean;
  fmQueue: Song[];
  fmLoading: boolean;
  priorityQueue: Song[];
  preferredTrackQuality: QualityLevel | null;
}

export interface FmHost {
  getState(): FmStateSnapshot;
  patchState(patch: {
    fmMode?: boolean;
    fmQueue?: Song[];
    fmLoading?: boolean;
    fmError?: string | null;
    isPlaying?: boolean;
    isLoading?: boolean;
  }): void;
  getPlayToken(): number;
  isAudioActivelyPlaying(): boolean;
  onNoPlayableContinuation(): void;
  playFmTrack(song: Song, options?: FmPlayTrackOptions): Promise<void>;
  playNext(): Promise<void>;
}

/**
 * Cohesive Personal FM batch/cursor controller decoupled from HTMLAudio internals.
 */
export class FmController {
  readonly #host: FmHost;
  #abortController: AbortController | null = null;
  #fetching = false;
  #fetchSource: "page" | "engine" | null = null;
  #autoPlayPending = false;
  #cursorIndex = -1;

  constructor(host: FmHost) {
    this.#host = host;
  }

  isFetching(): boolean {
    return this.#fetching;
  }

  isFetchingAutoPlay(): boolean {
    return this.#fetching && this.#autoPlayPending;
  }

  getCursorIndex(): number {
    return this.#cursorIndex;
  }

  resetCursor(): void {
    this.#cursorIndex = -1;
  }

  updateCursorForTrack(song: Song, explicitQueue?: readonly Song[]): void {
    const songKey = getSongKey(song);
    const { fmQueue } = this.#host.getState();
    const idxInFm = fmQueue.findIndex((item) => getSongKey(item) === songKey);
    if (idxInFm >= 0) {
      this.#cursorIndex = idxInFm;
      return;
    }
    if (explicitQueue) {
      const idxInExplicit = explicitQueue.findIndex((item) => getSongKey(item) === songKey);
      if (idxInExplicit >= 0) {
        this.#cursorIndex = idxInExplicit;
      }
    }
  }

  abortFetch(): void {
    if (this.#abortController) {
      this.#abortController.abort();
      this.#abortController = null;
    }
    this.#fetchSource = null;
    this.#autoPlayPending = false;
    if (this.#fetching) {
      this.#fetching = false;
      this.#host.patchState({ fmLoading: false });
    }
  }

  /**
   * P09: Cancels only manual/preview FM batch requests initiated from PersonalFmPage on unmount,
   * without interrupting active FM playback or engine-driven batch continuations at queue end.
   */
  cancelPageFetch(): void {
    if (this.#fetchSource === "page") {
      this.abortFetch();
    }
  }

  resetPlatformState(platform: MusicPlatform): void {
    const state = this.#host.getState();
    const hasPlatformQueue = state.fmQueue.some((song) => song.platform === platform);
    const currentIsPlatformFm = state.fmMode && state.currentTrack?.platform === platform;

    if (platform === "netease" || hasPlatformQueue || currentIsPlatformFm) {
      this.abortFetch();
      this.#cursorIndex = -1;
      const nextFmQueue = state.fmQueue.filter((song) => song.platform !== platform);
      this.#host.patchState({
        fmQueue: nextFmQueue,
        fmLoading: false,
        fmError: null,
        ...(currentIsPlatformFm ? { fmMode: false } : {}),
      });
    }
  }

  async loadBatch(options?: {
    autoPlay?: boolean;
    source?: "page" | "engine";
    naturalAdvance?: boolean;
  }): Promise<Song[]> {
    const source = options?.source ?? "engine";
    if (this.#fetching) {
      if (options?.autoPlay) {
        this.#autoPlayPending = true;
      }
      if (source === "page" && this.#fetchSource === "page") {
        return this.#host.getState().fmQueue;
      }
      if (source === "engine") {
        // Promote source to engine so page unmount will not abort an engine-required continuation
        this.#fetchSource = "engine";
        return this.#host.getState().fmQueue;
      }
    }

    this.abortFetch();
    const controller = new AbortController();
    this.#abortController = controller;
    this.#fetching = true;
    this.#fetchSource = source;
    this.#autoPlayPending = Boolean(options?.autoPlay);
    const requestToken = this.#host.getPlayToken();

    this.#host.patchState({ fmLoading: true, fmError: null });

    try {
      const res = await api.getPersonalFm(controller.signal);
      if (controller.signal.aborted) {
        return [];
      }
      const shouldAutoPlay = Boolean(options?.autoPlay || this.#autoPlayPending);
      if (shouldAutoPlay && requestToken !== this.#host.getPlayToken()) {
        return [];
      }

      const songs = res.songs ?? [];
      this.#cursorIndex = -1;
      if (this.#abortController === controller) {
        this.#fetching = false;
        this.#fetchSource = null;
        this.#autoPlayPending = false;
      }
      this.#host.patchState({
        fmQueue: songs,
        fmLoading: false,
        fmError: null,
      });

      if (shouldAutoPlay) {
        const first = songs.find((item) => isSongPlayable(item));
        if (first) {
          const preferredLevel = this.#host.getState().preferredTrackQuality ?? undefined;
          await this.#host.playFmTrack(first, {
            queue: songs,
            level: preferredLevel,
            preservePriorityQueue: source === "engine",
            preservePreferredQuality: true,
            naturalAdvance: options?.naturalAdvance,
          });
        } else {
          this.#host.onNoPlayableContinuation();
          if (!this.#host.isAudioActivelyPlaying()) {
            this.#host.patchState({ isPlaying: false, isLoading: false });
          }
          if (songs.length > 0) {
            toast.info("当前队列中的歌曲均不可播放");
          }
        }
      }
      return songs;
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return [];
      }
      this.#host.onNoPlayableContinuation();
      const message = err instanceof Error ? err.message : "加载私人漫游失败";
      this.#host.patchState({
        fmLoading: false,
        fmError: message,
      });
      throw err;
    } finally {
      if (this.#abortController === controller) {
        this.#abortController = null;
        this.#fetching = false;
        this.#fetchSource = null;
        this.#autoPlayPending = false;
        this.#host.patchState({ fmLoading: false });
      }
    }
  }

  async nextTrack(options?: { naturalAdvance?: boolean }): Promise<void> {
    const { fmQueue, currentTrack, fmMode, preferredTrackQuality } = this.#host.getState();
    const directIdx =
      fmMode && currentTrack
        ? fmQueue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
        : -1;
    // P11: Fall back to #cursorIndex when currentTrack was a temporary priorityQueue detour outside fmQueue
    const baseIdx = directIdx >= 0 ? directIdx : fmMode ? this.#cursorIndex : -1;

    for (let idx = baseIdx + 1; idx < fmQueue.length; idx += 1) {
      const candidate = fmQueue[idx];
      if (isSongPlayable(candidate)) {
        this.#cursorIndex = idx;
        await this.#host.playFmTrack(candidate, {
          queue: fmQueue,
          level: preferredTrackQuality ?? undefined,
          preservePriorityQueue: true,
          preservePreferredQuality: true,
          naturalAdvance: options?.naturalAdvance,
        });
        return;
      }
    }

    await this.loadBatch({
      autoPlay: true,
      source: "engine",
      naturalAdvance: options?.naturalAdvance,
    }).catch((err) => {
      const detail = err instanceof Error && err.message ? err.message : "";
      toast.error(detail ? `加载下一批 FM 失败：${detail}` : "加载下一批 FM 失败");
    });
  }

  async skipOrStartNext(): Promise<void> {
    const { fmMode, fmQueue, priorityQueue, preferredTrackQuality } = this.#host.getState();
    if (fmMode || priorityQueue.length > 0) {
      await this.#host.playNext();
      return;
    }
    const nextCandidate = fmQueue.slice(1).find((song) => isSongPlayable(song));
    if (nextCandidate) {
      this.#cursorIndex = fmQueue.indexOf(nextCandidate);
      await this.#host.playFmTrack(nextCandidate, {
        queue: fmQueue,
        level: preferredTrackQuality ?? undefined,
        preservePriorityQueue: true,
        preservePreferredQuality: true,
      });
      return;
    }
    await this.loadBatch({ autoPlay: true, source: "page" });
  }
}
