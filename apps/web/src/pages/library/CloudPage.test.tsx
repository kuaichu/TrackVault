import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { audioEngine, usePlayerStore } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import { useToastStore } from "../../shared/store/toast-store.js";
import { CloudPage } from "./CloudAndHistoryPage.js";

function makeCloudSong(id: string): Song {
  return {
    id,
    platform: "netease",
    title: `云盘曲 ${id}`,
    artist: "歌手",
    album: "专辑",
    durationSeconds: 200,
    duration: "03:20",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
    isCloud: true,
  };
}

describe("CloudPage · P1-4 engine-owned Play All survives route unmount", () => {
  beforeEach(() => {
    audioEngine.stop();
    usePlayerStore.getState().reset();
    useToastStore.getState().clear();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({
      settings: {
        providerMode: "netease",
        defaultPlaybackQuality: "exhigh",
        defaultDownloadQuality: "lossless",
        maxConcurrentDownloads: 2,
        startupView: "discover",
      },
    });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "savePlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });
  });

  afterEach(() => {
    audioEngine.stop();
    cleanup();
    vi.restoreAllMocks();
  });

  it("continues paginating and enqueuing all cloud songs even after CloudPage unmounts immediately", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let releasePage2!: () => void;

    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) {
        return {
          songs: [makeCloudSong("c-1")],
          total: 2,
          offset: 0,
          nextOffset: 100,
          limit: 100,
          hasMore: true,
        };
      }
      await new Promise<void>((resolve) => {
        releasePage2 = resolve;
      });
      return {
        songs: [makeCloudSong("c-2")],
        total: 2,
        offset: 100,
        nextOffset: 101,
        limit: 100,
        hasMore: false,
      };
    });

    const playSpy = vi.spyOn(audioEngine, "playTrack");

    const view = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <CloudPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "播放全部" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    expect(usePlayerStore.getState().cloudPlayAllLoading).toBe(true);

    // Simulate navigating away from /cloud before page 2 resolves
    view.unmount();

    await act(async () => {
      releasePage2();
    });

    await waitFor(() => {
      expect(playSpy).toHaveBeenCalledTimes(1);
    });
    expect(playSpy.mock.calls[0]?.[0].id).toBe("c-1");
    expect(playSpy.mock.calls[0]?.[1]?.queue?.map((s) => s.id)).toEqual(["c-1", "c-2"]);
    expect(usePlayerStore.getState().cloudPlayAllLoading).toBe(false);
  });
});
