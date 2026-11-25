import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerState, Song } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../../shared/hooks/use-capabilities.js";
import { createControlledAudio, makeTestSong, renderWithProviders } from "../../../test-utils/fixtures.js";
import { PlayerBar } from "../components/PlayerBar.js";
import { RightDrawer } from "../components/RightDrawer.js";
import { usePlaybackClockStore, usePlayerStore } from "../store/player-store.js";
import { AudioEngine } from "./audio-engine.js";

describe("AudioEngine state invariants, mute persistence, and locked-queue guards", () => {
  const engines: AudioEngine[] = [];

  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => ({ state }));
    vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    for (const eng of engines.splice(0)) {
      eng.dispose();
    }
    vi.restoreAllMocks();
  });

  it("persists muted state and lastNonZeroVolume so unmuting after hydrate restores 10% volume", async () => {
    const { audio } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const savedStates: PlayerState[] = [];
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => {
      savedStates.push(state);
      return { state };
    });

    usePlayerStore.setState({ hydrated: true });
    engine.setVolume(0.1);
    engine.toggleMute();
    await engine.playTrack(makeTestSong("m1"));

    const savedState = savedStates.at(-1);
    if (!savedState) throw new Error("Expected saved player state");
    expect(savedState.muted).toBe(true);
    expect(savedState.lastNonZeroVolume).toBe(0.1);

    engine.stop();
    engine.hydrate(savedState);
    expect(usePlayerStore.getState().muted).toBe(true);

    engine.toggleMute();
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.1, 5);
  });

  it("does not drop in-flight recordPlayHistory notification when pausing immediately after playing", async () => {
    const { audio } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    let resolveHistory: ((res: { items: Song[] }) => void) | undefined;
    vi.spyOn(api, "recordPlayHistory").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
    );

    const historyNotifications: Song[][] = [];
    engine.setPlayHistoryListener((res) => historyNotifications.push(res.items));

    const songA = makeTestSong("a1", { title: "历史曲A" });
    await engine.playTrack(songA);
    audio.dispatchEvent(new Event("playing"));
    await engine.togglePlay();

    resolveHistory?.({ items: [songA] });
    await Promise.resolve();

    expect(historyNotifications).toHaveLength(1);
    expect(historyNotifications[0]?.[0]?.id).toBe("a1");
  });

  it("keeps playing and records play history once when switching quality during initial track load", async () => {
    const { audio, playSpy } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const recordSpy = vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
    const songB = makeTestSong("b1", { title: "切音质曲B" });

    await engine.playTrack(songB);
    usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: true });
    await engine.switchPlaybackQuality("lossless");

    expect(audio.src).toContain("level=lossless");
    expect(playSpy).toHaveBeenCalledTimes(2);

    audio.dispatchEvent(new Event("playing"));
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(songB);
  });

  it("clears priorityQueue when playTrack replaces queue with a new list", async () => {
    const { audio } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    engine.insertNextInQueue(makeTestSong("stale-prio"));
    const firstNew = makeTestSong("nl-1");
    await engine.playTrack(firstNew, { queue: [firstNew, makeTestSong("nl-2")] });

    expect(usePlayerStore.getState().priorityQueue).toEqual([]);
  });

  it("never starts playback on all-locked queue and keeps PlayerBar play button disabled", async () => {
    const { audio, playSpy } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const lockedOnly = [
      makeTestSong("lk-1", {
        availability: {
          playback: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
          download: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
        },
      }),
    ];
    usePlayerStore.setState({ queue: lockedOnly, currentTrack: null });
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });

    await engine.togglePlay();
    await engine.playNext();
    await engine.playPrevious();
    expect(playSpy).not.toHaveBeenCalled();

    renderWithProviders(
      <>
        <PlayerBar />
        <RightDrawer />
      </>,
    );
    expect(screen.getAllByRole("button", { name: "播放" })[0]).toBeDisabled();
  });

  it("keeps isPlaying synchronized with active audio when removing playing track leaves only locked tracks", async () => {
    const { audio } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    const songA = makeTestSong("p10-a");
    const lockedB = makeTestSong("p10-b", {
      availability: {
        playback: { status: "vip", locked: true, label: "VIP", reason: "VIP" },
        download: { status: "vip", locked: true, label: "VIP", reason: "VIP" },
      },
    });

    await engine.playTrack(songA, { queue: [songA, lockedB] });
    audio.dispatchEvent(new Event("playing"));
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    engine.removeFromQueue("netease:p10-a");
    await engine.playNext();

    expect(audio.paused).toBe(false);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });
});
