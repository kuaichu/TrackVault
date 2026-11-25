import { type MusicPlatform, type PersonalFmMode, type QualityLevel, type Song, getSongKey } from "#shared";
import { isSongPlayable } from "../../entities/song/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

const MAX_FM_RECENT_TRACKS = 12;

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
  fmSubMode: PersonalFmMode;
  fmQueue: Song[];
  fmRecentTracks: Song[];
  fmLoading: boolean;
  priorityQueue: Song[];
  preferredTrackQuality: QualityLevel | null;
}

export interface FmHost {
  getState(): FmStateSnapshot;
  patchState(patch: {
    fmMode?: boolean;
    fmSubMode?: PersonalFmMode;
    fmQueue?: Song[];
    fmRecentTracks?: Song[];
    fmLoading?: boolean;
    fmError?: string | null;
    isPlaying?: boolean;
    isLoading?: boolean;
  }): void;
  getPlayToken(): number;
  isAudioActivelyPlaying(): boolean;
  onNoPlayableContinuation(): void;
  syncActiveFmQueue?(queue: Song[]): void;
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
    const hasPlatformRecent = state.fmRecentTracks.some((song) => song.platform === platform);
    const currentIsPlatformFm = state.fmMode && state.currentTrack?.platform === platform;

    if (platform === "netease" || hasPlatformQueue || hasPlatformRecent || currentIsPlatformFm) {
      this.abortFetch();
      this.#cursorIndex = -1;
      const nextFmQueue = state.fmQueue.filter((song) => song.platform !== platform);
      const nextRecent = state.fmRecentTracks.filter((song) => song.platform !== platform);
      this.#host.patchState({
        fmQueue: nextFmQueue,
        fmRecentTracks: nextRecent,
        fmLoading: false,
        fmError: null,
        ...(currentIsPlatformFm ? { fmMode: false } : {}),
      });
    }
  }

  recordPassedTrack(prevSong: Song, nextSong?: Song | null): void {
    const prevKey = getSongKey(prevSong);
    const nextKey = nextSong ? getSongKey(nextSong) : null;
    if (nextKey && prevKey === nextKey) return;
    const { fmRecentTracks } = this.#host.getState();
    const filtered = fmRecentTracks.filter((item) => {
      const k = getSongKey(item);
      return k !== prevKey && k !== nextKey;
    });
    this.#host.patchState({
      fmRecentTracks: [prevSong, ...filtered].slice(0, MAX_FM_RECENT_TRACKS),
    });
  }

  async loadBatch(options?: {
    autoPlay?: boolean;
    source?: "page" | "engine";
    naturalAdvance?: boolean;
    mode?: PersonalFmMode;
    append?: boolean;
  }): Promise<Song[]> {
    const source = options?.source ?? "engine";
    const isModeSwitch = options?.mode !== undefined && options.mode !== this.#host.getState().fmSubMode;

    if (this.#fetching && !isModeSwitch && !options?.append) {
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

    const effectiveMode = options?.mode ?? this.#host.getState().fmSubMode;
    this.#host.patchState({
      fmLoading: true,
      fmError: null,
      ...(options?.mode ? { fmSubMode: options.mode } : {}),
    });

    try {
      const res =
        effectiveMode === "DEFAULT"
          ? await api.getPersonalFm(controller.signal)
          : await api.getPersonalFm(controller.signal, effectiveMode);
      if (controller.signal.aborted) {
        return [];
      }
      const shouldAutoPlay = Boolean(options?.autoPlay || this.#autoPlayPending);
      if (shouldAutoPlay && requestToken !== this.#host.getPlayToken()) {
        return [];
      }

      const incoming = res.songs ?? [];
      const preApplyState = this.#host.getState();

      let nextQueue = incoming;
      if (options?.append && preApplyState.fmQueue.length > 0) {
        const seen = new Set(preApplyState.fmQueue.map((item) => getSongKey(item)));
        const fresh = incoming.filter((item) => !seen.has(getSongKey(item)));
        nextQueue = [...preApplyState.fmQueue, ...fresh];
      } else {
        if (preApplyState.fmMode && preApplyState.currentTrack) {
          this.recordPassedTrack(preApplyState.currentTrack, incoming[0] ?? null);
        }
        this.#cursorIndex = -1;
      }

      if (this.#abortController === controller) {
        this.#fetching = false;
        this.#fetchSource = null;
        this.#autoPlayPending = false;
      }
      this.#host.patchState({
        fmQueue: nextQueue,
        fmLoading: false,
        fmError: null,
      });

      if (options?.append && preApplyState.fmMode) {
        this.#host.syncActiveFmQueue?.(nextQueue);
      }

      if (shouldAutoPlay && !options?.append) {
        const first = incoming.find((item) => isSongPlayable(item));
        if (first) {
          const preferredLevel = this.#host.getState().preferredTrackQuality ?? undefined;
          await this.#host.playFmTrack(first, {
            queue: nextQueue,
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
          if (incoming.length > 0) {
            toast.info("当前队列中的歌曲均不可播放");
          }
        }
      }
      return nextQueue;
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

  async trashSong(song: Song): Promise<void> {
    const targetKey = getSongKey(song);
    const state = this.#host.getState();
    const prevIdx = state.fmQueue.findIndex((item) => getSongKey(item) === targetKey);
    const remainingQueue = state.fmQueue.filter((item) => getSongKey(item) !== targetKey);
    const remainingRecent = state.fmRecentTracks.filter((item) => getSongKey(item) !== targetKey);

    const wasCurrentFm = Boolean(
      state.fmMode && state.currentTrack && getSongKey(state.currentTrack) === targetKey,
    );

    if (prevIdx >= 0 && this.#cursorIndex >= prevIdx) {
      this.#cursorIndex = Math.max(-1, this.#cursorIndex - 1);
    }

    this.#host.patchState({
      fmQueue: remainingQueue,
      fmRecentTracks: remainingRecent,
    });
    if (state.fmMode) {
      this.#host.syncActiveFmQueue?.(remainingQueue);
    }

    const trashPromise = api
      .trashPersonalFm(song.id)
      .then(() => {
        toast.info(`已减少推荐「${song.title}」`);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "标记不喜欢失败");
      });

    if (wasCurrentFm) {
      const startScan = prevIdx >= 0 ? prevIdx : 0;
      const nextCandidate =
        remainingQueue.slice(startScan).find((item) => isSongPlayable(item)) ??
        remainingQueue.find((item) => isSongPlayable(item));

      if (nextCandidate) {
        this.#cursorIndex = remainingQueue.indexOf(nextCandidate);
        await this.#host.playFmTrack(nextCandidate, {
          queue: remainingQueue,
          level: state.preferredTrackQuality ?? undefined,
          preservePriorityQueue: true,
          preservePreferredQuality: true,
        });
      } else {
        await this.loadBatch({ autoPlay: true, source: "page" }).catch(() => undefined);
      }
    } else if (remainingQueue.length === 0) {
      await this.loadBatch({ autoPlay: false, source: "page" }).catch(() => undefined);
    }

    await trashPromise;
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
