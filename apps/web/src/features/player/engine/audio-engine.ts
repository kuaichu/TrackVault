import {
  type MusicPlatform,
  type PersonalFmMode,
  type PlaybackMode,
  type PreferenceQualityLevel,
  type QualityLevel,
  type Song,
  getSongKey,
} from "#shared";
import { isSongPlayable } from "../../../entities/song/index.js";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { FmController } from "../../fm/index.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";
import { type CloudPlayAllParams, executeCloudPlayAll } from "./cloud-play-all.js";
import { HtmlAudioDriver, probeStreamErrorDetail } from "./html-audio-driver.js";
import {
  KEEPALIVE_MAX_BYTES,
  PlayerPersistenceManager,
  buildBoundedKeepalivePlayerState,
  serializeQueueWindow,
} from "./player-persistence.js";
import {
  addSongToQueue,
  computeQueuesOnPlay,
  cyclePlaybackModeValue,
  dequeueNextPriorityTrack,
  insertSongNextInQueue,
  removeSongFromQueues,
  resolveEffectivePlaybackQuality,
  selectNextQueueTrack,
  selectPreviousQueueTrack,
} from "./queue-scheduler.js";

const FADE_DURATION_MS = 220;
const PAUSE_FADE_DURATION_MS = 140;

export {
  KEEPALIVE_MAX_BYTES,
  buildBoundedKeepalivePlayerState,
  resolveEffectivePlaybackQuality,
  serializeQueueWindow,
};

export interface PlaybackSessionSnapshot {
  playbackSessionId: number;
  playToken: number;
}

/**
 * Facade coordinator orchestrating HtmlAudioDriver, pure queue-scheduler,
 * PlayerPersistenceManager, and FmController without React component coupling.
 */
export class AudioEngine {
  readonly #driver: HtmlAudioDriver;
  readonly #persistence = new PlayerPersistenceManager();
  readonly #fm: FmController;

  #sessionEpoch = 0;
  #playToken = 0;
  #playbackSessionId = 0;
  #cloudPlayAllRunId = 0;
  #playIntent = false;
  #volumeRevision = 0;
  #pendingPause = false;
  #pendingSeek: number | null = null;
  #trackEndedAwaitingNext = false;

  #onPlayHistoryRecordStart: ((song: Song) => number) | null = null;
  #onPlayHistoryRecorded:
    | ((res: { items: Song[]; revision?: number }, meta?: { startSeq?: number; song: Song }) => void)
    | null = null;
  #historyRequestSeq = 0;
  #latestAppliedHistorySeq = 0;
  #pendingHistorySong: { token: number; song: Song } | null = null;
  #recordedHistoryForCurrentPlay = false;

