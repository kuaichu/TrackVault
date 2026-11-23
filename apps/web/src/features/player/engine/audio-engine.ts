import { type PlaybackMode, type QualityLevel, type Song, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";

const FADE_DURATION_MS = 220;
const REMOTE_SYNC_INTERVAL_MS = 10_000;

/**
 * Pure TypeScript AudioEngine completely decoupled from React component lifecycles.
 * - Single monotonic playToken eliminates stale loadedmetadata / fade-in races & broken watchdogs.
 * - Updates high-frequency clock store only, keeping main component tree at 0 re-renders during playback.
 * - Throttles remote state persistence to every 10s + pause/track-change/pagehide.
 */
export class AudioEngine {
  readonly #audio: HTMLAudioElement;
  #playToken = 0;
  #fadeFrameId: number | null = null;
  #pendingSeek: number | null = null;
  #lastPersistAt = 0;
  #listenersBound = false;
  #onPlayHistoryRecorded: ((res: { items: Song[] }) => void) | null = null;

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
      usePlayerStore.getState().setStatePatch({ isPlaying: true, isLoading: false, playerError: null });
    });

    this.#audio.addEventListener("pause", () => {
      const state = usePlayerStore.getState();
      state.setStatePatch({ isPlaying: false, isLoading: false });
      if (state.hydrated && state.currentTrack) {
        this.#persistRemoteState();
      }
    });

    this.#audio.addEventListener("waiting", () => {
      if (!this.#audio.paused) {
        usePlayerStore.getState().setStatePatch({ isLoading: true });
      }
    });

    this.#audio.addEventListener("ended", () => {
      const { playbackMode, currentTrack } = usePlayerStore.getState();
      if (playbackMode === "repeat-one" && currentTrack) {
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
            if (res.ok) return;
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
      window.addEventListener("pagehide", () => this.#persistRemoteState());
    }
  }

  #cancelFade(): void {
    if (this.#fadeFrameId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.#fadeFrameId);
      this.#fadeFrameId = null;
    }
  }

  #animateVolume(token: number, from: number, to: number, durationMs: number, onDone?: () => void): void {
    this.#cancelFade();
    const clampedFrom = Math.min(1, Math.max(0, from));
    const clampedTo = Math.min(1, Math.max(0, to));
    this.#audio.volume = clampedFrom;

    if (
      durationMs <= 0 ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      this.#audio.volume = clampedTo;
      onDone?.();
      return;
    }

    const startedAt = window.performance.now();
    const step = (now: number) => {
      if (token !== this.#playToken) return;
      const progress = Math.min(1, Math.max(0, (now - startedAt) / durationMs));
      const eased = 1 - (1 - progress) ** 3;
      this.#audio.volume = Math.min(1, Math.max(0, clampedFrom + (clampedTo - clampedFrom) * eased));

      if (progress < 1) {
        this.#fadeFrameId = window.requestAnimationFrame(step);
        return;
      }

      this.#audio.volume = clampedTo;
      this.#fadeFrameId = null;
      onDone?.();
    };

    this.#fadeFrameId = window.requestAnimationFrame(step);
  }

  async #startAudioWithFade(token: number): Promise<void> {
    const targetVolume = usePlayerStore.getState().volume;
    this.#audio.volume = 0;

    try {
      await this.#audio.play();
      if (token !== this.#playToken) return;
      this.#animateVolume(token, 0, targetVolume, FADE_DURATION_MS);
    } catch {
      if (token !== this.#playToken) return;
      this.#audio.volume = targetVolume;
      usePlayerStore.getState().setStatePatch({
        isPlaying: false,
        isLoading: false,
        playerError: "浏览器阻止了自动播放或音频流暂不可用，请点击播放重试。",
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

  #persistRemoteState(): void {
    const state = usePlayerStore.getState();
    if (!state.hydrated) return;
    this.#lastPersistAt = Date.now();
    const { currentTime } = usePlaybackClockStore.getState();
    void api
      .savePlayerState({
        currentTrack: state.currentTrack,
        playQueue: state.queue.slice(0, 200),
        playbackSeconds: Math.floor(currentTime),
        volume: state.volume,
        playbackMode: state.playbackMode,
      })
      .catch(() => undefined);
  }

  hydrate(input: {
    currentTrack: Song | null;
    playQueue: Song[];
    playbackSeconds: number;
    volume: number;
    playbackMode: PlaybackMode;
  }): void {
    const store = usePlayerStore.getState();
    if (store.currentTrack) {
      // Do not clobber user-initiated playback if hydration arrives late
      store.setStatePatch({ hydrated: true });
      return;
    }

    this.#audio.volume = Math.min(1, Math.max(0, input.volume));
    this.#pendingSeek = input.playbackSeconds > 0 ? input.playbackSeconds : null;

    store.setStatePatch({
      currentTrack: input.currentTrack,
      queue: input.playQueue,
      volume: input.volume,
      playbackMode: input.playbackMode,
      hydrated: true,
    });
    usePlaybackClockStore.getState().setClock({
      currentTime: input.playbackSeconds,
      duration: input.currentTrack?.durationSeconds ?? 0,
      bufferedTime: 0,
    });

    if (input.currentTrack) {
      const level = store.defaultPlaybackQuality;
      this.#audio.src = api.buildStreamUrl(input.currentTrack, level);
      this.#updateMediaSession(input.currentTrack);
    }
  }

  async playTrack(
    song: Song,
    options?: { queue?: Song[]; level?: QualityLevel; startAtSeconds?: number },
  ): Promise<void> {
    const token = ++this.#playToken;
    this.#cancelFade();

    const state = usePlayerStore.getState();
    const nextQueue = options?.queue
      ? options.queue
      : state.queue.some((item) => getSongKey(item) === getSongKey(song))
        ? state.queue
        : [...state.queue, song];

    const level = options?.level ?? state.defaultPlaybackQuality;
    this.#pendingSeek = options?.startAtSeconds ?? null;

    state.setStatePatch({
      currentTrack: song,
      queue: nextQueue,
      activeQualityOverride: options?.level ?? null,
      isLoading: true,
      playerError: null,
    });
    usePlaybackClockStore.getState().setClock({
      currentTime: options?.startAtSeconds ?? 0,
      duration: song.durationSeconds,
      bufferedTime: 0,
    });

    this.#audio.src = api.buildStreamUrl(song, level);
    this.#audio.load();
    this.#updateMediaSession(song);
    void api
      .recordPlayHistory(song)
      .then((res) => {
        if (token === this.#playToken) {
          this.#onPlayHistoryRecorded?.(res);
        }
      })
      .catch(() => undefined);
    this.#persistRemoteState();

    await this.#startAudioWithFade(token);
  }

  async switchPlaybackQuality(level: QualityLevel): Promise<void> {
    const { currentTrack } = usePlayerStore.getState();
    if (!currentTrack) return;
    const resumeAt = usePlaybackClockStore.getState().currentTime;
    await this.playTrack(currentTrack, { level, startAtSeconds: resumeAt });
  }

  async togglePlay(): Promise<void> {
    const { currentTrack } = usePlayerStore.getState();
    if (!currentTrack) return;

    if (this.#audio.paused) {
      const token = ++this.#playToken;
      if (!this.#audio.src) {
        const level =
          usePlayerStore.getState().activeQualityOverride ?? usePlayerStore.getState().defaultPlaybackQuality;
        this.#audio.src = api.buildStreamUrl(currentTrack, level);
      }
      await this.#startAudioWithFade(token);
      return;
    }

    const token = ++this.#playToken;
    this.#animateVolume(token, this.#audio.volume, 0, 140, () => {
      if (token !== this.#playToken) return;
      this.#audio.pause();
      this.#audio.volume = usePlayerStore.getState().volume;
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
    this.#cancelFade();
    this.#audio.volume = clamped;
    usePlayerStore.getState().setStatePatch({ volume: clamped });
  }

  cyclePlaybackMode(): void {
    const order: PlaybackMode[] = ["sequential", "shuffle", "repeat-one"];
    const current = usePlayerStore.getState().playbackMode;
    const next = order[(order.indexOf(current) + 1) % order.length] ?? "sequential";
    usePlayerStore.getState().setStatePatch({ playbackMode: next });
    this.#persistRemoteState();
  }

  async playNext(): Promise<void> {
    const { queue, currentTrack, playbackMode } = usePlayerStore.getState();
    if (queue.length === 0) return;

    if (playbackMode === "shuffle" && queue.length > 1) {
      const candidates = queue.filter(
        (item) => !currentTrack || getSongKey(item) !== getSongKey(currentTrack),
      );
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      if (pick) await this.playTrack(pick);
      return;
    }

    const currentIdx = currentTrack
      ? queue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
      : -1;
    for (let step = 1; step <= queue.length; step += 1) {
      const candidate = queue[(currentIdx + step) % queue.length];
      if (candidate && !candidate.availability?.playback.locked) {
        await this.playTrack(candidate);
        return;
      }
    }
    const fallback = queue[(currentIdx + 1) % queue.length];
    if (fallback) await this.playTrack(fallback);
  }

  async playPrevious(): Promise<void> {
    const { queue, currentTrack } = usePlayerStore.getState();
    if (queue.length === 0) return;
    if (usePlaybackClockStore.getState().currentTime > 4) {
      this.seek(0);
      return;
    }

    const currentIdx = currentTrack
      ? queue.findIndex((item) => getSongKey(item) === getSongKey(currentTrack))
      : 0;
    const prevIdx = (currentIdx - 1 + queue.length) % queue.length;
    const target = queue[prevIdx];
    if (target) await this.playTrack(target);
  }

  stop(): void {
    this.#playToken += 1;
    this.#cancelFade();
    this.#pendingSeek = null;
    this.#lastPersistAt = 0;

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
