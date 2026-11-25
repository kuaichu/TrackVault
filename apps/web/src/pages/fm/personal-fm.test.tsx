import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import {
  AudioEngine,
  audioEngine,
  usePlaybackClockStore,
  usePlayerStore,
} from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import {
  createControlledAudio,
  makeTestSettings,
  makeTestSong,
  renderWithProviders,
} from "../../test-utils/fixtures.js";
import { PersonalFmPage } from "./index.js";

describe("Personal FM playback, lyric synchronization, and quality retention", () => {
  const engines: AudioEngine[] = [];

  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeTestSettings() });
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => ({ state }));
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      lyrics: {
        songId: "fm-a",
        platform: "netease",
        source: "netease_new",
        lines: [
          { time: 10, text: "第一句歌词" },
          { time: 56, text: "第五十六秒歌词" },
        ],
      },
    });
  });

  afterEach(() => {
    for (const eng of engines.splice(0)) {
      eng.dispose();
    }
    vi.restoreAllMocks();
  });

  it("does not highlight unplayed FM candidate lyrics with another track's playback clock", async () => {
    const fmA = makeTestSong("fm-a", { title: "FM Song A" });
    const otherSong = makeTestSong("other-x", { title: "Normal Song X" });

    vi.spyOn(api, "getPersonalFm").mockResolvedValueOnce({ songs: [fmA] });

    usePlayerStore.setState({ currentTrack: otherSong, isPlaying: true, fmMode: false });
    usePlaybackClockStore.getState().setClock({ currentTime: 56, duration: 200 });

    renderWithProviders(<PersonalFmPage />);

    const line56 = await screen.findByText("第五十六秒歌词");
    expect(line56.closest("button")?.className).not.toContain("scale-[1.02]");
  });

  it("starts FM track and seeks to clicked timestamp when clicking an unplayed FM lyric line", async () => {
    const fmA = makeTestSong("fm-a", { title: "FM Song A" });
    const fmB = makeTestSong("fm-b", { title: "FM Song B" });
    const otherSong = makeTestSong("other-x", { title: "Normal Song X" });

    vi.spyOn(api, "getPersonalFm").mockResolvedValueOnce({ songs: [fmA, fmB] });
    usePlayerStore.setState({ currentTrack: otherSong, isPlaying: true, fmMode: false });
    usePlaybackClockStore.getState().setClock({ currentTime: 56, duration: 200 });

    const seekSpy = vi.spyOn(audioEngine, "seek");
    const playFmSpy = vi.spyOn(audioEngine, "playFmTrack");

    renderWithProviders(<PersonalFmPage />);

    const line56 = await screen.findByText("第五十六秒歌词");
    fireEvent.click(line56);

    expect(seekSpy).not.toHaveBeenCalled();
    expect(playFmSpy).toHaveBeenCalledWith(fmA, { queue: [fmA, fmB], startAtSeconds: 56 });
    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-a");
      expect(usePlayerStore.getState().fmMode).toBe(true);
    });
  });

  it("syncs PersonalFmPage with AudioEngine auto-advance and fetches the next FM batch", async () => {
    const fmA = makeTestSong("fm-a", { title: "FM Song A" });
    const fmB = makeTestSong("fm-b", { title: "FM Song B" });
    const fmC = makeTestSong("fm-c", { title: "FM Song C" });

    const fmSpy = vi
      .spyOn(api, "getPersonalFm")
      .mockResolvedValueOnce({ songs: [fmA, fmB] })
      .mockResolvedValueOnce({ songs: [fmC] });

    renderWithProviders(<PersonalFmPage />);

    await waitFor(() => expect(screen.getByText("FM Song A")).toBeInTheDocument());
    await act(async () => {
      await audioEngine.playFmTrack(fmA, { queue: [fmA, fmB] });
    });

    await act(async () => {
      await audioEngine.playNext();
    });
    expect(screen.getByText("FM Song B")).toBeInTheDocument();

    await act(async () => {
      await audioEngine.playNext();
    });
    await waitFor(() => {
      expect(fmSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByText("FM Song C")).toBeInTheDocument();
    });
  });

  it("aborts in-flight FM fetch when a normal track starts playing", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFm: ((res: { songs: Song[] }) => void) | undefined;
    vi.spyOn(api, "getPersonalFm").mockImplementationOnce((signal) => {
      capturedSignal = signal;
      return new Promise((resolve) => {
        resolveFm = resolve;
      });
    });

    const fmLoadPromise = audioEngine.loadFmBatch({ autoPlay: true });
    const normalSong = makeTestSong("normal-1", { title: "User Chosen Song" });
    await audioEngine.playTrack(normalSong);

    expect(capturedSignal?.aborted).toBe(true);
    resolveFm?.({ songs: [makeTestSong("stale-fm", { title: "Stale FM" })] });
    await fmLoadPromise;

    expect(usePlayerStore.getState().currentTrack?.id).toBe("normal-1");
    expect(usePlayerStore.getState().fmMode).toBe(false);
  });

  it("cancels page-initiated FM fetch on unmount without interrupting active FM playback", async () => {
    const activeFm = makeTestSong("fm-active", { title: "正在漫游A" });
    await audioEngine.playFmTrack(activeFm, { queue: [activeFm] });

    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(api, "getPersonalFm").mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          capturedSignal = signal;
          setTimeout(() => resolve({ songs: [makeTestSong("fm-hijack")] }), 200);
        }),
    );

    const view = renderWithProviders(<PersonalFmPage />);
    fireEvent.click(screen.getByRole("button", { name: "换一批" }));
    expect(capturedSignal?.aborted).toBe(false);

    view.unmount();
    expect(capturedSignal?.aborted).toBe(true);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-active");
  });

  it("prioritizes priorityQueue before FM queue, resumes FM cursor after detour, and keeps fmMode on playPrevious under 4s", async () => {
    const { audio } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const fmA = makeTestSong("fm-A");
    const fmB = makeTestSong("fm-B");
    const fmC = makeTestSong("fm-C");
    const prioP = makeTestSong("prio-P");

    usePlayerStore.setState({ fmQueue: [fmA, fmB, fmC] });
    await engine.playFmTrack(fmB, { queue: [fmA, fmB, fmC] });

    usePlaybackClockStore.getState().setClock({ currentTime: 2 });
    await engine.playPrevious();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-A");
    expect(usePlayerStore.getState().fmMode).toBe(true);

    await engine.playFmTrack(fmB, { queue: [fmA, fmB, fmC] });
    engine.insertNextInQueue(prioP);
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("prio-P");

    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-C");
  });

  it("PersonalFmPage '下一首' button honors priorityQueue via audioEngine.playNext", () => {
    const fmA = makeTestSong("fm-A");
    const fmB = makeTestSong("fm-B");
    const prioP = makeTestSong("prio-P");
    const pageNextSpy = vi.spyOn(audioEngine, "playNext").mockResolvedValue(undefined);

    usePlayerStore.setState({
      fmMode: true,
      currentTrack: fmA,
      fmQueue: [fmA, fmB],
      priorityQueue: [prioP],
    });

    renderWithProviders(<PersonalFmPage />);
    fireEvent.click(screen.getByRole("button", { name: "下一首" }));

    expect(pageNextSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves chosen lossless quality across natural FM batch-end reload without replaying ended track", async () => {
    const { audio, playSpy, setPaused } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const fmC = makeTestSong("fm-C");
    const fmNext1 = makeTestSong("fm-next-1");
    let resolveNextFmBatch: ((res: { songs: Song[] }) => void) | undefined;

    vi.spyOn(api, "getPersonalFm").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNextFmBatch = resolve;
        }),
    );

    usePlayerStore.setState({ fmQueue: [fmC] });
    await engine.playFmTrack(fmC, { queue: [fmC] });
    playSpy.mockClear();

    setPaused(true);
    audio.dispatchEvent(new Event("pause"));
    audio.dispatchEvent(new Event("ended"));

    await engine.switchPlaybackQuality("lossless");
    expect(playSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveNextFmBatch?.({ songs: [fmNext1] });
    });

    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-next-1");
    });
    expect(audio.src).toContain("level=lossless");
  });

  it("preserves chosen lossless quality on manual FM tail skip and recovers after 503 batch error", async () => {
    const { audio: fmAudio } = createControlledAudio();
    const fmEngine = new AudioEngine(fmAudio);
    engines.push(fmEngine);

    usePlayerStore.getState().setStatePatch({ defaultPlaybackQuality: "standard" });
    let fmBatchCalls = 0;
    let rejectBatch2: ((err: Error) => void) | undefined;

    vi.spyOn(api, "getPersonalFm").mockImplementation(() => {
      fmBatchCalls += 1;
      if (fmBatchCalls === 1) return Promise.resolve({ songs: [makeTestSong("fm-r1")] });
      if (fmBatchCalls === 2) {
        return new Promise((_, reject) => {
          rejectBatch2 = reject;
        });
      }
      return Promise.resolve({ songs: [makeTestSong("fm-r2")] });
    });

    await fmEngine.loadFmBatch({ autoPlay: true });
    const nextAttempt = fmEngine.playNext();
    await waitFor(() => expect(fmBatchCalls).toBe(2));

    await fmEngine.switchPlaybackQuality("lossless");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-r1");

    await act(async () => {
      rejectBatch2?.(new Error("503 batch error"));
      await nextAttempt;
    });

    expect(usePlayerStore.getState().loadedStreamQuality).toBe("standard");
    expect(usePlayerStore.getState().preferredTrackQuality).toBe("lossless");

    await fmEngine.playNext();
    await waitFor(() => expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-r2"));
    expect(fmAudio.src).toContain("level=lossless");
    expect(usePlayerStore.getState().loadedStreamQuality).toBe("lossless");
  });
});