  constructor(audioElement?: HTMLAudioElement) {
    this.#driver = new HtmlAudioDriver(audioElement);
    this.#fm = new FmController({
      getState: () => {
        const s = usePlayerStore.getState();
        return {
          currentTrack: s.currentTrack,
          fmMode: s.fmMode,
          fmSubMode: s.fmSubMode,
          fmQueue: s.fmQueue,
          fmRecentTracks: s.fmRecentTracks,
          fmLoading: s.fmLoading,
          priorityQueue: s.priorityQueue,
          preferredTrackQuality: s.preferredTrackQuality,
        };
      },
      patchState: (patch) => usePlayerStore.getState().setStatePatch(patch),
      getPlayToken: () => this.#playToken,
      isAudioActivelyPlaying: () => !this.#driver.paused && !this.#pendingPause,
      onNoPlayableContinuation: () => {
        this.#trackEndedAwaitingNext = false;
        if (this.#driver.paused || this.#pendingPause) {
          this.#playIntent = false;
        }
      },
      syncActiveFmQueue: (queue) => this.replaceQueueSilently(queue),
      playFmTrack: (song, opts) => this.playFmTrack(song, opts),
      playNext: () => this.playNext(),
    });

    this.#bindDriverEvents();
    this.#persistence.bindPagehide();
  }

  setPlayHistoryListener(
    listener:
      | ((res: { items: Song[]; revision?: number }, meta?: { startSeq?: number; song: Song }) => void)
      | null,
    onStart?: ((song: Song) => number) | null,
  ): void {
    this.#onPlayHistoryRecorded = listener;
    this.#onPlayHistoryRecordStart = listener ? (onStart ?? null) : null;
  }

  getPlaybackSessionSnapshot(): PlaybackSessionSnapshot {
    return {
      playbackSessionId: this.#playbackSessionId,
      playToken: this.#playToken,
    };
  }

  replaceQueueSilently(queue: Song[]): void {
    usePlayerStore.getState().setStatePatch({ queue });
    this.#persistence.schedulePersist();
  }

  dispose(): void {
    this.#driver.cancelFade();
    this.#persistence.clearDebounce();
    this.#persistence.unbindPagehide();
    this.#fm.abortFetch();
  }

  #bindDriverEvents(): void {
    this.#driver.bindEvents({
      onLoadedMetadata: (duration) => {
        usePlaybackClockStore.getState().setClock({ duration });
        if (this.#pendingSeek !== null && duration > 0) {
          const clamped = Math.min(duration, Math.max(0, this.#pendingSeek));
          this.#driver.setCurrentTime(clamped);
          usePlaybackClockStore.getState().setClock({ currentTime: clamped });
          this.#pendingSeek = null;
        }
      },
      onTimeUpdate: (currentTime, rawDuration, bufferedTime) => {
        const duration = rawDuration ?? usePlayerStore.getState().currentTrack?.durationSeconds ?? 0;
        usePlaybackClockStore.getState().setClock({ currentTime, duration, bufferedTime });
        if (this.#persistence.shouldPeriodicSync()) {
          this.#persistence.persistNow();
        }
      },
      onPlaying: () => {
        if (this.#pendingPause) return;
        usePlayerStore.getState().setStatePatch({ isPlaying: true, isLoading: false, playerError: null });
        this.#recordPlayHistoryIfPending();
      },
      onPause: () => {
        this.#pendingPause = false;
        const state = usePlayerStore.getState();
        state.setStatePatch({ isPlaying: false, isLoading: false });
        if (state.hydrated && state.currentTrack) {
          this.#persistence.persistNow();
        }
      },
      onWaiting: () => {
        if (!this.#driver.paused && !this.#pendingPause) {
          usePlayerStore.getState().setStatePatch({ isLoading: true });
        }
      },
      onEnded: () => {
        const { playbackMode, currentTrack, fmMode } = usePlayerStore.getState();
        if (playbackMode === "repeat-one" && currentTrack && !fmMode) {
          this.#trackEndedAwaitingNext = false;
          this.#driver.setCurrentTime(0);
          usePlaybackClockStore.getState().setClock({ currentTime: 0 });
          void this.#startAudioWithFade(this.#playToken);
          return;
        }
        this.#playIntent = false;
        this.#trackEndedAwaitingNext = true;
        usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: false });
        void this.playNext({ naturalAdvance: true });
      },
      onError: (failedSrc) => {
        if (!usePlayerStore.getState().currentTrack) return;
        this.#playIntent = false;
        const errorToken = this.#playToken;
        usePlayerStore.getState().setStatePatch({
          isPlaying: false,
          isLoading: false,
          playerError: "音频加载失败，请检查平台账号绑定、会员权限或切换其他音质。",
        });
        if (failedSrc) {
          void probeStreamErrorDetail(failedSrc).then((detail) => {
            if (detail && errorToken === this.#playToken) {
              usePlayerStore.getState().setStatePatch({ playerError: detail });
            }
          });
        }
      },
    });
  }

  #recordPlayHistoryIfPending(): void {
    const pending = this.#pendingHistorySong;
    if (!pending || pending.token !== this.#playToken || this.#recordedHistoryForCurrentPlay) {
      return;
    }
    this.#recordedHistoryForCurrentPlay = true;
    this.#pendingHistorySong = null;

    const recordEpoch = this.#sessionEpoch;
    const reqSeq = ++this.#historyRequestSeq;
    const startSeq = this.#onPlayHistoryRecordStart?.(pending.song);
    void api
      .recordPlayHistory(pending.song)
      .then((res) => {
        if (recordEpoch !== this.#sessionEpoch) return;
        if (startSeq !== undefined) {
          this.#latestAppliedHistorySeq = Math.max(this.#latestAppliedHistorySeq, reqSeq);
          this.#onPlayHistoryRecorded?.(res, { startSeq, song: pending.song });
        } else if (reqSeq >= this.#latestAppliedHistorySeq) {
          this.#latestAppliedHistorySeq = reqSeq;
          this.#onPlayHistoryRecorded?.(res);
        }
      })
      .catch(() => undefined);
  }

  #completePendingPause(): void {
    if (!this.#pendingPause) return;
    this.#pendingPause = false;
    this.#driver.pause();
    const { volume, muted } = usePlayerStore.getState();
    const effectiveVolume = muted ? 0 : volume;
    this.#driver.setVolumeAndMute(effectiveVolume, muted || effectiveVolume === 0);
  }

  async #startAudioWithFade(
    token: number,
    options?: { fromVolume?: number; fallbackError?: string },
  ): Promise<void> {
    const startRevision = this.#volumeRevision;
    const initialState = usePlayerStore.getState();
    const initialTarget = initialState.muted ? 0 : initialState.volume;
    const fromVolume = Math.min(initialTarget, Math.max(0, options?.fromVolume ?? 0));
    this.#driver.setVolumeAndMute(fromVolume, initialState.muted || initialTarget === 0);

    try {
      await this.#driver.play();
      if (token !== this.#playToken || this.#pendingPause) return;

      const latestState = usePlayerStore.getState();
      const latestTarget = latestState.muted ? 0 : latestState.volume;
      const effectiveMute = latestState.muted || latestTarget === 0;
      const activeVolRev = this.#volumeRevision;

      if (startRevision !== activeVolRev || latestTarget === 0) {
        this.#driver.setVolumeAndMute(latestTarget, effectiveMute);
      } else {
        this.#driver.setVolumeAndMute(fromVolume, effectiveMute);
        this.#driver.animateVolume({
          from: fromVolume,
          to: latestTarget,
          durationMs: FADE_DURATION_MS,
          isStillValid: () => token === this.#playToken && activeVolRev === this.#volumeRevision,
        });
      }

      if (!this.#driver.paused && !this.#pendingPause && !usePlayerStore.getState().isPlaying) {
        usePlayerStore.getState().setStatePatch({ isPlaying: true, isLoading: false, playerError: null });
      }
    } catch {
      if (token !== this.#playToken || this.#pendingPause) return;
      this.#playIntent = false;
      const latestState = usePlayerStore.getState();
      const latestTarget = latestState.muted ? 0 : latestState.volume;
      this.#driver.setVolumeAndMute(latestTarget, latestState.muted || latestTarget === 0);

      const preservedError =
        latestState.playerError ??
        options?.fallbackError ??
        "浏览器阻止了自动播放或音频流暂不可用，请点击播放重试。";
      usePlayerStore.getState().setStatePatch({
        isPlaying: false,
        isLoading: false,
        playerError: preservedError,
      });
    }
  }

  #syncMediaSession(song: Song): void {
    this.#driver.updateMediaSession(song, {
      onPlay: () => void this.togglePlay(),
      onPause: () => void this.togglePlay(),
      onPrevious: () => void this.playPrevious(),
      onNext: () => void this.playNext(),
    });
  }

  cancelPendingFmFetch(): void {
    this.#fm.abortFetch();
  }

  cancelPageFmFetch(): void {
    this.#fm.cancelPageFetch();
  }

  resetPlatformFmState(platform: MusicPlatform): void {
    this.#fm.resetPlatformState(platform);
  }

  syncDefaultPlaybackQuality(level: PreferenceQualityLevel): void {
    const state = usePlayerStore.getState();
    state.setStatePatch({ defaultPlaybackQuality: level });

    if (
      state.currentTrack &&
      !state.preferredTrackQuality &&
      this.#driver.paused &&
      !state.isPlaying &&
      !this.#pendingPause
    ) {
      const nextUrl = api.buildStreamUrl(state.currentTrack, level);
      const currentSrc = this.#driver.currentSrcOrAttr;
      if (currentSrc !== nextUrl && !currentSrc.endsWith(nextUrl)) {
        const resumeAt = usePlaybackClockStore.getState().currentTime;
        if (resumeAt > 0 && this.#pendingSeek === null) {
          this.#pendingSeek = resumeAt;
        }
        this.#driver.setSrc(nextUrl);
      }
      state.setStatePatch({ loadedStreamQuality: level });
    }
  }

  hydrate(input: {
    currentTrack: Song | null;
    playQueue: Song[];
    playbackSeconds: number;
    volume: number;
    muted?: boolean;
    lastNonZeroVolume?: number;
    playbackMode: PlaybackMode;
  }): void {
    const store = usePlayerStore.getState();
    if (store.currentTrack) {
      store.setStatePatch({ hydrated: true });
      return;
    }

    const clampedVolume = Math.min(1, Math.max(0, Number.isFinite(input.volume) ? input.volume : 0.85));
    const isMuted =
      typeof input.muted === "boolean" ? input.muted || clampedVolume === 0 : clampedVolume === 0;
    const effectiveVolume = isMuted ? 0 : clampedVolume;
    const restoredLastNonZero =
      typeof input.lastNonZeroVolume === "number" &&
      Number.isFinite(input.lastNonZeroVolume) &&
      input.lastNonZeroVolume > 0
        ? Math.min(1, input.lastNonZeroVolume)
        : clampedVolume > 0
          ? clampedVolume
          : 0.8;

    this.#playbackSessionId += 1;
    this.#playIntent = false;
    this.#trackEndedAwaitingNext = false;
    this.#fm.resetCursor();
    this.#driver.setVolumeAndMute(effectiveVolume, isMuted);
    this.#pendingSeek = input.playbackSeconds > 0 ? input.playbackSeconds : null;
    this.#pendingHistorySong = null;
    this.#recordedHistoryForCurrentPlay = false;

    const hydratedLevel = input.currentTrack
      ? (store.preferredTrackQuality ?? store.defaultPlaybackQuality)
      : null;

    store.setStatePatch({
      currentTrack: input.currentTrack,
      queue: input.playQueue,
      priorityQueue: [],
      loadedStreamQuality: hydratedLevel,
      volume: effectiveVolume,
      muted: isMuted,
      lastNonZeroVolume: restoredLastNonZero,
      playbackMode: input.playbackMode,
      hydrated: true,
    });
    usePlaybackClockStore.getState().setClock({
      currentTime: input.playbackSeconds,
      duration: input.currentTrack?.durationSeconds ?? 0,
      bufferedTime: 0,
    });

    if (input.currentTrack && hydratedLevel) {
      this.#driver.setSrc(api.buildStreamUrl(input.currentTrack, hydratedLevel));
      this.#syncMediaSession(input.currentTrack);
    }
  }

  async playTrack(
    song: Song,
    options?: {
      queue?: Song[];
      level?: QualityLevel;
      startAtSeconds?: number;
      recordHistory?: boolean;
      fm?: boolean;
      preservePriorityQueue?: boolean;
      preservePreferredQuality?: boolean;
      naturalAdvance?: boolean;
    },
  ): Promise<void> {
    const token = ++this.#playToken;
    if (!options?.naturalAdvance) {
      this.#playbackSessionId += 1;
    }
    this.#playIntent = true;
    this.#trackEndedAwaitingNext = false;
    this.#driver.cancelFade();
    this.#pendingPause = false;

    const isFm = Boolean(options?.fm);
    const state = usePlayerStore.getState();

    if (!isFm) {
      if (state.fmMode && state.currentTrack) {
        this.#fm.recordPassedTrack(state.currentTrack, song);
      }
      this.#fm.abortFetch();
      this.#fm.resetCursor();
    } else {
      if (state.fmMode && state.currentTrack && getSongKey(state.currentTrack) !== getSongKey(song)) {
        this.#fm.recordPassedTrack(state.currentTrack, song);
      }
      this.#fm.updateCursorForTrack(song, options?.queue);
    }

    const { queue: nextQueue, priorityQueue: nextPriorityQueue } = computeQueuesOnPlay({
      currentQueue: state.queue,
      currentPriorityQueue: state.priorityQueue,
      song,
      explicitQueue: options?.queue,
      preservePriorityQueue: options?.preservePriorityQueue,
    });

    const nextPreferredQuality =
      options?.level ??
      (options?.preservePreferredQuality || !state.currentTrack ? state.preferredTrackQuality : null);
    const level = nextPreferredQuality ?? state.defaultPlaybackQuality;
    this.#pendingSeek = options?.startAtSeconds ?? null;

    if (options?.recordHistory !== false) {
      this.#pendingHistorySong = { token, song };
      this.#recordedHistoryForCurrentPlay = false;
    } else {
      this.#pendingHistorySong = null;
    }

    state.setStatePatch({
      currentTrack: song,
      queue: nextQueue,
      priorityQueue: nextPriorityQueue,
      preferredTrackQuality: nextPreferredQuality,
      loadedStreamQuality: level,
      isLoading: true,
      playerError: null,
      fmMode: isFm,
    });
    usePlaybackClockStore.getState().setClock({
      currentTime: options?.startAtSeconds ?? 0,
      duration: song.durationSeconds,
      bufferedTime: 0,
    });

    this.#driver.setSrc(api.buildStreamUrl(song, level), true);
    this.#syncMediaSession(song);
    this.#persistence.persistNow();

    await this.#startAudioWithFade(token);
  }

  async playFmTrack(
    song: Song,
    options?: {
      queue?: Song[];
      level?: QualityLevel;
      startAtSeconds?: number;
      preservePriorityQueue?: boolean;
      preservePreferredQuality?: boolean;
      naturalAdvance?: boolean;
    },
  ): Promise<void> {
    const queue = options?.queue ?? usePlayerStore.getState().fmQueue;
    await this.playTrack(song, {
      queue: queue.length > 0 ? queue : [song],
      level: options?.level,
      startAtSeconds: options?.startAtSeconds,
      fm: true,
      preservePriorityQueue: options?.preservePriorityQueue,
      preservePreferredQuality: options?.preservePreferredQuality,
      naturalAdvance: options?.naturalAdvance,
    });
  }

  loadFmBatch(options?: {
    autoPlay?: boolean;
    source?: "page" | "engine";
    naturalAdvance?: boolean;
    mode?: PersonalFmMode;
    append?: boolean;
  }): Promise<Song[]> {
    return this.#fm.loadBatch(options);
  }

  setFmSubMode(mode: PersonalFmMode, options?: { autoPlay?: boolean }): Promise<Song[]> {
    const autoPlay = options?.autoPlay ?? usePlayerStore.getState().fmMode;
    return this.#fm.loadBatch({ mode, autoPlay, source: "page" });
  }

  appendFmBatch(): Promise<Song[]> {
    return this.#fm.loadBatch({ autoPlay: false, source: "page", append: true });
  }

  trashFmSong(song: Song): Promise<void> {
    return this.#fm.trashSong(song);
  }

  clearFmRecentTracks(): void {
    this.#fm.clearRecentTracks();
  }

  nextFmTrack(options?: { naturalAdvance?: boolean }): Promise<void> {
    return this.#fm.nextTrack(options);
  }

  skipOrStartFmNext(): Promise<void> {
    return this.#fm.skipOrStartNext();
  }

  async playCloudAll(params: CloudPlayAllParams): Promise<void> {
    const runId = ++this.#cloudPlayAllRunId;
    await executeCloudPlayAll(params, runId, {
      getSessionEpoch: () => this.#sessionEpoch,
      getPlaybackSessionId: () => this.#playbackSessionId,
      getPlayToken: () => this.#playToken,
      isCurrentRun: (id) => id === this.#cloudPlayAllRunId,
      replaceQueueSilently: (queue) => this.replaceQueueSilently(queue),
      playTrack: (song, opts) => this.playTrack(song, opts),
    });
  }

  async switchPlaybackQuality(level: QualityLevel): Promise<void> {
    const state = usePlayerStore.getState();
    const { currentTrack } = state;
    if (!currentTrack) {
      state.setStatePatch({ preferredTrackQuality: level });
      return;
    }

    if (this.#fm.isFetchingAutoPlay() || (this.#trackEndedAwaitingNext && this.#fm.isFetching())) {
      state.setStatePatch({ preferredTrackQuality: level, playerError: null });
      return;
    }

    const resumeAt = usePlaybackClockStore.getState().currentTime;
    const shouldPlay =
      (state.isPlaying || state.isLoading || this.#playIntent) &&
      !this.#pendingPause &&
      !this.#trackEndedAwaitingNext;

    if (!shouldPlay) {
      const token = ++this.#playToken;
      this.#playIntent = false;
      this.#trackEndedAwaitingNext = false;
      this.#driver.cancelFade();
      this.#pendingPause = false;
      this.#pendingSeek = resumeAt > 0 ? resumeAt : null;
      if (!this.#recordedHistoryForCurrentPlay) {
        this.#pendingHistorySong = { token, song: currentTrack };
      }
      state.setStatePatch({
        preferredTrackQuality: level,
        loadedStreamQuality: level,
        isLoading: false,
        isPlaying: false,
        playerError: null,
      });
      this.#driver.setSrc(api.buildStreamUrl(currentTrack, level), true);
      return;
    }

    await this.playTrack(currentTrack, {
      level,
      startAtSeconds: resumeAt,
      recordHistory: !this.#recordedHistoryForCurrentPlay,
      fm: state.fmMode,
      preservePriorityQueue: true,
      preservePreferredQuality: true,
    });
  }

  async togglePlay(): Promise<void> {
    const state = usePlayerStore.getState();
    const { currentTrack, queue } = state;
    if (!currentTrack) {
      if (queue.length === 0) return;
      const first = queue.find((item) => isSongPlayable(item));
      if (!first) {
        toast.info("当前队列中的歌曲均不可播放");
        return;
      }
      await this.playTrack(first);
      return;
    }

    if (this.#driver.paused || this.#pendingPause) {
      const wasPendingPause = this.#pendingPause;
      this.#pendingPause = false;
      this.#trackEndedAwaitingNext = false;
      this.#playIntent = true;
      const token = ++this.#playToken;
      this.#driver.cancelFade();

      const previousError = state.playerError;
      const shouldReload = !this.#driver.currentSrcOrAttr || Boolean(previousError) || this.#driver.hasError;
      if (shouldReload) {
        const level = state.preferredTrackQuality ?? state.defaultPlaybackQuality;
        state.setStatePatch({ isLoading: true, loadedStreamQuality: level });
        this.#driver.setSrc(api.buildStreamUrl(currentTrack, level), true);
      }

      if (!this.#recordedHistoryForCurrentPlay) {
        this.#pendingHistorySong = { token, song: currentTrack };
      }

      await this.#startAudioWithFade(token, {
        fromVolume: wasPendingPause ? this.#driver.volume : 0,
        fallbackError: previousError ?? undefined,
      });
      return;
    }

    this.#pendingPause = true;
    this.#playIntent = false;
    this.#trackEndedAwaitingNext = false;
    const token = ++this.#playToken;
    const pauseRev = this.#volumeRevision;
    state.setStatePatch({ isPlaying: false, isLoading: false });

    this.#driver.animateVolume({
      from: this.#driver.volume,
      to: 0,
      durationMs: PAUSE_FADE_DURATION_MS,
      isStillValid: () => token === this.#playToken && pauseRev === this.#volumeRevision,
      onDone: () => {
        if (this.#pendingPause && token === this.#playToken) {
          this.#completePendingPause();
        }
      },
    });
  }

  seek(seconds: number): void {
    const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (this.#driver.readyState >= 1) {
      const max = Number.isFinite(this.#driver.duration) ? this.#driver.duration : clamped;
      const target = Math.min(max, clamped);
      this.#driver.setCurrentTime(target);
      usePlaybackClockStore.getState().setClock({ currentTime: target });
    } else {
      this.#pendingSeek = clamped;
      usePlaybackClockStore.getState().setClock({ currentTime: clamped });
    }
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.85));
    this.#volumeRevision += 1;
    this.#driver.cancelFade();

    if (this.#pendingPause) {
      this.#completePendingPause();
    }

    const isMuted = clamped === 0;
    this.#driver.setVolumeAndMute(clamped, isMuted);

    usePlayerStore.getState().setStatePatch({
      volume: clamped,
      muted: isMuted,
      ...(clamped > 0 ? { lastNonZeroVolume: clamped } : {}),
    });
    this.#persistence.schedulePersist();
  }

  toggleMute(): void {
    const { volume, muted, lastNonZeroVolume } = usePlayerStore.getState();
    if (muted || volume === 0) {
      this.setVolume(lastNonZeroVolume > 0 ? lastNonZeroVolume : 0.8);
      return;
    }
    usePlayerStore.getState().setStatePatch({ lastNonZeroVolume: volume });
    this.setVolume(0);
  }

  addToQueue(song: Song): void {
    this.#playbackSessionId += 1;
    const state = usePlayerStore.getState();
    state.setStatePatch({ queue: addSongToQueue(state.queue, song) });
    this.#persistence.schedulePersist();
  }

  insertNextInQueue(song: Song): void {
    this.#playbackSessionId += 1;
    const state = usePlayerStore.getState();
    const updated = insertSongNextInQueue({
      queue: state.queue,
      priorityQueue: state.priorityQueue,
      currentTrack: state.currentTrack,
      song,
    });
    state.setStatePatch(updated);
    this.#persistence.schedulePersist();
  }

  removeFromQueue(songKey: string): void {
    this.#playbackSessionId += 1;
    const state = usePlayerStore.getState();
    state.setStatePatch(
      removeSongFromQueues({
        queue: state.queue,
        priorityQueue: state.priorityQueue,
        songKey,
      }),
    );
    this.#persistence.schedulePersist();
  }

  clearQueue(): void {
    this.#playbackSessionId += 1;
    usePlayerStore.getState().setStatePatch({ queue: [], priorityQueue: [], fmMode: false });
    this.#persistence.schedulePersist();
  }

  cyclePlaybackMode(): void {
    const state = usePlayerStore.getState();
    state.setStatePatch({ playbackMode: cyclePlaybackModeValue(state.playbackMode) });
    this.#persistence.persistNow();
  }

  async playNext(options?: { naturalAdvance?: boolean }): Promise<void> {
    const { queue, priorityQueue, currentTrack, playbackMode, fmMode } = usePlayerStore.getState();

    if (priorityQueue.length > 0) {
      const { track, remaining } = dequeueNextPriorityTrack(priorityQueue);
      usePlayerStore.getState().setStatePatch({ priorityQueue: remaining });
      if (track) {
        await this.playTrack(track, {
          fm: fmMode,
          preservePriorityQueue: true,
          naturalAdvance: options?.naturalAdvance,
        });
        return;
      }
    }

    if (fmMode) {
      await this.#fm.nextTrack({ naturalAdvance: options?.naturalAdvance });
      return;
    }

    if (queue.length === 0) {
      this.#trackEndedAwaitingNext = false;
      if (this.#driver.paused || this.#pendingPause) {
        this.#playIntent = false;
        usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: false });
      }
      return;
    }

    const candidate = selectNextQueueTrack({ queue, currentTrack, playbackMode });
    if (candidate) {
      await this.playTrack(candidate, {
        preservePriorityQueue: true,
        naturalAdvance: options?.naturalAdvance,
      });
      return;
    }

    this.#trackEndedAwaitingNext = false;
    if (this.#driver.paused || this.#pendingPause) {
      this.#playIntent = false;
      usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: false });
    }
    toast.info("当前队列中的歌曲均不可播放");
  }

  async playPrevious(): Promise<void> {
    const { queue, fmQueue, currentTrack, fmMode } = usePlayerStore.getState();
    const sourceList = fmMode && fmQueue.length > 0 ? fmQueue : queue;
    if (sourceList.length === 0) return;

    if (currentTrack && usePlaybackClockStore.getState().currentTime > 4) {
      this.seek(0);
      return;
    }

    const candidate = selectPreviousQueueTrack({
      sourceList,
      currentTrack,
      fmMode,
      fmCursorIndex: this.#fm.getCursorIndex(),
    });
    if (candidate) {
      await this.playTrack(candidate, {
        fm: fmMode,
        ...(fmMode ? { queue: sourceList } : {}),
        preservePriorityQueue: true,
      });
      return;
    }

    if (this.#driver.paused || this.#pendingPause) {
      this.#playIntent = false;
      usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: false });
    }
    toast.info("当前队列中的歌曲均不可播放");
  }

  stop(): void {
    this.#sessionEpoch += 1;
    this.#playToken += 1;
    this.#playbackSessionId += 1;
    this.#cloudPlayAllRunId += 1;
    this.#playIntent = false;
    this.#trackEndedAwaitingNext = false;
    this.#fm.resetCursor();
    this.#volumeRevision += 1;
    this.#pendingPause = false;
    this.#persistence.reset();
    this.#fm.abortFetch();
    this.#pendingSeek = null;
    this.#pendingHistorySong = null;
    this.#recordedHistoryForCurrentPlay = false;

    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
    this.#driver.resetElement();
    this.#driver.clearMediaSession();
  }
}

export const audioEngine = new AudioEngine();
