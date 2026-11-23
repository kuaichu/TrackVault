import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, PlayerState, Song, SongCommentsPage, UserSettings, UserSummary } from "#shared";
import { SongTable } from "../entities/song/SongTable.js";
import { PersonalFmPage } from "../features/fm/PersonalFmPage.js";
import { CloudPage } from "../features/library/CloudAndHistoryPage.js";
import { PlaylistDetailPage } from "../features/library/PlaylistsPage.js";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { PlayerBar } from "../features/player/components/PlayerBar.js";
import { RightDrawer } from "../features/player/components/RightDrawer.js";
import { AudioEngine, audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import {
  clearPendingDirectLinkJobs,
  mergeJobView,
  trackPendingDirectLinkJob,
  upsertJobIntoList,
  useJobEvents,
} from "../shared/hooks/use-job-events.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../shared/hooks/use-toggle-like.js";
import { toast, useToastStore } from "../shared/store/toast-store.js";
import { CoverArt, ToastContainer } from "../shared/ui/primitives.js";
import { AppShell } from "./AppShell.js";

const TEST_USER: UserSummary = {
  id: "u-p7",
  username: "alice",
  role: "admin",
  trustedFallback: true,
  createdAt: 1,
};

function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    platform: overrides.platform ?? "netease",
    title: overrides.title ?? `Song ${id}`,
    artist: overrides.artist ?? "周杰伦",
    album: overrides.album ?? "叶惠美",
    durationSeconds: overrides.durationSeconds ?? 200,
    duration: overrides.duration ?? "03:20",
    quality: overrides.quality ?? "320K",
    availableQualities: overrides.availableQualities ?? [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
      { level: "lossless", label: "FLAC" },
    ],
    ...overrides,
  };
}

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    providerMode: "netease",
    defaultPlaybackQuality: "exhigh",
    defaultDownloadQuality: "lossless",
    maxConcurrentDownloads: 2,
    startupView: "discover",
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobView>): JobView {
  return {
    id: "job-1",
    kind: "download",
    status: "running",
    progress: 20,
    title: "晴天 - 周杰伦",
    createdAt: 1000,
    updatedAt: 1000,
    downloadReady: false,
    artifactExpired: false,
    ...overrides,
  };
}

function createControlledAudio() {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperty(audio, "paused", { get: () => paused, configurable: true });
  const playSpy = vi.spyOn(audio, "play").mockImplementation(async () => {
    paused = false;
  });
  vi.spyOn(audio, "pause").mockImplementation(() => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(audio, "load").mockImplementation(() => undefined);
  return {
    audio,
    playSpy,
    setPaused: (v: boolean) => {
      paused = v;
    },
  };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(_url: string, _init?: EventSourceInit) {
    MockEventSource.instances.push(this);
  }
  emitOpen() {
    this.onopen?.(new Event("open"));
  }
  emitError() {
    this.onerror?.(new Event("error"));
  }
  emitMessage(data: Record<string, unknown>) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ timestamp: Date.now(), ...data }) }),
    );
  }
  close() {}
}

