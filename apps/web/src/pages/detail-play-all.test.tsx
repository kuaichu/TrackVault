import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { audioEngine, usePlayerStore } from "../features/player/index.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import { AlbumDetailPage } from "./album/index.js";
import { ArtistDetailPage } from "./artist/index.js";
import { ChartDetailPage } from "./charts/index.js";
import { PlaylistDetailPage } from "./library/index.js";

function makeSong(id: string, locked = false): Song {
  return {
    id,
    platform: "netease",
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    durationSeconds: 200,
    duration: "03:20",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
    ...(locked
      ? {
          availability: {
            playback: { status: "vip", locked: true, label: "VIP", reason: "仅限会员" },
            download: { status: "vip", locked: true, label: "VIP", reason: "仅限会员" },
          },
        }
      : {}),
  };
}

describe("Detail pages Play All · skips locked leading tracks", () => {
  const lockedSong = makeSong("locked-1", true);
  const playableSong = makeSong("playable-2", false);
  const songs = [lockedSong, playableSong];

  beforeEach(() => {
    usePlayerStore.getState().reset();
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
    usePlayerStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("PlaylistDetailPage skips locked track #1 and plays first playable track", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    vi.spyOn(api, "getPlaylistTracks").mockResolvedValueOnce({
      playlist: {
        id: "pl-1",
        platform: "netease",
        name: "测试歌单",
        trackCount: 2,
        creatorName: "Owner",
        owned: false,
      },
      songs,
      total: 2,
      page: 1,
      limit: 50,
      hasMore: false,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/playlists/netease/pl-1"]}>
          <Routes>
            <Route path="/playlists/:platform/:id" element={<PlaylistDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const playBtn = await screen.findByRole("button", { name: "播放本页" });
    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledWith(playableSong, { queue: songs });
  });

  it("ChartDetailPage skips locked track #1 and plays first playable track", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    vi.spyOn(api, "getChartDetail").mockResolvedValueOnce({
      chart: {
        id: "chart-1",
        platform: "netease",
        name: "飙升榜",
        trackCount: 2,
      },
      songs,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/charts/netease/chart-1"]}>
          <Routes>
            <Route path="/charts/:platform/:id" element={<ChartDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const playBtn = await screen.findByRole("button", { name: "播放全部" });
    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledWith(playableSong, { queue: songs });
  });

  it("ArtistDetailPage skips locked track #1 and plays first playable track", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    vi.spyOn(api, "getArtistDetail").mockResolvedValueOnce({
      artist: {
        id: "art-1",
        platform: "netease",
        name: "测试歌手",
        hotSongs: songs,
        albums: [],
      },
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/artist/netease/art-1"]}>
          <Routes>
            <Route path="/artist/:platform/:id" element={<ArtistDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const playBtn = await screen.findByRole("button", { name: "播放热门歌曲" });
    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledWith(playableSong, { queue: songs });
  });

  it("AlbumDetailPage skips locked track #1 and plays first playable track", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    vi.spyOn(api, "getAlbumDetail").mockResolvedValueOnce({
      album: {
        id: "alb-1",
        platform: "netease",
        name: "测试专辑",
        artists: [{ id: "art-1", name: "测试歌手" }],
        trackCount: 2,
        songs,
      },
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/album/netease/alb-1"]}>
          <Routes>
            <Route path="/album/:platform/:id" element={<AlbumDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const playBtn = await screen.findByRole("button", { name: "播放专辑" });
    await waitFor(() => expect(playBtn).not.toBeDisabled());
    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledWith(playableSong, { queue: songs });
  });
});
