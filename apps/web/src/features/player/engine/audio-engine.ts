import {
  type PlaybackMode,
  type PlayerState,
  type PreferenceQualityLevel,
  QUALITY_RANK,
  type QualityLevel,
  type Song,
  getSongKey,
} from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";

const FADE_DURATION_MS = 220;
const PAUSE_FADE_DURATION_MS = 140;
const REMOTE_SYNC_INTERVAL_MS = 10_000;
const PERSIST_DEBOUNCE_MS = 400;
const MAX_PERSISTED_QUEUE_LENGTH = 200;
/** Keep well below the browser's 64 KiB shared hard limit for fetch(..., { keepalive: true }). */
export const KEEPALIVE_MAX_BYTES = 58 * 1024;

function positiveMod(idx: number, len: number): number {
  return ((idx % len) + len) % len;
}

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

/**
 * Pure TypeScript AudioEngine completely decoupled from React component lifecycles.
 * - Single monotonic playToken eliminates stale loadedmetadata / fade-in / FM races.
 * - Wall-clock deadline + document.hidden fast-path guarantee fades & pauses never stall in background tabs.
 * - `#volumeRevision` & `#pendingPause` prevent fade-ins from clobbering mute or volume changes cancelling pause.
 * - Updates high-frequency clock store only, keeping main component tree at 0 re-renders during playback.
 */
export class AudioEngine {
  readonly #audio: HTMLAudioElement;
  #sessionEpoch = 0;
  #playToken = 0;
  #playIntent = false;
  #volumeRevision = 0;
  #pendingPause = false;
  #fadeFrameId: number | null = null;
  #fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #pendingSeek: number | null = null;
  #lastPersistAt = 0;
  #persistDebounceId: ReturnType<typeof setTimeout> | null = null;
  #listenersBound = false;
  #pagehideHandler: (() => void) | null = null;
  #onPlayHistoryRecorded: ((res: { items: Song[] }) => void) | null = null;
  #historyRequestSeq = 0;
  #latestAppliedHistorySeq = 0;
  #pendingHistorySong: { token: number; song: Song } | null = null;
  #recordedHistoryForCurrentPlay = false;
  #fmAbortController: AbortController | null = null;
  #fmFetching = false;
  #fmFetchSource: "page" | "engine" | null = null;

  constructor(audioElement?: HTMLAudioElement) {
    this.#audio = audioElement ?? new Audio();
    this.#audio.preload = "metadata";
    this.#bindEvents();
  }

  /**
   * Dynamically bound/unbound by the active `<UserSessionBoundary>` so this singleton
   * never holds a stale QueryClient reference across account switches.
   */
  setPlayHistoryListener(listener: ((res: { items: Song[] }) => void) | null): void {
    this.#onPlayHistoryRecorded = listener;
  }

  dispose(): void {
    this.#cancelFade();
    this.#clearPersistDebounce();
    this.#abortFmFetch();
    if (this.#pagehideHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.#pagehideHandler);
      this.#pagehideHandler = null;
    }
  }

