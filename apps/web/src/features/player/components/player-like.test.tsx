import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { useIsSongLiked } from "../../../entities/song/index.js";
import { api } from "../../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../../shared/hooks/use-capabilities.js";
import { useToastStore } from "../../../shared/store/toast-store.js";
import { ToastContainer } from "../../../shared/ui/primitives.js";
import { usePlayerStore } from "../store/player-store.js";
import { FullscreenPlayer } from "./FullscreenPlayer.js";
import { PlayerBar } from "./PlayerBar.js";

function makeSong(id: string, title: string): Song {
  return {
    id,
    platform: "netease",
    title,
    artist: "周杰伦",
    album: "叶惠美",
    durationSeconds: 210,
    duration: "03:30",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
  };
}

describe("MR-03 · PlayerBar & FullscreenPlayer single liked-ids source of truth", () => {
  beforeEach(() => {
    usePlayerStore.getState().reset();
    useToastStore.getState().clear();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      lyrics: { platform: "netease", songId: "s-1", lines: [], source: "none" },
    });
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().reset();
    useToastStore.getState().clear();
    vi.restoreAllMocks();
  });

  it("derives PlayerBar/FullscreenPlayer heart state from ['liked-ids'] with zero extra like-status network calls on track switch, and includes songTitle in toasts", async () => {
    const song1 = makeSong("s-1", "晴天");
    const song2 = makeSong("s-2", "夜曲");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const getLikedIdsSpy = vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: ["s-1"] });
    const toggleLikeSpy = vi
      .spyOn(api, "toggleSongLike")
      .mockImplementation(async (_platform, _songId, liked) => ({ liked }));

    expect("isSongLiked" in api).toBe(false);

    usePlayerStore.setState({
      currentTrack: song1,
      queue: [song1, song2],
      fullscreenOpen: true,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
          <FullscreenPlayer />
          <ToastContainer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "取消喜欢" })).toHaveLength(2);
    });
    expect(getLikedIdsSpy).toHaveBeenCalledTimes(1);
    expect(toggleLikeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Switching to unliked song2 immediately reflects ["liked-ids"] with zero extra network calls or flicker
    act(() => {
      usePlayerStore.setState({ currentTrack: song2 });
    });
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "喜欢" })).toHaveLength(2);
    });
    expect(getLikedIdsSpy).toHaveBeenCalledTimes(1);
    expect(toggleLikeSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Click heart in PlayerBar -> optimistic update syncs both PlayerBar & FullscreenPlayer, toast includes title
    const likeBtns = screen.getAllByRole("button", { name: "喜欢" });
    const playerBarBtn = likeBtns[0];
    if (!playerBarBtn) throw new Error("Expected PlayerBar heart button");
    fireEvent.click(playerBarBtn);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "取消喜欢" })).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText("已喜欢「夜曲」")).toBeInTheDocument();
    });
    expect(toggleLikeSpy).toHaveBeenCalledWith("netease", "s-2", true);
    expect(qc.getQueryData(["song-like", "netease", "s-2"])).toBeUndefined();

    // Click heart in FullscreenPlayer -> unlikes song2 and shows toast with songTitle
    const unlikeBtns = screen.getAllByRole("button", { name: "取消喜欢" });
    const fullscreenBtn = unlikeBtns[1];
    if (!fullscreenBtn) throw new Error("Expected FullscreenPlayer heart button");
    fireEvent.click(fullscreenBtn);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "喜欢" })).toHaveLength(2);
    });
    await waitFor(() => {
      expect(screen.getByText("已取消喜欢「夜曲」")).toBeInTheDocument();
    });
    expect(toggleLikeSpy).toHaveBeenLastCalledWith("netease", "s-2", false);
  });

  it("rolls back optimistic ['liked-ids'] update when toggleSongLike fails and never fabricates partial list before initial load", async () => {
    const song1 = makeSong("s-roll", "七里香");
    let resolveInitial!: (res: { ids: string[] }) => void;
    vi.spyOn(api, "getLikedSongIds").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );

    function LikeStateProbe() {
      const state = useIsSongLiked("netease", "s-roll", true);
      return <span data-testid="probe">{`${String(state.liked)}:${String(state.isLoading)}`}</span>;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    usePlayerStore.setState({ currentTrack: song1, queue: [song1] });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
          <LikeStateProbe />
          <ToastContainer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("probe").textContent).toBe("false:true");
    expect(qc.getQueryData(["liked-ids", "netease"])).toBeUndefined();

    await act(async () => {
      resolveInitial({ ids: [] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("false:false");
    });

    let rejectToggle!: (err: Error) => void;
    vi.spyOn(api, "toggleSongLike").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectToggle = reject;
        }),
    );

    const likeBtn = screen.getAllByRole("button", { name: "喜欢" })[0];
    if (!likeBtn) throw new Error("Expected heart button");
    fireEvent.click(likeBtn);

    // Optimistically liked immediately while request is in flight
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("true:false");
    });

    await act(async () => {
      rejectToggle(new Error("红心请求失败"));
    });

    // Safely rolled back to unliked on error
    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("false:false");
    });
    expect(screen.getByText("红心请求失败")).toBeInTheDocument();
  });
});
