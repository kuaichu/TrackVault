import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerState, Song } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { CoverArt } from "../../shared/ui/primitives.js";
import { PlaybackProgressBar } from "./components/PlaybackProgressBar.js";
import { PlayerBar } from "./components/PlayerBar.js";
import {
  AudioEngine,
  KEEPALIVE_MAX_BYTES,
  buildBoundedKeepalivePlayerState,
  resolveEffectivePlaybackQuality,
  serializeQueueWindow,
} from "./engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "./store/player-store.js";

function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    platform: "netease",
    title: `Track ${id}`,
    artist: "Artist",
    album: "Album",
    durationSeconds: 240,
    duration: "04:00",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "higher", label: "192K" },
      { level: "exhigh", label: "320K" },
      { level: "lossless", label: "FLAC" },
    ],
    ...overrides,
  };
}

const qqSong: Song = makeSong("0039MnYb0qxYhV", {
  platform: "qq",
  title: "晴天",
  artist: "周杰伦",
  album: "叶惠美",
  durationSeconds: 269,
  duration: "04:29",
  quality: "FLAC",
  availableQualities: [
    { level: "standard", label: "128K" },
    { level: "lossless", label: "FLAC" },
  ],
});

function createControlledAudio() {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperty(audio, "paused", {
    configurable: true,
    get: () => paused,
  });
  const playSpy = vi.spyOn(audio, "play").mockImplementation(async () => {
    paused = false;
  });
  const pauseSpy = vi.spyOn(audio, "pause").mockImplementation(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  const loadSpy = vi.spyOn(audio, "load").mockImplementation(() => undefined);
  return {
    audio,
    playSpy,
    pauseSpy,
    loadSpy,
    setPaused: (v: boolean) => {
      paused = v;
    },
  };
}

describe("TrackVault v2 Player Isolation & Security", () => {
  const createdEngines: AudioEngine[] = [];

  beforeEach(() => {
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
  });

  afterEach(() => {
    for (const engine of createdEngines.splice(0)) {
      engine.dispose();
    }
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  function trackEngine(audio: HTMLAudioElement): AudioEngine {
    const engine = new AudioEngine(audio);
    createdEngines.push(engine);
    return engine;
  }

  it("keeps parent shell at 0 extra re-renders during 4Hz playback clock ticks", () => {
    let shellRenderCount = 0;

    function MockShell() {
      shellRenderCount += 1;
      const trackTitle = usePlayerStore((s) => s.currentTrack?.title ?? "idle");
      return (
        <div>
          <span data-testid="shell-title">{trackTitle}</span>
          <PlaybackProgressBar />
        </div>
      );
    }

    render(<MockShell />);
    expect(shellRenderCount).toBe(1);

    act(() => {
      for (let sec = 1; sec <= 50; sec += 1) {
        usePlaybackClockStore
          .getState()
          .setClock({ currentTime: sec, duration: 240, bufferedTime: sec + 10 });
      }
    });

    // Shell subscribed only to low-frequency usePlayerStore must NOT re-render
    expect(shellRenderCount).toBe(1);
    expect(screen.getByText("00:50")).toBeInTheDocument();
  });

  it("AudioEngine plays QQ tracks, preserves repeat-one, and ignores late hydration", async () => {
    const { audio } = createControlledAudio();
    vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
    vi.spyOn(api, "savePlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });

    const engine = trackEngine(audio);
    await engine.playTrack(qqSong);

    expect(audio.src).toContain("/api/media/stream");
    expect(audio.src).toContain("platform=qq");
    expect(usePlayerStore.getState().currentTrack?.id).toBe(qqSong.id);

    // Late hydration must NOT overwrite user-selected track
    engine.hydrate({
      currentTrack: { ...qqSong, id: "old-track", title: "Old Track" },
      playQueue: [],
      playbackSeconds: 42,
      volume: 0.5,
      playbackMode: "sequential",
    });
    expect(usePlayerStore.getState().currentTrack?.id).toBe(qqSong.id);
  });

  it("CoverArt blocks javascript: protocol URLs", () => {
    render(<CoverArt src="javascript:alert(1)" alt="cover" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("converges fade-in immediately when document.hidden is true and via wall-clock fallback when rAF stalls (P02)", async () => {
    vi.useFakeTimers();
    const { audio } = createControlledAudio();
    const engine = trackEngine(audio);

    // 1) Hidden tab: fade-in converges immediately without waiting for rAF
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    await engine.playTrack(makeSong("hidden-1"));
    expect(audio.volume).toBe(0.85);

    // 2) Visible tab with frozen rAF: wall-clock timeout converges pause cleanly
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await engine.togglePlay(); // initiates 140ms pause fade
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    vi.advanceTimersByTime(250);
    expect(audio.paused).toBe(true);
    expect(audio.volume).toBe(0.85);
  });

  it("respects #volumeRevision when user mutes during play() loading so fade-in never restores old volume (P03)", async () => {
    const { audio, playSpy } = createControlledAudio();
    let resolvePlay!: () => void;
    playSpy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePlay = resolve;
        }),
    );

    const engine = trackEngine(audio);
    const playPromise = engine.playTrack(makeSong("mute-during-load"));

    // User mutes while audio.play() is still pending
    engine.toggleMute();
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(usePlayerStore.getState().volume).toBe(0);

    resolvePlay();
    await playPromise;

    expect(audio.volume).toBe(0);
    expect(audio.muted).toBe(true);
  });

  it("guards pause fade window against volume changes and double-click togglePlay (#pendingPause, P04/C058)", async () => {
    vi.useFakeTimers();
    const { audio, pauseSpy } = createControlledAudio();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const engine = trackEngine(audio);

    await engine.playTrack(makeSong("race-1"));
    audio.dispatchEvent(new Event("playing"));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    // Pause -> immediately adjust volume during 140ms fade-out -> pause MUST still execute
    await engine.togglePlay();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    // Spurious 'playing' event during pending pause must NOT bounce isPlaying back to true
    audio.dispatchEvent(new Event("playing"));
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    engine.setVolume(0.3);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(true);
    expect(audio.volume).toBe(0.3);

    // Now play again, click pause, then click play again within 140ms -> must resume cleanly
    await engine.togglePlay();
    audio.dispatchEvent(new Event("playing"));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    await engine.togglePlay(); // starts pending pause
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    await engine.togglePlay(); // resumes immediately
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    vi.advanceTimersByTime(300);
    expect(audio.paused).toBe(false);
  });

  it("toggleMute preserves and restores lastNonZeroVolume and syncs with slider-to-zero (U09/P12)", () => {
    const { audio } = createControlledAudio();
    const engine = trackEngine(audio);

    engine.setVolume(0.12);
    expect(usePlayerStore.getState().lastNonZeroVolume).toBe(0.12);
    expect(usePlayerStore.getState().muted).toBe(false);

    engine.toggleMute();
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(usePlayerStore.getState().volume).toBe(0);
    expect(audio.volume).toBe(0);

    engine.toggleMute();
    expect(usePlayerStore.getState().muted).toBe(false);
    expect(usePlayerStore.getState().volume).toBe(0.12);
    expect(audio.volume).toBe(0.12);

    // Dragging slider to 0 sets muted: true while remembering 0.12
    engine.setVolume(0);
    expect(usePlayerStore.getState().muted).toBe(true);
    engine.toggleMute();
    expect(usePlayerStore.getState().volume).toBe(0.12);
  });

  it("serializeQueueWindow keeps track #201 centered and buildBoundedKeepalivePlayerState enforces <= 58 KiB (P18/C062)", () => {
    const longQueue = Array.from({ length: 205 }, (_, i) =>
      makeSong(`s-${i + 1}`, {
        title: `Song ${i + 1} ${"x".repeat(250)}`,
        artist: `Artist ${"y".repeat(120)}`,
      }),
    );
    const track201 = longQueue[200];
    if (!track201) throw new Error("Expected track 201");

    const window200 = serializeQueueWindow(longQueue, track201, 200);
    expect(window200).toHaveLength(200);
    expect(window200.some((s) => s.id === track201.id)).toBe(true);
    expect(window200[window200.length - 1]?.id).toBe("s-205");

    const fullState: PlayerState = {
      currentTrack: track201,
      playQueue: window200,
      playbackSeconds: 15,
      volume: 0.8,
      playbackMode: "sequential",
    };
    const rawBytes = new TextEncoder().encode(JSON.stringify(fullState)).byteLength;
    expect(rawBytes).toBeGreaterThan(KEEPALIVE_MAX_BYTES);

    const bounded = buildBoundedKeepalivePlayerState(fullState);
    const boundedBytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
    expect(boundedBytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(boundedBytes).toBeLessThan(64 * 1024);
    expect(bounded.currentTrack?.id).toBe(track201.id);
    expect(bounded.playQueue.length).toBeGreaterThan(0);
    expect(bounded.playQueue.some((s) => s.id === track201.id)).toBe(true);
  });

  it("persists volume/queue mutations with debounce and uses keepalive on pagehide (B55/C062)", () => {
    vi.useFakeTimers();
    const { audio } = createControlledAudio();
    const saveSpy = vi.spyOn(api, "savePlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.5,
        playbackMode: "sequential",
      },
    });

    const engine = trackEngine(audio);
    const s1 = makeSong("p-1");
    engine.hydrate({
      currentTrack: s1,
      playQueue: [s1],
      playbackSeconds: 0,
      volume: 0.8,
      playbackMode: "sequential",
    });

    engine.setVolume(0.45);
    engine.addToQueue(makeSong("p-2"));
    expect(saveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(450);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0]?.[0].volume).toBe(0.45);
    expect(saveSpy.mock.calls[0]?.[0].playQueue).toHaveLength(2);

    saveSpy.mockClear();
    window.dispatchEvent(new Event("pagehide"));
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTrack: s1,
        volume: 0.45,
      }),
      { keepalive: true },
    );
  });

  it("records play history ONLY once on first 'playing' event and notifies playHistoryListener (P19/F14)", async () => {
    const { audio } = createControlledAudio();
    const song = makeSong("hist-1");
    const recordSpy = vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [song] });
    const listener = vi.fn();

    const engine = trackEngine(audio);
    engine.setPlayHistoryListener(listener);

    await engine.playTrack(song);
    // Before 'playing' fires (e.g. failed or still buffering), history must NOT be recorded
    expect(recordSpy).not.toHaveBeenCalled();

    // First 'playing' event records history once and notifies active session listener
    audio.dispatchEvent(new Event("playing"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ items: [song] });

    // Subsequent playing events (after seek or pause/resume) must NOT duplicate history
    engine.seek(30);
    audio.dispatchEvent(new Event("playing"));
    await engine.togglePlay();
    await engine.togglePlay();
    audio.dispatchEvent(new Event("playing"));
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it("prioritizes priorityQueue in shuffle, skips locked tracks in shuffle/prev, and handles removed track modulo (P10/P11/C061)", async () => {
    const { audio } = createControlledAudio();
    const engine = trackEngine(audio);

    const a = makeSong("a");
    const locked = makeSong("locked", {
      availability: {
        playback: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
        download: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
      },
    });
    const b = makeSong("b");
    const c = makeSong("c");

    usePlayerStore.setState({
      currentTrack: a,
      queue: [a, locked, c],
      playbackMode: "shuffle",
    });

    // Insert B as Play Next -> in shuffle mode, playNext MUST play B first
    engine.insertNextInQueue(b);
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");

    // Next shuffle picks must skip locked track
    vi.spyOn(Math, "random").mockReturnValue(0);
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).not.toBe("locked");

    // playPrevious skips locked track too
    usePlayerStore.setState({ currentTrack: c, queue: [a, locked, c] });
    usePlaybackClockStore.getState().setClock({ currentTime: 1 });
    await engine.playPrevious();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");

    // Edge case: currentTrack removed from 1-item queue -> positive modulo selects queue[0]
    usePlayerStore.setState({ currentTrack: c, queue: [a] });
    usePlaybackClockStore.getState().setClock({ currentTime: 0 });
    await engine.playPrevious();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });

  it("preserves pause state without recording history on paused quality switch, reloads on error retry, and cancels ok diagnostic body (P12/P13/C062)", async () => {
    const { audio, playSpy, loadSpy } = createControlledAudio();
    const recordSpy = vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
    const engine = trackEngine(audio);
    const song = makeSong("q-1");

    engine.hydrate({
      currentTrack: song,
      playQueue: [song],
      playbackSeconds: 20,
      volume: 0.8,
      playbackMode: "sequential",
    });

    // Hydrate vs settings race: syncDefaultPlaybackQuality updates paused src
    engine.syncDefaultPlaybackQuality("hires");
    expect(audio.src).toContain("level=hires");

    // Paused quality switch keeps paused state, updates src, and does NOT call play() or recordPlayHistory()
    await engine.switchPlaybackQuality("lossless");
    expect(playSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    expect(audio.src).toContain("level=lossless");
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    // Error event diagnostic fetch cancels body on res.ok
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: { cancel: cancelSpy },
    } as unknown as Response);
    audio.dispatchEvent(new Event("error"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().playerError).toBeTruthy();

    // Retry after error calls load() again and preserves error reason if play() still rejects
    loadSpy.mockClear();
    playSpy.mockRejectedValueOnce(new Error("NotSupportedError"));
    await engine.togglePlay();
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().playerError).toContain("音频加载失败");
  });

  it("enables Play/Next when queue is non-empty without currentTrack, disables idle progress slider, and renders accurate quality badge (P14/C072/C075)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const lowQualitySong = makeSong("low-1", {
      availableQualities: [
        { level: "standard", label: "128K" },
        { level: "higher", label: "192K" },
      ],
    });

    // Effective quality badge caps at track's highest available <= requested (never exaggerates Hi-Res)
    expect(resolveEffectivePlaybackQuality(lowQualitySong, null, "hires")).toBe("higher");
    expect(resolveEffectivePlaybackQuality(lowQualitySong, "standard", "hires")).toBe("standard");

    // Idle progress bar slider is disabled when no track or duration === 0
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("播放进度")).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "播放" })[0]).toBeDisabled();

    // Queue non-empty without currentTrack enables Play & Next controls
    act(() => {
      usePlayerStore.setState({ queue: [lowQualitySong], currentTrack: null });
    });
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("button", { name: "播放" })[0]).not.toBeDisabled();
    expect(screen.getAllByRole("button", { name: "下一首" })[0]).not.toBeDisabled();

    // Active track with default hires displays 192K badge (not Hi-Res) and supports 100:00+ formatting
    act(() => {
      usePlayerStore.setState({ currentTrack: lowQualitySong, defaultPlaybackQuality: "hires" });
      usePlaybackClockStore.getState().setClock({ currentTime: 6125, duration: 7200, bufferedTime: 7200 });
    });
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTitle("切换试听音质")).toHaveTextContent("192K");
    expect(screen.getByText("102:05")).toBeInTheDocument();
    expect(screen.getByText("120:00")).toBeInTheDocument();
    expect(screen.getByTitle("列表循环")).toBeInTheDocument();

    // Clicking mode cycles smoothly
    fireEvent.click(screen.getByTitle("列表循环"));
    expect(usePlayerStore.getState().playbackMode).toBe("shuffle");
  });
});
