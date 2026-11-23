import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song, SongCommentsPage } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { useToggleLikeMutation } from "../../shared/hooks/use-toggle-like.js";
import { PersonalFmPage } from "../fm/PersonalFmPage.js";
import { LyricScroller } from "./components/LyricScroller.js";
import { RightDrawer } from "./components/RightDrawer.js";
import { audioEngine } from "./engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "./store/player-store.js";

function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    platform: "netease",
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    album: `Album ${id}`,
    durationSeconds: 210,
    duration: "03:30",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
    ...overrides,
  };
}

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe("Phase 4 · Shared Like Hook, Personal FM, LyricScroller, and RightDrawer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    audioEngine.stop();
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
  });

  afterEach(() => {
    audioEngine.stop();
    cleanup();
    vi.restoreAllMocks();
  });

  it("useToggleLikeMutation leaves unloaded ['liked-ids'] undefined and captures {platform, songId} across track switches (P05/P06/B50)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let resolveLike!: (res: { liked: boolean }) => void;
    const toggleSpy = vi.spyOn(api, "toggleSongLike").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLike = resolve;
        }),
    );

    const { result } = renderHook(() => useToggleLikeMutation(), {
      wrapper: createWrapper(qc),
    });

    // Fire like for Track A while ['liked-ids', 'netease'] is NOT loaded yet
    act(() => {
      result.current.mutate({ platform: "netease", songId: "track-a", nextLiked: true });
    });
    await waitFor(() => expect(toggleSpy).toHaveBeenCalledTimes(1));

    // Simulate switching currentTrack to Track B before request completes
    act(() => {
      usePlayerStore.setState({ currentTrack: makeSong("track-b") });
    });

    act(() => {
      resolveLike({ liked: true });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(toggleSpy).toHaveBeenCalledWith("netease", "track-a", true);
    // Cache for A updated; B untouched; unloaded liked-ids remains undefined (NOT poisoned to ['track-a'])
    expect(qc.getQueryData(["song-like", "netease", "track-a"])).toEqual({ liked: true });
    expect(qc.getQueryData(["song-like", "netease", "track-b"])).toBeUndefined();
    expect(qc.getQueryData(["liked-ids", "netease"])).toBeUndefined();

    // When liked-ids IS loaded, mutation updates it incrementally using dynamic platform
    qc.setQueryData(["liked-ids", "qq"], { ids: ["existing-1"] });
    vi.spyOn(api, "toggleSongLike").mockResolvedValueOnce({ liked: true });
    await act(async () => {
      await result.current.mutateAsync({ platform: "qq", songId: "qq-2", nextLiked: true });
    });
    expect(qc.getQueryData(["liked-ids", "qq"])).toEqual({ ids: ["existing-1", "qq-2"] });
  });

  it("PersonalFmPage syncs with AudioEngine auto-advance, unbinds unplayed FM lyrics, and starts+seeks on lyric click (P07/P08/P09)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fmA = makeSong("fm-a", { title: "FM Song A" });
    const fmB = makeSong("fm-b", { title: "FM Song B" });
    const fmC = makeSong("fm-c", { title: "FM Song C" });
    const otherSong = makeSong("other-x", { title: "Normal Song X" });

    const fmSpy = vi
      .spyOn(api, "getPersonalFm")
      .mockResolvedValueOnce({ songs: [fmA, fmB] })
      .mockResolvedValueOnce({ songs: [fmC] });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
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

    // Global player is currently playing another normal song X at 56s
    usePlayerStore.setState({ currentTrack: otherSong, isPlaying: true, fmMode: false });
    usePlaybackClockStore.getState().setClock({ currentTime: 56, duration: 200 });
    const seekSpy = vi.spyOn(audioEngine, "seek");
    const playFmSpy = vi.spyOn(audioEngine, "playFmTrack");

    render(<PersonalFmPage />, { wrapper: createWrapper(qc) });

    await waitFor(() => {
      expect(screen.getByText("FM Song A")).toBeInTheDocument();
    });
    const line56 = await screen.findByText("第五十六秒歌词");
    // Unplayed FM candidate lyrics must NOT highlight with Song X's clock
    expect(line56.closest("button")?.className).not.toContain("scale-[1.02]");

    // Decision #4 (P08): Clicking 56s lyric line on unplayed FM A plays FM A at 56s instead of seeking Song X
    fireEvent.click(line56);
    expect(seekSpy).not.toHaveBeenCalled();
    expect(playFmSpy).toHaveBeenCalledWith(fmA, { queue: [fmA, fmB], startAtSeconds: 56 });
    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-a");
      expect(usePlayerStore.getState().fmMode).toBe(true);
    });

    // P07: Engine advancing via playNext() automatically syncs PersonalFmPage to FM B, then fetches batch 2 (FM C)
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

  it("aborts in-flight FM fetch when normal track starts playing so stale FM response cannot hijack playback (P09)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFm!: (res: { songs: Song[] }) => void;
    vi.spyOn(api, "getPersonalFm").mockImplementationOnce((signal) => {
      capturedSignal = signal;
      return new Promise((resolve) => {
        resolveFm = resolve;
      });
    });

    const fmLoadPromise = audioEngine.loadFmBatch({ autoPlay: true });
    const normalSong = makeSong("normal-1", { title: "User Chosen Song" });
    await audioEngine.playTrack(normalSong);

    expect(capturedSignal?.aborted).toBe(true);
    resolveFm({ songs: [makeSong("stale-fm", { title: "Stale FM" })] });
    await fmLoadPromise;

    expect(usePlayerStore.getState().currentTrack?.id).toBe("normal-1");
    expect(usePlayerStore.getState().fmMode).toBe(false);
  });

  it("LyricScroller uses container.scrollTo instead of scrollIntoView, pauses on touch, handles empty interlude lines & error retry (P16/P17/C073/C074)", () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    const scrollToSpy = vi.fn();
    Element.prototype.scrollTo = scrollToSpy;

    const lines = [
      { time: 5, text: "第一句" },
      { time: 15, text: "" }, // interlude marker
      { time: 30, text: "间奏后第一句" },
    ];

    usePlaybackClockStore.getState().setClock({ currentTime: 6, duration: 100 });
    const { container, rerender } = render(<LyricScroller lines={lines} loading={false} />);

    // Container-local scrollTo used; scrollIntoView NEVER called
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).toHaveBeenCalled();

    // Empty interlude line is not rendered as a button and clears active highlight at t=16s
    expect(screen.getAllByRole("button")).toHaveLength(2);
    act(() => {
      usePlaybackClockStore.getState().setClock({ currentTime: 16, duration: 100 });
    });
    expect(screen.getByText("第一句").closest("button")?.className).not.toContain("font-semibold");

    // Touch interaction pauses auto-scroll on subsequent active line change (P16)
    scrollToSpy.mockClear();
    const scrollContainer = container.firstElementChild;
    if (!scrollContainer) throw new Error("Expected scroll container");
    fireEvent.touchStart(scrollContainer);
    act(() => {
      usePlaybackClockStore.getState().setClock({ currentTime: 31, duration: 100 });
    });
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Error state displays message and triggers retry (P17)
    const onRetry = vi.fn();
    rerender(<LyricScroller lines={[]} loading={false} error="歌词服务异常" onRetry={onRetry} />);
    expect(screen.getByText("歌词服务异常")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("RightDrawer shows idle lyric prompt, deduplicates hot/latest comments, paginates, and isolates comment likes across track switches (P05/P17/B43/C073)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const songA = makeSong("song-a");
    const songB = makeSong("song-b");

    // 1) Idle lyrics tab says "播放歌曲后查看歌词"
    usePlayerStore.setState({ drawerOpen: true, drawerTab: "lyrics", currentTrack: null });
    render(<RightDrawer />, { wrapper: createWrapper(qc) });
    expect(screen.getByText("播放歌曲后查看歌词")).toBeInTheDocument();

    // 2) Comments tab deduplicates overlapping hot & latest comments and supports Load More
    const page1: SongCommentsPage = {
      songId: "song-a",
      platform: "netease",
      total: 3,
      page: 1,
      limit: 20,
      hasMore: true,
      hotComments: [
        {
          id: "c-1",
          userId: "u1",
          nickname: "热评用户",
          content: "经典神曲",
          timeText: "刚刚",
          liked: false,
          likedCount: 99,
          replyCount: 0,
        },
      ],
      comments: [
        // Duplicate c-1 must be deduped from latestComments!
        {
          id: "c-1",
          userId: "u1",
          nickname: "热评用户",
          content: "经典神曲",
          timeText: "刚刚",
          liked: false,
          likedCount: 99,
          replyCount: 0,
        },
        {
          id: "c-2",
          userId: "u2",
          nickname: "最新用户",
          content: "单曲循环中",
          timeText: "1分钟前",
          liked: false,
          likedCount: 5,
          replyCount: 0,
        },
      ],
    };
    const page2: SongCommentsPage = {
      songId: "song-a",
      platform: "netease",
      total: 3,
      page: 2,
      limit: 20,
      hasMore: false,
      hotComments: [],
      comments: [
        {
          id: "c-3",
          userId: "u3",
          nickname: "第二页用户",
          content: "二页评论内容",
          timeText: "5分钟前",
          liked: false,
          likedCount: 1,
          replyCount: 0,
        },
      ],
    };
    const songBPage: SongCommentsPage = {
      songId: "song-b",
      platform: "netease",
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
      hotComments: [],
      comments: [
        {
          id: "c-b1",
          userId: "u9",
          nickname: "B曲评论员",
          content: "B曲评论",
          timeText: "刚刚",
          liked: false,
          likedCount: 2,
          replyCount: 0,
        },
      ],
    };

    const getCommentsSpy = vi.spyOn(api, "getComments").mockImplementation(async (_p, id, page) => {
      if (id === "song-b") return songBPage;
      return page === 2 ? page2 : page1;
    });

    act(() => {
      usePlayerStore.setState({ drawerTab: "comments", currentTrack: songA });
    });

    await waitFor(() => {
      expect(screen.getByText("精彩评论")).toBeInTheDocument();
      expect(screen.getByText("最新评论")).toBeInTheDocument();
    });
    // c-1 rendered ONLY ONCE despite appearing in both hotComments and comments
    expect(screen.getAllByText("经典神曲")).toHaveLength(1);
    expect(screen.getByText("单曲循环中")).toBeInTheDocument();

    // Load More fetches page 2
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => {
      expect(screen.getByText("二页评论内容")).toBeInTheDocument();
    });
    expect(getCommentsSpy).toHaveBeenCalledWith("netease", "song-a", 2, 20);

    // Comment like mutation captures {platform, songId, commentId} so switching to songB mid-flight never hits songB
    let resolveCommentLike!: (res: { liked: boolean }) => void;
    const commentLikeSpy = vi.spyOn(api, "setCommentLiked").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommentLike = resolve;
        }),
    );

    const c1LikeBtn = screen.getByRole("button", { name: "99" });
    fireEvent.click(c1LikeBtn);

    act(() => {
      usePlayerStore.setState({ currentTrack: songB });
    });
    await waitFor(() => {
      expect(screen.getByText("B曲评论")).toBeInTheDocument();
    });

    act(() => {
      resolveCommentLike({ liked: true });
    });
    await waitFor(() => {
      expect(commentLikeSpy).toHaveBeenCalledWith("netease", "song-a", "c-1", true);
    });
    // Song B's comments remain completely untouched
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });
});
