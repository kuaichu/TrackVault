import { ApiErrorBodySchema, type Song } from "#shared";

export interface HtmlAudioDriverCallbacks {
  onLoadedMetadata: (duration: number) => void;
  onTimeUpdate: (currentTime: number, duration: number | null, bufferedTime: number) => void;
  onPlaying: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onEnded: () => void;
  onError: (failedSrc: string) => void;
}

export async function probeStreamErrorDetail(failedSrc: string): Promise<string | null> {
  if (!failedSrc.includes("/api/media/stream") || typeof fetch !== "function") {
    return null;
  }
  try {
    const res = await fetch(failedSrc, { credentials: "include", headers: { Range: "bytes=0-1" } });
    if (res.ok) {
      void res.body?.cancel();
      return null;
    }
    const raw = await res.json().catch(() => null);
    const parsed = ApiErrorBodySchema.safeParse(raw);
    if (parsed.success) {
      const msg = parsed.data.error.message.trim();
      return msg || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Thin driver encapsulating HTMLAudioElement events, rAF volume fades (with hidden-tab & deadline fallbacks),
 * MediaSession integration, and stream error diagnostics.
 */
export class HtmlAudioDriver {
  readonly #audio: HTMLAudioElement;
  #fadeFrameId: number | null = null;
  #fadeTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #listenersBound = false;

  constructor(audioElement?: HTMLAudioElement) {
    this.#audio = audioElement ?? new Audio();
    this.#audio.preload = "metadata";
  }

  get paused(): boolean {
    return this.#audio.paused;
  }

  get volume(): number {
    return this.#audio.volume;
  }

  get duration(): number {
    return this.#audio.duration;
  }

  get readyState(): number {
    return this.#audio.readyState;
  }

  get hasError(): boolean {
    return Boolean(this.#audio.error);
  }

  get currentSrcOrAttr(): string {
    return this.#audio.getAttribute("src") || this.#audio.src;
  }

  bindEvents(callbacks: HtmlAudioDriverCallbacks): void {
    if (this.#listenersBound) return;
    this.#listenersBound = true;

    this.#audio.addEventListener("loadedmetadata", () => {
      const duration = Number.isFinite(this.#audio.duration) ? this.#audio.duration : 0;
      callbacks.onLoadedMetadata(duration);
    });

    this.#audio.addEventListener("timeupdate", () => {
      const currentTime = Number.isFinite(this.#audio.currentTime) ? this.#audio.currentTime : 0;
      const duration = Number.isFinite(this.#audio.duration) ? this.#audio.duration : null;
      let bufferedTime = 0;
      if (this.#audio.buffered.length > 0) {
        bufferedTime = this.#audio.buffered.end(this.#audio.buffered.length - 1);
      }
      callbacks.onTimeUpdate(currentTime, duration, bufferedTime);
    });

    this.#audio.addEventListener("playing", () => callbacks.onPlaying());
    this.#audio.addEventListener("pause", () => callbacks.onPause());
    this.#audio.addEventListener("waiting", () => callbacks.onWaiting());
    this.#audio.addEventListener("ended", () => callbacks.onEnded());
    this.#audio.addEventListener("error", () => {
      const failedSrc = this.#audio.currentSrc || this.#audio.src;
      callbacks.onError(failedSrc);
    });
  }

  setSrc(url: string, reload = false): void {
    this.#audio.src = url;
    if (reload) {
      this.#audio.load();
    }
  }

  load(): void {
    this.#audio.load();
  }

  play(): Promise<void> {
    return this.#audio.play();
  }

  pause(): void {
    this.#audio.pause();
  }

  setCurrentTime(seconds: number): void {
    this.#audio.currentTime = seconds;
  }

  setVolumeAndMute(volume: number, muted: boolean): void {
    this.#audio.volume = volume;
    this.#audio.muted = muted;
  }

  cancelFade(): void {
    if (this.#fadeFrameId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.#fadeFrameId);
      this.#fadeFrameId = null;
    }
    if (this.#fadeTimeoutId !== null) {
      globalThis.clearTimeout(this.#fadeTimeoutId);
      this.#fadeTimeoutId = null;
    }
  }

  animateVolume(params: {
    from: number;
    to: number;
    durationMs: number;
    isStillValid: () => boolean;
    onDone?: () => void;
  }): void {
    this.cancelFade();
    const clampedFrom = Math.min(1, Math.max(0, params.from));
    const clampedTo = Math.min(1, Math.max(0, params.to));
    this.#audio.volume = clampedFrom;

    const isHidden = typeof document !== "undefined" && Boolean(document.hidden);
    if (
      params.durationMs <= 0 ||
      isHidden ||
      typeof window === "undefined" ||
      typeof window.requestAnimationFrame !== "function"
    ) {
      this.#audio.volume = clampedTo;
      params.onDone?.();
      return;
    }

    const startedAt = Date.now();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      this.cancelFade();
      if (!params.isStillValid()) return;
      this.#audio.volume = clampedTo;
      params.onDone?.();
    };

    // Wall-clock deadline guarantees convergence even if rAF is throttled/paused in a background tab
    this.#fadeTimeoutId = globalThis.setTimeout(finish, params.durationMs + 50);

    const step = () => {
      if (finished) return;
      if (!params.isStillValid()) {
        finished = true;
        this.cancelFade();
        return;
      }
      if (typeof document !== "undefined" && document.hidden) {
        finish();
        return;
      }
      const progress = Math.min(1, Math.max(0, (Date.now() - startedAt) / params.durationMs));
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

  resetElement(): void {
    this.cancelFade();
    this.#audio.pause();
    this.#audio.removeAttribute("src");
    try {
      this.#audio.load();
    } catch {
      // Ignore in test environments where load() is not implemented
    }
    this.#audio.volume = 0.85;
    this.#audio.muted = false;
  }

  updateMediaSession(
    song: Song,
    handlers: {
      onPlay: () => void;
      onPause: () => void;
      onPrevious: () => void;
      onNext: () => void;
    },
  ): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork: song.coverUrl ? [{ src: song.coverUrl, sizes: "512x512", type: "image/jpeg" }] : [],
      });
      navigator.mediaSession.setActionHandler("play", handlers.onPlay);
      navigator.mediaSession.setActionHandler("pause", handlers.onPause);
      navigator.mediaSession.setActionHandler("previoustrack", handlers.onPrevious);
      navigator.mediaSession.setActionHandler("nexttrack", handlers.onNext);
    } catch {
      // Ignore MediaSession errors on unsupported platforms
    }
  }

  clearMediaSession(): void {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
    } catch {
      // Ignore MediaSession errors on unsupported platforms
    }
  }
}
