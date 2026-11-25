import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SongCommentsPage } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import { makeTestSong, renderWithProviders } from "../../test-utils/fixtures.js";
import { FullscreenPlayer } from "./components/FullscreenPlayer.js";
import { LyricScroller } from "./components/LyricScroller.js";
import { PlayerBar } from "./components/PlayerBar.js";
import { PlayQueuePanel, TrackCommentsPanel } from "./components/PlayerDrawerPanels.js";
import { RightDrawer } from "./components/RightDrawer.js";
import { audioEngine } from "./engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "./store/player-store.js";

describe("LyricScroller, RightDrawer, and Fullscreen inline panels", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      lyrics: { platform: "netease", songId: "s-1", lines: [], source: "none" },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("LyricScroller uses container.scrollTo instead of scrollIntoView and clears highlight on empty interlude lines", () => {
    const scrollIntoViewSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewSpy;
    const scrollToSpy = vi.fn();
    Element.prototype.scrollTo = scrollToSpy;

    const lines = [
      { time: 5, text: "第一句" },
      { time: 15, text: "" },
      { time: 30, text: "间奏后第一句" },
    ];

    usePlaybackClockStore.getState().setClock({ currentTime: 6, duration: 100 });
    render(<LyricScroller lines={lines} loading={false} />);

    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(2);

    act(() => {
      usePlaybackClockStore.getState().setClock({ currentTime: 16, duration: 100 });
    });
    expect(screen.getByText("第一句").closest("button")?.className).not.toContain("font-semibold");
  });

  it("LyricScroller pauses auto-scroll on touch interaction", () => {
    const scrollToSpy = vi.fn();
    Element.prototype.scrollTo = scrollToSpy;

    const lines = [
      { time: 5, text: "第一句" },
      { time: 30, text: "第二句" },
    ];

    usePlaybackClockStore.getState().setClock({ currentTime: 6, duration: 100 });
    const { container } = render(<LyricScroller lines={lines} loading={false} />);

    scrollToSpy.mockClear();
    const scrollContainer = container.firstElementChild;
    if (!scrollContainer) throw new Error("Expected scroll container");
    fireEvent.touchStart(scrollContainer);

    act(() => {
      usePlaybackClockStore.getState().setClock({ currentTime: 31, duration: 100 });
    });
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("LyricScroller displays error message and triggers retry callback", () => {
    const onRetry = vi.fn();
    render(<LyricScroller lines={[]} loading={false} error="歌词服务异常" onRetry={onRetry} />);

    expect(screen.getByText("歌词服务异常")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("RightDrawer shows idle lyric prompt when no track is loaded", () => {
    usePlayerStore.setState({ drawerOpen: true, drawerTab: "lyrics", currentTrack: null });
    renderWithProviders(<RightDrawer />);

    expect(screen.getByText("播放歌曲后查看歌词")).toBeInTheDocument();
  });

  it("RightDrawer deduplicates overlapping hot/latest comments and loads page 2", async () => {
    const songA = makeTestSong("song-a");
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

    const getCommentsSpy = vi
      .spyOn(api, "getComments")
      .mockImplementation(async (_p, _id, page) => (page === 2 ? page2 : page1));

    usePlayerStore.setState({ drawerOpen: true, drawerTab: "comments", currentTrack: songA });
    renderWithProviders(<RightDrawer />);

    await waitFor(() => {
      expect(screen.getByText("精彩评论")).toBeInTheDocument();
      expect(screen.getByText("最新评论")).toBeInTheDocument();
    });
    expect(screen.getAllByText("经典神曲")).toHaveLength(1);
    expect(screen.getByText("单曲循环中")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => {
      expect(screen.getByText("二页评论内容")).toBeInTheDocument();
    });
    expect(getCommentsSpy).toHaveBeenCalledWith("netease", "song-a", 2, 20);
  });

  it("RightDrawer isolates comment like mutations across track switches", async () => {
    const songA = makeTestSong("song-a");
    const songB = makeTestSong("song-b");

    const songAPage: SongCommentsPage = {
      songId: "song-a",
      platform: "netease",
      total: 1,
      page: 1,
      limit: 20,
      hasMore: false,
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
      comments: [],
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

    vi.spyOn(api, "getComments").mockImplementation(async (_p, id) =>
      id === "song-b" ? songBPage : songAPage,
    );

    let resolveCommentLike: ((res: { liked: boolean }) => void) | undefined;
    const commentLikeSpy = vi.spyOn(api, "setCommentLiked").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommentLike = resolve;
        }),
    );

    usePlayerStore.setState({ drawerOpen: true, drawerTab: "comments", currentTrack: songA });
    renderWithProviders(<RightDrawer />);

    await waitFor(() => expect(screen.getByText("经典神曲")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "99" }));

    act(() => {
      usePlayerStore.setState({ currentTrack: songB });
    });
    await waitFor(() => expect(screen.getByText("B曲评论")).toBeInTheDocument());

    act(() => {
      resolveCommentLike?.({ liked: true });
    });
    await waitFor(() => {
      expect(commentLikeSpy).toHaveBeenCalledWith("netease", "song-a", "c-1", true);
    });
    expect(screen.getByRole("button", { name: "2" })).toBeInTheDocument();
  });

  it("FullscreenPlayer switches inline between lyrics, comments, and queue without closing, retaining page 1 on page 2 failure", async () => {
    const page1: SongCommentsPage = {
      songId: "s-fs",
      platform: "netease",
      total: 40,
      page: 1,
      limit: 20,
      hasMore: true,
      hotComments: [],
      comments: [
        {
          id: "c-p1",
          userId: "u1",
          nickname: "一页听友",
          content: "第一页保留评论",
          timeText: "刚刚",
          liked: false,
          likedCount: 8,
          replyCount: 0,
        },
      ],
    };
    const page2: SongCommentsPage = {
      songId: "s-fs",
      platform: "netease",
      total: 40,
      page: 2,
      limit: 20,
      hasMore: false,
      hotComments: [],
      comments: [
        {
          id: "c-p2",
          userId: "u2",
          nickname: "二页听友",
          content: "第二页重试成功评论",
          timeText: "1分钟前",
          liked: false,
          likedCount: 3,
          replyCount: 0,
        },
      ],
    };

    const requestedPages: number[] = [];
    let failPage2Once = true;
    vi.spyOn(api, "getComments").mockImplementation(async (_platform, _songId, page = 1) => {
      requestedPages.push(page);
      if (page === 2 && failPage2Once) {
        failPage2Once = false;
        throw new Error("二页网络超时");
      }
      return page === 2 ? page2 : page1;
    });

    const song = makeTestSong("s-fs", { title: "全屏内嵌曲" });
    usePlayerStore.setState({
      currentTrack: song,
      queue: [song, makeTestSong("s-q2", { title: "队列第二首" })],
      fullscreenOpen: true,
    });

    renderWithProviders(<FullscreenPlayer />);

    fireEvent.click(screen.getByRole("button", { name: "查看评论" }));
    expect(usePlayerStore.getState().fullscreenOpen).toBe(true);

    await waitFor(() => expect(screen.getByText("第一页保留评论")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "重试加载更多" })).toBeInTheDocument());
    expect(screen.getByText("第一页保留评论")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
    await waitFor(() => expect(screen.getByText("第二页重试成功评论")).toBeInTheDocument());
    expect(requestedPages).toEqual([1, 2, 2]);

    fireEvent.click(screen.getByRole("button", { name: "查看队列" }));
    expect(usePlayerStore.getState().fullscreenOpen).toBe(true);
    expect(screen.getByText("队列第二首")).toBeInTheDocument();
  });

  it("TrackCommentsPanel shows '加载更多' when page 1 is empty with hasMore=true", async () => {
    const song = makeTestSong("s-empty-p1");
    usePlayerStore.setState({ currentTrack: song });

    vi.spyOn(api, "getComments").mockImplementation(async (_p, _id, page = 1) => {
      if (page === 1) {
        return {
          songId: "s-empty-p1",
          platform: "netease",
          total: 10,
          page: 1,
          limit: 20,
          hasMore: true,
          hotComments: [],
          comments: [],
        } satisfies SongCommentsPage;
      }
      return {
        songId: "s-empty-p1",
        platform: "netease",
        total: 10,
        page: 2,
        limit: 20,
        hasMore: false,
        hotComments: [],
        comments: [
          {
            id: "c-after-empty",
            userId: "u1",
            nickname: "二页用户",
            content: "空首页后的第二页有效评论",
            timeText: "刚刚",
            liked: false,
            likedCount: 1,
            replyCount: 0,
          },
        ],
      } satisfies SongCommentsPage;
    });

    renderWithProviders(<TrackCommentsPanel active />, { withRouter: false });

    await waitFor(() => expect(screen.getByRole("button", { name: "加载更多" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));

    await waitFor(() => expect(screen.getByText("空首页后的第二页有效评论")).toBeInTheDocument());
  });

  it("FullscreenPlayer updates aria-pressed across desktop and mobile cover views", () => {
    const song = makeTestSong("s-a11y");
    usePlayerStore.setState({
      currentTrack: song,
      queue: [song],
      fullscreenOpen: true,
    });

    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
    window.dispatchEvent(new Event("resize"));
    const desktopView = renderWithProviders(<FullscreenPlayer />);
    expect(screen.getByRole("button", { name: "查看歌词" }).getAttribute("aria-pressed")).toBe("true");
    desktopView.unmount();

    Object.defineProperty(window, "innerWidth", { value: 390, writable: true, configurable: true });
    window.dispatchEvent(new Event("resize"));
    renderWithProviders(<FullscreenPlayer />);

    fireEvent.click(screen.getByRole("button", { name: "查看评论" }));
    expect(screen.getByRole("button", { name: "查看评论" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "封面" }));
    expect(screen.getByRole("button", { name: "查看评论" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("PlayQueuePanel exposes keyboard focus-visible remove button styling", () => {
    const song1 = makeTestSong("q-1");
    const song2 = makeTestSong("q-2");
    usePlayerStore.setState({ currentTrack: song1, queue: [song1, song2] });

    render(<PlayQueuePanel onDarkBackdrop />);

    const removeButtons = screen.getAllByRole("button", { name: "移出队列" });
    expect(removeButtons[0]?.className).toContain("md:group-focus-within:opacity-100");
  });

  it("LyricScroller hides prominent native scrollbar and FullscreenPlayer opens explicit quality options menu", async () => {
    const switchQualitySpy = vi.spyOn(audioEngine, "switchPlaybackQuality").mockResolvedValue(undefined);

    const { container, unmount } = render(
      <LyricScroller lines={[{ time: 1, text: "无滚动条沉浸歌词" }]} loading={false} large />,
    );
    expect(container.firstElementChild?.className).toContain("tv-no-scrollbar");
    unmount();

    const song = makeTestSong("s-quality", {
      availableQualities: [
        { level: "standard", label: "128K" },
        { level: "exhigh", label: "320K" },
      ],
    });
    usePlayerStore.setState({
      currentTrack: song,
      queue: [song],
      fullscreenOpen: true,
      defaultPlaybackQuality: "exhigh",
      preferredTrackQuality: null,
      loadedStreamQuality: "exhigh",
    });

    renderWithProviders(<FullscreenPlayer />);

    // Apple Music borderless play glyph & stacked full-width progress bar
    const playBtn = screen.getByRole("button", { name: "播放" });
    expect(playBtn.className).toContain("bg-transparent");
    expect(document.querySelector("[data-layout='stacked-timestamps']")).not.toBeNull();

    const qualityBtn = screen.getByRole("button", { name: "切换音质" });
    expect(qualityBtn).toHaveTextContent("320K");
    expect(qualityBtn.className).not.toContain("border-");

    // Clicking opens quality options menu instead of silently cycling
    fireEvent.click(qualityBtn);
    const menu = screen.getByRole("menu", { name: "音质选项" });
    expect(menu).toBeInTheDocument();
    expect(switchQualitySpy).not.toHaveBeenCalled();

    // Unavailable tiers above track's declared capabilities are clearly shown as disabled
    const hiresItem = screen.getByRole("menuitemradio", { name: /Hi-Res/ });
    expect(hiresItem).toBeDisabled();

    const standardItem = screen.getByRole("menuitemradio", { name: /128K/ });
    expect(standardItem).not.toBeDisabled();
    fireEvent.click(standardItem);
    expect(switchQualitySpy).toHaveBeenCalledWith("standard");
  });

  it("PlayerBar and FullscreenPlayer provide quick collect-to-playlist with one-click add and inline create", async () => {
    vi.spyOn(api, "getUserPlaylists").mockResolvedValue({
      playlists: [
        {
          id: "pl-owned-1",
          platform: "netease",
          name: "深夜循环精选",
          trackCount: 18,
          creatorName: "我",
          owned: true,
        },
        {
          id: "pl-sub-2",
          platform: "netease",
          name: "他人歌单",
          trackCount: 50,
          creatorName: "别人",
          owned: false,
        },
      ],
    });
    const addTracksSpy = vi.spyOn(api, "addTracksToPlaylist").mockResolvedValue({ addedCount: 1 });
    const createPlaylistSpy = vi.spyOn(api, "createPlaylist").mockResolvedValue({
      playlistId: "pl-new-9",
      playlistName: "新歌速藏",
      playlistUrl: "https://music.163.com/#/playlist?id=9",
      addedCount: 1,
    });

    const song = makeTestSong("s-collect", { title: "待收藏好歌" });
    usePlayerStore.setState({
      currentTrack: song,
      queue: [song],
      fullscreenOpen: false,
    });

    const barView = renderWithProviders(<PlayerBar />);
    // Verify Apple Music Route B LCD card, borderless play glyph, borderless quality pill, and quote-bubble lyrics button
    expect(document.querySelector("[data-layout='lcd']")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "播放" })[1]?.className).toContain("bg-transparent");
    expect(screen.getByTitle("切换试听音质").className).not.toContain("border-");
    expect(screen.getByRole("button", { name: "歌词" }).textContent).toBe("");

    const collectBtns = screen.getAllByRole("button", { name: "收藏到歌单" });
    expect(collectBtns.length).toBeGreaterThanOrEqual(2); // mobile + desktop bars

    // Clicking the inner <svg>/<path> of heart or collect in PlayerBar must NOT bubble to open FullscreenPlayer
    const desktopLikeBtn = screen.getAllByRole("button", { name: "喜欢" })[1] as HTMLElement;
    const likeSvgPath = desktopLikeBtn.querySelector("path") ?? desktopLikeBtn.querySelector("svg");
    expect(likeSvgPath).not.toBeNull();
    vi.spyOn(api, "toggleSongLike").mockResolvedValue({ liked: true });
    fireEvent.click(likeSvgPath as Element);
    expect(usePlayerStore.getState().fullscreenOpen).toBe(false);

    const desktopCollectBtn = collectBtns[collectBtns.length - 1] as HTMLElement;
    const collectSvg = desktopCollectBtn.querySelector("svg") ?? desktopCollectBtn;
    fireEvent.click(collectSvg);
    expect(usePlayerStore.getState().fullscreenOpen).toBe(false);
    await waitFor(() => expect(screen.getByText("深夜循环精选")).toBeInTheDocument());
    expect(screen.queryByText("他人歌单")).toBeNull();

    fireEvent.click(screen.getByText("深夜循环精选"));
    await waitFor(() => {
      expect(addTracksSpy).toHaveBeenCalledWith("netease", "pl-owned-1", ["s-collect"]);
    });
    barView.unmount();

    // Verify inline create-and-collect inside FullscreenPlayer utility pill
    usePlayerStore.setState({ fullscreenOpen: true });
    renderWithProviders(<FullscreenPlayer />);

    fireEvent.click(screen.getByRole("button", { name: "收藏到歌单" }));
    await waitFor(() => expect(screen.getByText("新建歌单并收藏")).toBeInTheDocument());

    fireEvent.click(screen.getByText("新建歌单并收藏"));
    const input = screen.getByRole("textbox", { name: "新歌单名称" });
    fireEvent.change(input, { target: { value: "新歌速藏" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(createPlaylistSpy).toHaveBeenCalledWith("netease", "新歌速藏", ["s-collect"]);
    });
  });
});