describe("Phase 7 · Residual boundary closures & Fullscreen inline comments/queue", () => {
  const engines: AudioEngine[] = [];
  const originalEventSource = globalThis.EventSource;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();

    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getPlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });
    vi.spyOn(api, "savePlayerState").mockResolvedValue({ ok: true } as never);
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "isSongLiked").mockResolvedValue({ liked: false });
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      lyrics: { platform: "netease", songId: "1", lines: [], source: "none" },
    });
  });

  afterEach(() => {
    for (const eng of engines.splice(0)) {
      eng.dispose();
    }
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      writable: true,
      configurable: true,
    });
    globalThis.EventSource = originalEventSource;
    usePlayerStore.getState().reset();
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("U04 + U07: removes inert BEFORE focus() in real-Chromium order, auto-closes mobile drawer across 768px breakpoint, and retries CoverArt A->B->A", () => {
    // 1. U07: CoverArt A(fail) -> B(ok) -> A retries rendering <img src=A>
    const { rerender, unmount } = render(<CoverArt src="https://p1.music.126.net/a.jpg" alt="封面" />);
    fireEvent.error(screen.getByRole("img", { name: "封面" }));
    expect(screen.queryByRole("img", { name: "封面" })).toBeNull();

    rerender(<CoverArt src="https://p1.music.126.net/b.jpg" alt="封面" />);
    expect(screen.getByRole("img", { name: "封面" }).getAttribute("src")).toBe(
      "https://p1.music.126.net/b.jpg",
    );

    rerender(<CoverArt src="https://p1.music.126.net/a.jpg" alt="封面" />);
    expect(screen.getByRole("img", { name: "封面" }).getAttribute("src")).toBe(
      "https://p1.music.126.net/a.jpg",
    );
    unmount();

    // 2. U04: Enforce Chromium's native inert focus-blocking behavior in spy (focus is a no-op if target is inside [inert]!)
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.closest("[inert]")) {
        // Real Chromium ignores focus() when any ancestor is still inert!
        return;
      }
      nativeFocus.call(this, options);
    });

    Object.defineProperty(window, "innerWidth", { value: 390, writable: true, configurable: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/discover"]}>
          <AppShell user={TEST_USER}>
            <div>主视图内容</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const openMenuBtn = screen.getByRole("button", { name: "打开导航菜单" });
    openMenuBtn.focus();
    expect(document.activeElement).toBe(openMenuBtn);

    fireEvent.click(openMenuBtn);
    expect(screen.getByRole("dialog", { name: "导航菜单" })).toBeInTheDocument();
    expect(screen.getByRole("main").closest("[inert]")).not.toBeNull();

    // Press Escape -> inert MUST already be removed BEFORE focus() runs so openMenuBtn receives focus!
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
    expect(screen.getByRole("main").closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(openMenuBtn);

    // Reopen at 390px, then widen viewport to 1280px -> drawer auto-closes and main is no longer inert!
    fireEvent.click(openMenuBtn);
    expect(screen.getByRole("main").closest("[inert]")).not.toBeNull();

    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
    expect(screen.getByRole("main").closest("[inert]")).toBeNull();
  });

  it("FullscreenPlayer switches inline between Lyrics / Comments / Queue without closing, and TrackCommentsPanel retains page 1 on page 2 failure (P17)", async () => {
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

    const song = makeSong("s-fs", { title: "全屏内嵌曲" });
    usePlayerStore.setState({
      currentTrack: song,
      queue: [song, makeSong("s-q2", { title: "队列第二首" })],
      fullscreenOpen: true,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FullscreenPlayer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Click "查看评论" -> stays inside FullscreenPlayer (fullscreenOpen remains true!)
    fireEvent.click(screen.getByRole("button", { name: "查看评论" }));
    expect(usePlayerStore.getState().fullscreenOpen).toBe(true);

    await waitFor(() => {
      expect(screen.getByText("第一页保留评论")).toBeInTheDocument();
    });

    // Click "加载更多" -> page 2 fails once; page 1 MUST remain visible and retry button calls fetchNextPage (1 -> 2 -> 2)
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "重试加载更多" })).toBeInTheDocument();
    });
    expect(screen.getByText("第一页保留评论")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
    await waitFor(() => {
      expect(screen.getByText("第二页重试成功评论")).toBeInTheDocument();
    });
    expect(requestedPages).toEqual([1, 2, 2]);

    // Click "查看队列" -> stays inside FullscreenPlayer and renders queue items
    fireEvent.click(screen.getByRole("button", { name: "查看队列" }));
    expect(usePlayerStore.getState().fullscreenOpen).toBe(true);
    expect(screen.getByText("队列第二首")).toBeInTheDocument();
  });

  it("F14 + P07 + P09 + P10 + P11 + P12 + P19 + U09: AudioEngine state machine & mute volume persistence", async () => {
    const { audio, playSpy } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    // 1. U09: 10% -> mute -> persist -> fresh hydrate -> unmute restores 10% (0.1), NOT 80%
    const savedStates: PlayerState[] = [];
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => {
      savedStates.push(state);
      return { state };
    });
    usePlayerStore.setState({ hydrated: true });
    engine.setVolume(0.1);
    engine.toggleMute();
    // Flush persist via playTrack
    await engine.playTrack(makeSong("m1"));
    const savedState = savedStates[savedStates.length - 1];
    if (!savedState) throw new Error("Expected saved player state");
    expect(savedState.muted).toBe(true);
    expect(savedState.lastNonZeroVolume).toBe(0.1);

    engine.stop();
    engine.hydrate(savedState);
    expect(usePlayerStore.getState().muted).toBe(true);
    engine.toggleMute();
    expect(usePlayerStore.getState().volume).toBeCloseTo(0.1, 5);

    // 2. F14: Pausing immediately after "playing" does NOT drop in-flight recordPlayHistory notification
    let resolveHistory!: (res: { items: Song[] }) => void;
    vi.spyOn(api, "recordPlayHistory").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const historyNotifications: Song[][] = [];
    engine.setPlayHistoryListener((res) => historyNotifications.push(res.items));

    const songA = makeSong("a1", { title: "历史曲A" });
    await engine.playTrack(songA);
    audio.dispatchEvent(new Event("playing"));
    // Immediately pause while recordPlayHistory is still in flight
    await engine.togglePlay();
    resolveHistory({ items: [songA] });
    await Promise.resolve();
    expect(historyNotifications).toHaveLength(1);
    expect(historyNotifications[0]?.[0]?.id).toBe("a1");

    // 3. P12 + P19: Switching quality during initial track load (before first "playing") continues playing & records history once
    const recordSpy = vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
    playSpy.mockClear();
    const songB = makeSong("b1", { title: "切音质曲B" });
    await engine.playTrack(songB);
    // Note: "playing" event has NOT fired yet (still loading initial stream)!
    usePlayerStore.getState().setStatePatch({ isPlaying: false, isLoading: true });
    await engine.switchPlaybackQuality("lossless");
    expect(audio.src).toContain("level=lossless");
    expect(playSpy).toHaveBeenCalledTimes(2);
    audio.dispatchEvent(new Event("playing"));
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(songB);

    // 4. P07 + P11: Priority queue runs BEFORE fmMode in playNext; playPrevious < 4s in FM keeps fmMode; replacing queue clears priorityQueue
    const fm1 = makeSong("fm-1");
    const fm2 = makeSong("fm-2");
    const prio = makeSong("prio-1");
    usePlayerStore.setState({ fmQueue: [fm1, fm2] });
    await engine.playFmTrack(fm2, { queue: [fm1, fm2] });
    usePlaybackClockStore.getState().setClock({ currentTime: 2 });
    await engine.playPrevious();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-1");
    expect(usePlayerStore.getState().fmMode).toBe(true);

    engine.insertNextInQueue(prio);
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("prio-1");

    engine.insertNextInQueue(makeSong("stale-prio"));
    const firstNew = makeSong("nl-1");
    const newList = [firstNew, makeSong("nl-2")];
    await engine.playTrack(firstNew, { queue: newList });
    expect(usePlayerStore.getState().priorityQueue).toEqual([]);

    // 5. P10: All-locked queue NEVER calls play() on togglePlay / playNext / playPrevious
    engine.stop();
    playSpy.mockClear();
    const lockedOnly = [
      makeSong("lk-1", {
        availability: {
          playback: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
          download: { status: "copyright", locked: true, label: "无版权", reason: "无版权" },
        },
      }),
    ];
    usePlayerStore.setState({ queue: lockedOnly, currentTrack: null });
    await engine.togglePlay();
    await engine.playNext();
    await engine.playPrevious();
    expect(playSpy).not.toHaveBeenCalled();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlayerBar />
          <RightDrawer />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getAllByRole("button", { name: "播放" })[0]).toBeDisabled();

    // 6. P09: Leaving PersonalFmPage cancels manual "换一批" request without hijacking active FM playback
    const activeFm = makeSong("fm-active", { title: "正在漫游A" });
    await audioEngine.playFmTrack(activeFm, { queue: [activeFm] });

    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(api, "getPersonalFm").mockImplementation(
      (signal) =>
        new Promise((resolve) => {
          capturedSignal = signal;
          setTimeout(() => resolve({ songs: [makeSong("fm-hijack")] }), 200);
        }),
    );

    const fmRender = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PersonalFmPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "换一批" }));
    expect(capturedSignal?.aborted).toBe(false);
    fmRender.unmount();
    expect(capturedSignal?.aborted).toBe(true);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-active");
  });

  it("P06 + P15 + A09 + A10: protects liked-ids against stale GET, deduplicates 400ms double-clicks, shows >10k banner, and plays all 205 cloud songs", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // 1. P06: Slow initial getLikedSongIds resolving AFTER toggleSongLike("x-new", true) preserves "x-new"
    let resolveInitialLikes!: (res: { ids: string[] }) => void;
    vi.spyOn(api, "getLikedSongIds")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialLikes = resolve;
          }),
      )
      .mockResolvedValue({ ids: ["old-1", "x-new"] });
    vi.spyOn(api, "toggleSongLike").mockResolvedValue({ liked: true });

    function LikeHarness() {
      const { data } = useLikedIdsQuery("netease", true);
      const mut = useToggleLikeMutation();
      return (
        <div>
          <span data-testid="liked-list">{(data?.ids ?? []).join(",")}</span>
          <button
            type="button"
            onClick={() => mut.mutate({ platform: "netease", songId: "x-new", nextLiked: true })}
          >
            喜欢X
          </button>
        </div>
      );
    }

    const likeView = render(
      <QueryClientProvider client={qc}>
        <LikeHarness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "喜欢X" }));
    resolveInitialLikes({ ids: ["old-1"] });
    await waitFor(() => {
      expect(screen.getByTestId("liked-list").textContent).toContain("x-new");
    });
    likeView.unmount();

    // 2. P15: 400ms double-click (within 500ms system threshold) triggers playTrack ONLY ONCE
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    let fakeNow = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    const tableView = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={[makeSong("dc-1", { title: "四百毫秒双击曲" })]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const titleBtn = screen.getByRole("button", { name: "四百毫秒双击曲" });
    fireEvent.click(titleBtn, { detail: 1 });
    fakeNow += 420; // 420ms > old 350ms, within OS double-click sequence (detail=2)
    fireEvent.click(titleBtn, { detail: 2 });
    fireEvent.doubleClick(titleBtn, { detail: 2 });
    expect(playSpy).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
    tableView.unmount();

    // 3. A09: PlaylistDetailPage renders >10,000 search/sort truncation warning banner
    vi.spyOn(api, "getPlaylistTracks").mockResolvedValueOnce({
      playlist: {
        id: "pl-big",
        platform: "netease",
        name: "万首歌单",
        trackCount: 12_500,
        creatorName: "Tester",
        owned: false,
      },
      songs: [makeSong("s-1")],
      total: 1,
      page: 1,
      limit: 50,
      hasMore: false,
      truncated: true,
      scannedTotal: 10_000,
    });
    const plView = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/playlists/netease/pl-big"]}>
          <Routes>
            <Route path="/playlists/:platform/:id" element={<PlaylistDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("10,000");
    });
    plView.unmount();

    // 4. A10: CloudPage uses nextOffset=100 when page 0 has 99 songs, and "播放全部" loads all 205 songs!
    playSpy.mockClear();
    const seenOffsets: number[] = [];
    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      seenOffsets.push(offset);
      if (offset === 0) {
        return {
          songs: Array.from({ length: 99 }, (_, i) => makeSong(`c-${i + 1}`)),
          total: 204,
          offset: 0,
          nextOffset: 100,
          limit: 100,
          hasMore: true,
        };
      }
      if (offset === 100) {
        return {
          songs: Array.from({ length: 100 }, (_, i) => makeSong(`c-${101 + i}`)),
          total: 204,
          offset: 100,
          nextOffset: 200,
          limit: 100,
          hasMore: true,
        };
      }
      return {
        songs: Array.from({ length: 5 }, (_, i) => makeSong(`c-${201 + i}`)),
        total: 204,
        offset: 200,
        nextOffset: 205,
        limit: 100,
        hasMore: false,
      };
    });

    const cloudView = render(
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
    await waitFor(() => {
      expect(playSpy).toHaveBeenCalledTimes(1);
    });
    expect(seenOffsets).toEqual([0, 100, 200]);
    expect(playSpy.mock.calls[0]?.[1]?.queue).toHaveLength(204);
    cloudView.unmount();
  });

  it("F02 + F03 + F04 + F07 + F17: monotonic job merge, bounded sorted lists, fast/reconnect direct-link toasts, logout toast wipe, and quick search default mode", async () => {
    // 1. F03 + F04: mergeJobView never regresses terminal -> running; upsertJobIntoList sorts by createdAt DESC & caps at 50/100
    const completed = makeJob({ id: "j1", status: "completed", progress: 100, updatedAt: 2000 });
    const staleRunning = makeJob({ id: "j1", status: "running", progress: 65, updatedAt: 1500 });
    expect(mergeJobView(completed, staleRunning).status).toBe("completed");

    const full100 = Array.from({ length: 100 }, (_, i) =>
      makeJob({ id: `n-${i}`, createdAt: 2000 + i, updatedAt: 2000 + i }),
    );
    const afterOldUpdate = upsertJobIntoList(
      full100,
      makeJob({ id: "ancient-job", createdAt: 500, updatedAt: 9999 }),
      100,
    );
    expect(afterOldUpdate).toHaveLength(100);
    expect(afterOldUpdate.some((j) => j.id === "ancient-job")).toBe(false);

    // 2. F04 + F17: Fast SSE (before POST response) AND reconnect snapshot catch-up both show direct-link toast once
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function SseHarness() {
      useJobEvents(true);
      return <ToastContainer />;
    }
    const sseView = render(
      <QueryClientProvider client={qc}>
        <SseHarness />
      </QueryClientProvider>,
    );
    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected EventSource instance");
    act(() => es.emitOpen());

    // Fast SSE arrives BEFORE trackPendingDirectLinkJob is called by POST onSuccess!
    act(() => {
      es.emitMessage({
        type: "job_updated",
        job: makeJob({
          id: "dl-fast",
          status: "completed",
          title: "快响应直链",
          directUrl: "https://m7.music.126.net/fast.mp3",
        }),
      });
    });
    act(() => {
      const resolvedImmediately = trackPendingDirectLinkJob("dl-fast", {
        queryClient: qc,
        fallbackTitle: "快响应直链",
      });
      expect(resolvedImmediately).toBe(true);
    });
    expect(screen.getByRole("link", { name: "打开直链" })).toHaveAttribute(
      "href",
      "https://m7.music.126.net/fast.mp3",
    );

    // Reconnect snapshot catch-up for missed SSE completion + stale running protection
    act(() => useToastStore.getState().clear());
    trackPendingDirectLinkJob("dl-reconnect", { queryClient: qc });
    vi.spyOn(api, "listJobs").mockResolvedValueOnce({
      jobs: [
        makeJob({
          id: "dl-reconnect",
          status: "completed",
          title: "重连补弹直链",
          directUrl: "https://m7.music.126.net/reconnected.mp3",
        }),
        // Stale running snapshot for dl-fast MUST NOT overwrite dl-fast's completed state!
        makeJob({ id: "dl-fast", status: "running", progress: 40, updatedAt: 500 }),
      ],
    });
    act(() => {
      es.emitError();
      es.emitOpen();
    });
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "打开直链" })).toHaveAttribute(
        "href",
        "https://m7.music.126.net/reconnected.mp3",
      );
    });
    expect(qc.getQueryData<{ job: JobView }>(["job", "dl-fast"])?.job.status).toBe("completed");
    sseView.unmount();
    act(() => useToastStore.getState().clear());

    // 3. F02 + F07: Quick search while settings loading omits mode=aggregate so SearchPage uses "qq"; Logout wipes direct-link toast
    let resolveSettings!: (res: { settings: UserSettings }) => void;
    vi.spyOn(api, "getSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const searchSpy = vi
      .spyOn(api, "searchSongs")
      .mockResolvedValue({ results: [], mode: "qq", warnings: [] });
    vi.spyOn(api, "addSearchHistory").mockResolvedValue({ items: ["晴天"] });
    vi.spyOn(api, "getSearchHistory").mockResolvedValue({ items: [] });
    vi.spyOn(api, "logout").mockResolvedValue({ ok: true } as never);

    const qcShell = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let sessionCleared = false;
    render(
      <QueryClientProvider client={qcShell}>
        <MemoryRouter initialEntries={["/discover"]}>
          <AppShell
            user={TEST_USER}
            onSessionCleared={() => {
              sessionCleared = true;
              useToastStore.getState().clear();
            }}
          >
            <Routes>
              <Route path="/discover" element={<div>发现</div>} />
              <Route path="/search" element={<SearchPage />} />
            </Routes>
          </AppShell>
          <ToastContainer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const searchInput = screen.getByRole("textbox", { name: "搜索歌曲、歌手或专辑" });
    fireEvent.change(searchInput, { target: { value: "晴天" } });
    const searchForm = searchInput.closest("form");
    if (!searchForm) throw new Error("Expected form");
    fireEvent.submit(searchForm);

    // Settings have not resolved yet -> search must wait rather than firing aggregate!
    expect(searchSpy).not.toHaveBeenCalled();

    // Now settings resolve with default providerMode === "qq" -> SearchPage queries "qq"!
    await act(async () => {
      resolveSettings({ settings: makeSettings({ providerMode: "qq" }) });
    });
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith("晴天", "qq", expect.anything());
    });

    // F02: Push an 8s direct-link toast, then click Logout -> old direct-link toast wiped, only generic logout toast remains
    act(() => {
      toast.success("旧账号直链", {
        action: { label: "打开直链", href: "https://m7.music.126.net/secret.mp3" },
      });
    });
    expect(screen.getByRole("link", { name: "打开直链" })).toBeInTheDocument();

    const logoutBtn = screen.getAllByRole("button", { name: "退出登录" })[0];
    if (!logoutBtn) throw new Error("Expected logout button");
    fireEvent.click(logoutBtn);
    await waitFor(() => {
      expect(sessionCleared).toBe(true);
    });
    expect(screen.queryByRole("link", { name: "打开直链" })).toBeNull();
    expect(screen.getByText("已退出登录")).toBeInTheDocument();
  });
});