  #isPlayable(song: Song | undefined): song is Song {
    return Boolean(song && !song.availability?.playback.locked);
  }

  #bindEvents(): void {
    if (this.#listenersBound) return;
    this.#listenersBound = true;

    this.#audio.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0;
      usePlaybackClockStore.getState().setClock({ duration });

      if (this.#pendingSeek !== null && duration > 0) {
        const clamped = Math.min(duration, Math.max(0, this.#pendingSeek));
        this.#audio.currentTime = clamped;
        usePlaybackClockStore.getState().setClock({ currentTime: clamped });
        this.#pendingSeek = null;
      }
    });

    this.#audio.addEventListener("timeupdate", () => {
      const currentTime = Number.isFinite(this.#audio.currentTime) ? this.#audio.currentTime : 0;
      const duration = Number.isFinite(this.#audio.duration)
        ? this.#audio.duration
        : (usePlayerStore.getState().currentTrack?.durationSeconds ?? 0);
      let bufferedTime = 0;
      if (this.#audio.buffered.length > 0) {
        bufferedTime = this.#audio.buffered.end(this.#audio.buffered.length - 1);
      }
      usePlaybackClockStore.getState().setClock({ currentTime, duration, bufferedTime });

      if (Date.now() - this.#lastPersistAt >= REMOTE_SYNC_INTERVAL_MS) {
        this.#persistRemoteState();
      }
    });

    this.#audio.addEventListener("playing", () => {
      if (this.#pendingPause) return;
      usePlayerStore.getState().setStatePatch({ isPlaying: true, isLoading: false, playerError: null });

      const pending = this.#pendingHistorySong;
      if (pending && pending.token === this.#playToken && !this.#recordedHistoryForCurrentPlay) {
        this.#recordedHistoryForCurrentPlay = true;
        this.#pendingHistorySong = null;
        // F14: Validate against #sessionEpoch (NOT #playToken) so pausing right after "playing" never drops the callback
        const recordEpoch = this.#sessionEpoch;
        const reqSeq = ++this.#historyRequestSeq;
        void api
          .recordPlayHistory(pending.song)
          .then((res) => {
            if (recordEpoch === this.#sessionEpoch && reqSeq >= this.#latestAppliedHistorySeq) {
              this.#latestAppliedHistorySeq = reqSeq;
              this.#onPlayHistoryRecorded?.(res);
            }
          })
          .catch(() => undefined);
      }
    });

    this.#audio.addEventListener("pause", () => {
      this.#pendingPause = false;
      const state = usePlayerStore.getState();
      state.setStatePatch({ isPlaying: false, isLoading: false });
      if (state.hydrated && state.currentTrack) {
        this.#persistRemoteState();
      }
    });

    this.#audio.addEventListener("waiting", () => {
      if (!this.#audio.paused && !this.#pendingPause) {
        usePlayerStore.getState().setStatePatch({ isLoading: true });
      }
    });

    this.#audio.addEventListener("ended", () => {
      const { playbackMode, currentTrack, fmMode } = usePlayerStore.getState();
      if (playbackMode === "repeat-one" && currentTrack && !fmMode) {
        this.#audio.currentTime = 0;
        usePlaybackClockStore.getState().setClock({ currentTime: 0 });
        void this.#startAudioWithFade(this.#playToken);
        return;
      }
      void this.playNext();
    });

    this.#audio.addEventListener("error", () => {
      // Ignore synthetic MEDIA_ERR_SRC_NOT_SUPPORTED fired when stop() clears audio src
      if (!usePlayerStore.getState().currentTrack) return;

      this.#playIntent = false;

      const errorToken = this.#playToken;
      const failedSrc = this.#audio.currentSrc || this.#audio.src;
      const fallbackMessage = "音频加载失败，请检查平台账号绑定、会员权限或切换其他音质。";

      usePlayerStore.getState().setStatePatch({
        isPlaying: false,
        isLoading: false,
        playerError: fallbackMessage,
      });

      if (failedSrc?.includes("/api/media/stream") && typeof fetch === "function") {
        void fetch(failedSrc, { credentials: "include", headers: { Range: "bytes=0-1" } })
          .then(async (res) => {
            if (res.ok) {
              void res.body?.cancel();
              return;
            }
            const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
            const detail = body?.error?.message?.trim();
            if (detail && errorToken === this.#playToken) {
              usePlayerStore.getState().setStatePatch({ playerError: detail });
            }
          })
          .catch(() => undefined);
      }
    });

    if (typeof window !== "undefined") {
      this.#pagehideHandler = () => this.#persistRemoteState({ keepalive: true });
      window.addEventListener("pagehide", this.#pagehideHandler);
    }
  }

  #cancelFade(): void {
    if (this.#fadeFrameId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.#fadeFrameId);
      this.#fadeFrameId = null;
    }
    if (this.#fadeTimeoutId !== null) {
      globalThis.clearTimeout(this.#fadeTimeoutId);
      this.#fadeTimeoutId = null;
    }
  }

  #clearPersistDebounce(): void {
    if (this.#persistDebounceId !== null) {
      globalThis.clearTimeout(this.#persistDebounceId);
      this.#persistDebounceId = null;
    }
  }

  #completePendingPause(): void {
    if (!this.#pendingPause) return;
    this.#pendingPause = false;
    this.#audio.pause();
    const { volume, muted } = usePlayerStore.getState();
    const effectiveVolume = muted ? 0 : volume;
    this.#audio.volume = effectiveVolume;
    this.#audio.muted = muted || effectiveVolume === 0;
  }

  #animateVolume(
    token: number,
    volumeRevision: number,
    from: number,
    to: number,
    durationMs: number,
    onDone?: () => void,
  ): void {
    this.#cancelFade();
    const clampedFrom = Math.min(1, Math.max(0, from));
    const clampedTo = Math.min(1, Math.max(0, to));
    this.#audio.volume = clampedFrom;

    const isHidden = typeof document !== "undefined" && Boolean(document.hidden);
    if (
      durationMs <= 0 ||
      isHidden ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      this.#audio.volume = clampedTo;
      onDone?.();
      return;
    }

    const startedAt = Date.now();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      this.#cancelFade();
      if (token !== this.#playToken || volumeRevision !== this.#volumeRevision) return;
      this.#audio.volume = clampedTo;
      onDone?.();
    };

    // Wall-clock deadline guarantees convergence even if rAF is throttled/paused in a background tab
    this.#fadeTimeoutId = globalThis.setTimeout(finish, durationMs + 50);

    const step = () => {
      if (finished) return;
      if (token !== this.#playToken || volumeRevision !== this.#volumeRevision) {
        finished = true;
        this.#cancelFade();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        finish();
        return;
      }
      const progress = Math.min(1, Math.max(0, (Date.now() - startedAt) / durationMs));
      const eased = 1 - (1 - progress) ** 3;
      this.#audio.volume = Math.min(1, Math.max(0, clampedFrom + (clampedTo - clampedFrom) * eased));

      if (progress < 1) {
        this.#fadeFrameId = window.requestAnimationFrame(step);
        return;
      }

      finish();
    };

    this.#fadeFrameId = window.requestAnimationFrame(step);
  }

  async #startAudioWithFade(
    token: number,
    options?: { fromVolume?: number; fallbackError?: string },
  ): Promise<void> {
    const startRevision = this.#volumeRevision;
    const initialState = usePlayerStore.getState();
    const initialTarget = initialState.muted ? 0 : initialState.volume;
    const fromVolume = Math.min(initialTarget, Math.max(0, options?.fromVolume ?? 0));
    this.#audio.volume = fromVolume;
    this.#audio.muted = initialState.muted || initialTarget === 0;

    try {
      await this.#audio.play();
      if (token !== this.#playToken || this.#pendingPause) return;

      const latestState = usePlayerStore.getState();
      const latestTarget = latestState.muted ? 0 : latestState.volume;
      this.#audio.muted = latestState.muted || latestTarget === 0;

      // If user adjusted volume or muted while play() was resolving, yield immediately to user's volume
      if (startRevision !== this.#volumeRevision || latestTarget === 0) {
        this.#audio.volume = latestTarget;
      } else {
        this.#animateVolume(token, this.#volumeRevision, fromVolume, latestTarget, FADE_DURATION_MS);
      }

      if (!this.#audio.paused && !this.#pendingPause && !usePlayerStore.getState().isPlaying) {
        usePlayerStore.getState().setStatePatch({ isPlaying: true, isLoading: false, playerError: null });
      }
    } catch {
      if (token !== this.#playToken || this.#pendingPause) return;
      this.#playIntent = false;
      const latestState = usePlayerStore.getState();
      const latestTarget = latestState.muted ? 0 : latestState.volume;
      this.#audio.volume = latestTarget;
      this.#audio.muted = latestState.muted || latestTarget === 0;

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

  #updateMediaSession(song: Song): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork: song.coverUrl ? [{ src: song.coverUrl, sizes: "512x512", type: "image/jpeg" }] : [],
      });
      navigator.mediaSession.setActionHandler("play", () => void this.togglePlay());
      navigator.mediaSession.setActionHandler("pause", () => void this.togglePlay());
      navigator.mediaSession.setActionHandler("previoustrack", () => void this.playPrevious());
      navigator.mediaSession.setActionHandler("nexttrack", () => void this.playNext());
    } catch {
      // Ignore MediaSession errors on unsupported platforms
    }
  }

  #buildPersistPayload(keepalive = false): PlayerState {
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

  #persistRemoteState(options?: { keepalive?: boolean }): void {
    this.#clearPersistDebounce();
    const state = usePlayerStore.getState();
    if (!state.hydrated) return;
    this.#lastPersistAt = Date.now();
    const payload = this.#buildPersistPayload(Boolean(options?.keepalive));
    void api
      .savePlayerState(payload, options?.keepalive ? { keepalive: true } : undefined)
      .catch(() => undefined);
  }

  #schedulePersistRemoteState(delayMs = PERSIST_DEBOUNCE_MS): void {
    if (!usePlayerStore.getState().hydrated) return;
    this.#clearPersistDebounce();
    this.#persistDebounceId = globalThis.setTimeout(() => {
      this.#persistDebounceId = null;
      this.#persistRemoteState();
    }, delayMs);
  }

  #abortFmFetch(): void {
    if (this.#fmAbortController) {
      this.#fmAbortController.abort();
      this.#fmAbortController = null;
    }
    this.#fmFetchSource = null;
    if (this.#fmFetching) {
      this.#fmFetching = false;
      usePlayerStore.getState().setStatePatch({ fmLoading: false });
    }
  }

  cancelPendingFmFetch(): void {
    this.#abortFmFetch();
  }

  /**
   * P09: Cancels only manual/preview FM batch requests initiated from PersonalFmPage on unmount,
   * without interrupting active FM playback or engine-driven batch continuations at queue end.
   */
  cancelPageFmFetch(): void {
    if (this.#fmFetchSource === "page") {
      this.#abortFmFetch();
    }
  }

  /**
   * Synchronizes user's default playback quality preference from settings.
   * Rebuilds `#audio.src` if hydrated and paused without a per-track override (fixes hydrate vs settings race).
   */
  syncDefaultPlaybackQuality(level: PreferenceQualityLevel): void {
    const state = usePlayerStore.getState();
    state.setStatePatch({ defaultPlaybackQuality: level });

    if (
      state.currentTrack &&
      !state.activeQualityOverride &&
      this.#audio.paused &&
      !state.isPlaying &&
      !this.#pendingPause
    ) {
      const nextUrl = api.buildStreamUrl(state.currentTrack, level);
      const currentSrc = this.#audio.getAttribute("src") || this.#audio.src;
      if (currentSrc !== nextUrl && !currentSrc.endsWith(nextUrl)) {
        const resumeAt = usePlaybackClockStore.getState().currentTime;
        if (resumeAt > 0 && this.#pendingSeek === null) {
          this.#pendingSeek = resumeAt;
        }
        this.#audio.src = nextUrl;
      }
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
      // Do not clobber user-initiated playback if hydration arrives late
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

    this.#playIntent = false;
    this.#audio.volume = effectiveVolume;
    this.#audio.muted = isMuted;
    this.#pendingSeek = input.playbackSeconds > 0 ? input.playbackSeconds : null;
    this.#pendingHistorySong = null;
    this.#recordedHistoryForCurrentPlay = false;

    store.setStatePatch({
      currentTrack: input.currentTrack,
      queue: input.playQueue,
      priorityQueue: [],
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

    if (input.currentTrack) {
      const level = store.activeQualityOverride ?? store.defaultPlaybackQuality;
      this.#audio.src = api.buildStreamUrl(input.currentTrack, level);
      this.#updateMediaSession(input.currentTrack);
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
    },
  ): Promise<void> {
    const token = ++this.#playToken;
    this.#playIntent = true;
    this.#cancelFade();
    this.#pendingPause = false;

    const isFm = Boolean(options?.fm);
    if (!isFm) {
      this.#abortFmFetch();
    }

    const state = usePlayerStore.getState();
    const songKey = getSongKey(song);
    const replacingQueue = Boolean(options?.queue) && !options?.preservePriorityQueue;
    const nextQueue = options?.queue
      ? options.queue
      : state.queue.some((item) => getSongKey(item) === songKey)
        ? state.queue
        : [...state.queue, song];
    // P11: Replacing the playlist clears stale priorityQueue entries from the previous playlist
    const nextPriorityQueue = replacingQueue
      ? []
      : state.priorityQueue.filter((item) => getSongKey(item) !== songKey);

    const level = options?.level ?? state.defaultPlaybackQuality;
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
      activeQualityOverride: options?.level ?? null,
      isLoading: true,
      playerError: null,
      fmMode: isFm,
    });
    usePlaybackClockStore.getState().setClock({
      currentTime: options?.startAtSeconds ?? 0,
      duration: song.durationSeconds,
      bufferedTime: 0,
    });

    this.#audio.src = api.buildStreamUrl(song, level);
    this.#audio.load();
    this.#updateMediaSession(song);
    this.#persistRemoteState();

    await this.#startAudioWithFade(token);
  }

  async playFmTrack(
    song: Song,
    options?: { queue?: Song[]; startAtSeconds?: number; preservePriorityQueue?: boolean },
  ): Promise<void> {
    const queue = options?.queue ?? usePlayerStore.getState().fmQueue;
    await this.playTrack(song, {
      queue: queue.length > 0 ? queue : [song],
      startAtSeconds: options?.startAtSeconds,
      fm: true,
      preservePriorityQueue: options?.preservePriorityQueue,
    });
  }

  async loadFmBatch(options?: { autoPlay?: boolean; source?: "page" | "engine" }): Promise<Song[]> {
    const source = options?.source ?? "engine";
    if (this.#fmFetching) {
      if (source === "page" && this.#fmFetchSource === "page") {
        return usePlayerStore.getState().fmQueue;
      }
      if (source === "engine") {
        // Promote source to engine so page unmount will not abort an engine-required continuation
        this.#fmFetchSource = "engine";
        return usePlayerStore.getState().fmQueue;
      }
    }

    this.#abortFmFetch();
    const controller = new AbortController();
    this.#fmAbortController = controller;
    this.#fmFetching = true;
    this.#fmFetchSource = source;
    const requestToken = this.#playToken;

    usePlayerStore.getState().setStatePatch({ fmLoading: true, fmError: null });

    try {
      const res = await api.getPersonalFm(controller.signal);
      if (controller.signal.aborted) {
        return [];
      }
      if (options?.autoPlay && requestToken !== this.#playToken) {
        return [];
      }

      const songs = res.songs ?? [];
      usePlayerStore.getState().setStatePatch({
        fmQueue: songs,
        fmLoading: false,
        fmError: null,
      });

      if (options?.autoPlay && songs.length > 0) {
        // P10: Never auto-play a locked track when all FM items are locked
        const first = songs.find((item) => this.#isPlayable(item));
        if (first) {
          await this.playFmTrack(first, { queue: songs, preservePriorityQueue: source === "engine" });
        }
      }
      return songs;
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return [];
      }
      const message = err instanceof Error ? err.message : "加载私人漫游失败";
      usePlayerStore.getState().setStatePatch({
        fmLoading: false,
        fmError: message,
      });
      throw err;
    } finally {
      if (this.#fmAbortController === controller) {
        this.#fmAbortController = null;
        this.#fmFetching = false;
        this.#fmFetchSource = null;
        usePlayerStore.getState().setStatePatch({ fmLoading: false });
      }
    }
  }

  async nextFmTrack(): Promise<void> {
    const { fmQueue, currentTrack, fmMode } = usePlayerStore.getState();
    const currentIdx =
      fmMode && currentTrack
        ? fmQueue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
        : -1;

    for (let idx = currentIdx + 1; idx < fmQueue.length; idx += 1) {
      const candidate = fmQueue[idx];
      if (this.#isPlayable(candidate)) {
        await this.playFmTrack(candidate, { queue: fmQueue, preservePriorityQueue: true });
        return;
      }
    }

    await this.loadFmBatch({ autoPlay: true, source: "engine" }).catch(() => undefined);
  }

  async switchPlaybackQuality(level: QualityLevel): Promise<void> {
    const state = usePlayerStore.getState();
    const { currentTrack } = state;
    if (!currentTrack) return;

    const resumeAt = usePlaybackClockStore.getState().currentTime;
    // P12 + P19: Keep playback intent alive if track is actively playing OR still loading before first "playing"
    const shouldPlay = (state.isPlaying || state.isLoading || this.#playIntent) && !this.#pendingPause;

    if (!shouldPlay) {
      const token = ++this.#playToken;
      this.#playIntent = false;
      this.#cancelFade();
      this.#pendingPause = false;
      this.#pendingSeek = resumeAt > 0 ? resumeAt : null;
      if (!this.#recordedHistoryForCurrentPlay) {
        this.#pendingHistorySong = { token, song: currentTrack };
      }
      state.setStatePatch({
        activeQualityOverride: level,
        isLoading: false,
        isPlaying: false,
        playerError: null,
      });
      this.#audio.src = api.buildStreamUrl(currentTrack, level);
      this.#audio.load();
      return;
    }

    const shouldRecordHistory = !this.#recordedHistoryForCurrentPlay;
    await this.playTrack(currentTrack, {
      level,
      startAtSeconds: resumeAt,
      recordHistory: shouldRecordHistory,
      fm: state.fmMode,
      preservePriorityQueue: true,
    });
  }

  async togglePlay(): Promise<void> {
    const state = usePlayerStore.getState();
    const { currentTrack, queue } = state;
    if (!currentTrack) {
      if (queue.length === 0) return;
      // P10: Refuse fallback to locked tracks when the entire queue is locked
      const first = queue.find((item) => this.#isPlayable(item));
      if (!first) {
        toast.info("当前队列中的歌曲均不可播放");
        return;
      }
      await this.playTrack(first);
      return;
    }

    if (this.#audio.paused || this.#pendingPause) {
      const wasPendingPause = this.#pendingPause;
      this.#pendingPause = false;
      this.#playIntent = true;
      const token = ++this.#playToken;
      this.#cancelFade();

      const previousError = state.playerError;
      const shouldReload = !this.#audio.src || Boolean(previousError) || Boolean(this.#audio.error);
      if (shouldReload) {
        const level = state.activeQualityOverride ?? state.defaultPlaybackQuality;
        state.setStatePatch({ isLoading: true });
        this.#audio.src = api.buildStreamUrl(currentTrack, level);
        this.#audio.load();
      }

      if (!this.#recordedHistoryForCurrentPlay) {
        this.#pendingHistorySong = { token, song: currentTrack };
      }

      await this.#startAudioWithFade(token, {
        fromVolume: wasPendingPause ? this.#audio.volume : 0,
        fallbackError: previousError ?? undefined,
      });
      return;
    }

    // Optimistic pause state + pendingPause guard eliminates 140ms double-click / volume-drag races
    this.#pendingPause = true;
    this.#playIntent = false;
    const token = ++this.#playToken;
    const pauseRev = this.#volumeRevision;
    state.setStatePatch({ isPlaying: false, isLoading: false });

    this.#animateVolume(token, pauseRev, this.#audio.volume, 0, PAUSE_FADE_DURATION_MS, () => {
      if (this.#pendingPause && token === this.#playToken) {
        this.#completePendingPause();
      }
    });
  }

  seek(seconds: number): void {
    const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    if (this.#audio.readyState >= 1) {
      const max = Number.isFinite(this.#audio.duration) ? this.#audio.duration : clamped;
      const target = Math.min(max, clamped);
      this.#audio.currentTime = target;
      usePlaybackClockStore.getState().setClock({ currentTime: target });
    } else {
      this.#pendingSeek = clamped;
      usePlaybackClockStore.getState().setClock({ currentTime: clamped });
    }
  }

  setVolume(volume: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0.85));
    this.#volumeRevision += 1;
    this.#cancelFade();

    // Never allow a volume change during pause fade-out to cancel the user's pause intent
    if (this.#pendingPause) {
      this.#completePendingPause();
    }

    const isMuted = clamped === 0;
    this.#audio.volume = clamped;
    this.#audio.muted = isMuted;

    usePlayerStore.getState().setStatePatch({
      volume: clamped,
      muted: isMuted,
      ...(clamped > 0 ? { lastNonZeroVolume: clamped } : {}),
    });
    this.#schedulePersistRemoteState();
  }

  toggleMute(): void {
    const { volume, muted, lastNonZeroVolume } = usePlayerStore.getState();
    if (muted || volume === 0) {
      const restored = lastNonZeroVolume > 0 ? lastNonZeroVolume : 0.8;
      this.setVolume(restored);
      return;
    }
    usePlayerStore.getState().setStatePatch({ lastNonZeroVolume: volume });
    this.setVolume(0);
  }

  addToQueue(song: Song): void {
    usePlayerStore.getState().addToQueue(song);
    this.#schedulePersistRemoteState();
  }

  insertNextInQueue(song: Song): void {
    usePlayerStore.getState().insertNextInQueue(song);
    this.#schedulePersistRemoteState();
  }

  removeFromQueue(songKey: string): void {
    usePlayerStore.getState().removeFromQueue(songKey);
    this.#schedulePersistRemoteState();
  }

  clearQueue(): void {
    usePlayerStore.getState().clearQueue();
    this.#schedulePersistRemoteState();
  }

  cyclePlaybackMode(): void {
    const order: PlaybackMode[] = ["sequential", "shuffle", "repeat-one"];
    const current = usePlayerStore.getState().playbackMode;
    const next = order[(order.indexOf(current) + 1) % order.length] ?? "sequential";
    usePlayerStore.getState().setStatePatch({ playbackMode: next });
    this.#persistRemoteState();
  }

  async playNext(): Promise<void> {
    const { queue, priorityQueue, currentTrack, playbackMode, fmMode } = usePlayerStore.getState();

    // P11: Always honor user-scheduled "下一首播放" priority items first (even during FM or shuffle)
    if (priorityQueue.length > 0) {
      const remaining = [...priorityQueue];
      while (remaining.length > 0) {
        const nextPriority = remaining.shift();
        if (this.#isPlayable(nextPriority)) {
          usePlayerStore.getState().setStatePatch({ priorityQueue: remaining });
          await this.playTrack(nextPriority, { fm: fmMode, preservePriorityQueue: true });
          return;
        }
      }
      usePlayerStore.getState().setStatePatch({ priorityQueue: [] });
    }

    if (fmMode) {
      await this.nextFmTrack();
      return;
    }

    if (queue.length === 0) return;

    if (playbackMode === "shuffle") {
      const playableOthers = queue.filter(
        (item) => this.#isPlayable(item) && (!currentTrack || getSongKey(item) !== getSongKey(currentTrack)),
      );
      if (playableOthers.length > 0) {
        const pick = playableOthers[Math.floor(Math.random() * playableOthers.length)];
        if (pick) {
          await this.playTrack(pick, { preservePriorityQueue: true });
          return;
        }
      }
      const anyPlayable = queue.filter((item) => this.#isPlayable(item));
      if (anyPlayable.length > 0) {
        const pick = anyPlayable[Math.floor(Math.random() * anyPlayable.length)];
        if (pick) {
          await this.playTrack(pick, { preservePriorityQueue: true });
          return;
        }
      }
    }

    const currentIdx = currentTrack
      ? queue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
      : -1;
    for (let step = 1; step <= queue.length; step += 1) {
      const candidate = queue[positiveMod(currentIdx + step, queue.length)];
      if (this.#isPlayable(candidate)) {
        await this.playTrack(candidate, { preservePriorityQueue: true });
        return;
      }
    }

    // P10: Never fall back to calling playTrack() on a locked song when the entire queue is locked
    this.#playIntent = false;
    usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: false });
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

    const currentIdx = currentTrack
      ? sourceList.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
      : -1;
    const baseIdx = currentIdx >= 0 ? currentIdx : 0;

    for (let step = 1; step <= sourceList.length; step += 1) {
      const candidate = sourceList[positiveMod(baseIdx - step, sourceList.length)];
      if (this.#isPlayable(candidate)) {
        // P07: Preserve fmMode when stepping backward within Personal FM
        await this.playTrack(candidate, {
          fm: fmMode,
          ...(fmMode ? { queue: sourceList } : {}),
          preservePriorityQueue: true,
        });
        return;
      }
    }

    // P10: Never fall back to calling playTrack() on a locked song when the entire queue is locked
    toast.info("当前队列中的歌曲均不可播放");
  }

  stop(): void {
    this.#sessionEpoch += 1;
    this.#playToken += 1;
    this.#playIntent = false;
    this.#volumeRevision += 1;
    this.#pendingPause = false;
    this.#cancelFade();
    this.#clearPersistDebounce();
    this.#abortFmFetch();
    this.#pendingSeek = null;
    this.#lastPersistAt = 0;
    this.#pendingHistorySong = null;
    this.#recordedHistoryForCurrentPlay = false;

    // Reset store BEFORE pausing/clearing src so pause/error/pagehide listeners never persist stale state
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });

    this.#audio.pause();
    this.#audio.removeAttribute("src");
    try {
      this.#audio.load();
    } catch {
      // Ignore in test environments where load() is not implemented
    }
    this.#audio.volume = 0.85;
    this.#audio.muted = false;

    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
      } catch {
        // Ignore MediaSession errors on unsupported platforms
      }
    }
  }
}

export const audioEngine = new AudioEngine();
