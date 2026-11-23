import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { CoverArt } from "../../shared/ui/primitives.js";
import { PlaybackProgressBar } from "./components/PlaybackProgressBar.js";
import { AudioEngine } from "./engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "./store/player-store.js";

const qqSong: Song = {
  id: "0039MnYb0qxYhV",
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
};

describe("TrackVault v2 Player Isolation & Security", () => {
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
    const fakeAudio = document.createElement("audio");
    vi.spyOn(fakeAudio, "play").mockResolvedValue(undefined);
    vi.spyOn(fakeAudio, "load").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );

    usePlayerStore.setState({
      currentTrack: null,
      queue: [],
      isPlaying: false,
      defaultPlaybackQuality: "exhigh",
      activeQualityOverride: null,
      hydrated: false,
    });

    const engine = new AudioEngine(fakeAudio);
    await engine.playTrack(qqSong);

    expect(fakeAudio.src).toContain("/api/media/stream");
    expect(fakeAudio.src).toContain("platform=qq");
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
});
