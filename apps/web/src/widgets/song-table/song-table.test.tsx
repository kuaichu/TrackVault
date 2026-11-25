import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { useDownloadModeStore } from "../../features/downloads/index.js";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import { SongTable } from "./SongTable.js";

function makeSong(index: number): Song {
  return {
    id: `song-${index}`,
    platform: "netease",
    title: `Track ${index}`,
    artist: "Artist",
    album: "Album",
    durationSeconds: 200,
    duration: "03:20",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "lossless", label: "FLAC" },
    ],
  };
}

describe("SongTable · Virtualization, single-instance Portal menu, and persistent downloadMode", () => {
  beforeEach(() => {
    useDownloadModeStore.getState().reset();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "getSettings").mockResolvedValue({
      settings: {
        providerMode: "netease",
        defaultPlaybackQuality: "exhigh",
        defaultDownloadQuality: "lossless",
        maxConcurrentDownloads: 2,
        startupView: "discover",
      },
    });
  });

  afterEach(() => {
    cleanup();
    useDownloadModeStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("mounts only a bounded window of rows for 3,000 songs in JSDOM and updates window on scroll when viewport is sized", () => {
    const songs = Array.from({ length: 3000 }, (_, i) => makeSong(i + 1));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container, unmount } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const mountedRows = container.querySelectorAll("[data-song-row]");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThanOrEqual(80);
    expect(screen.getByText("3000 首曲目")).toBeInTheDocument();
    expect(screen.getByText("Track 1")).toBeInTheDocument();
    expect(screen.queryByText("Track 2500")).toBeNull();
    unmount();

    // Verify scroll-driven window update inside a sized scrollable container
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    Object.defineProperty(scrollContainer, "clientHeight", { configurable: true, value: 580 });
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      writable: true,
      value: 0,
    });
    document.body.appendChild(scrollContainer);

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
      { container: scrollContainer },
    );

    // At scrollTop=0 with 580px viewport (~10 visible + 10 overscan = ~20 rows)
    expect(scrollContainer.querySelectorAll("[data-song-row]").length).toBeLessThan(40);
    expect(screen.getByText("Track 1")).toBeInTheDocument();

    // Scroll deep down to ~row 1000
    act(() => {
      scrollContainer.scrollTop = 58 * 1000;
      fireEvent.scroll(scrollContainer);
    });

    expect(scrollContainer.querySelectorAll("[data-song-row]").length).toBeLessThan(40);
    expect(screen.queryByText("Track 1")).toBeNull();
    expect(screen.getByText("Track 1001")).toBeInTheDocument();

    scrollContainer.remove();
  });

  it("preserves downloadMode preference across unmount/remount and renders single-instance portal menu", async () => {
    const songs = [makeSong(1), makeSong(2)];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const createJobSpy = vi.spyOn(api, "createDownloadJob").mockResolvedValue({
      job: {
        id: "dl-1",
        kind: "download",
        status: "queued",
        progress: 0,
        title: "Track 1",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    const firstMount = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "直链下载" }));
    expect(useDownloadModeStore.getState().downloadMode).toBe("direct_link");

    // Unmount and remount (simulating route/tab switch)
    firstMount.unmount();

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // downloadMode remains direct_link and quick-download uses direct_link
    fireEvent.click(screen.getByRole("button", { name: "下载 Track 1" }));
    await waitFor(() => {
      expect(createJobSpy).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "direct_link", song: songs[0] }),
      );
    });

    // Single-instance portal menu in document.body
    const firstMoreBtn = screen.getAllByRole("button", { name: "更多操作" })[0];
    if (!firstMoreBtn) throw new Error("Expected more button");
    fireEvent.click(firstMoreBtn);
    expect(document.body.querySelectorAll("[data-song-portal-menu='true']")).toHaveLength(1);
  });
});
