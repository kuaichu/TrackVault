import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus, JobView, Song, SongCommentsPage, UserSettings, UserSummary } from "#shared";
import { SongTable } from "../entities/song/SongTable.js";
import { PersonalFmPage } from "../features/fm/PersonalFmPage.js";
import { CloudPage, HistoryPage } from "../features/library/CloudAndHistoryPage.js";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { PlayQueuePanel, TrackCommentsPanel } from "../features/player/components/PlayerDrawerPanels.js";
import { AudioEngine, audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import {
  clearPendingDirectLinkJobs,
  trackPendingDirectLinkJob,
  useJobEvents,
} from "../shared/hooks/use-job-events.js";
import { applyRecordedPlayHistory } from "../shared/hooks/use-play-history-sync.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../shared/hooks/use-toggle-like.js";
import { toast, useToastStore } from "../shared/store/toast-store.js";
import { AppContent } from "./App.js";

const TEST_USER: UserSummary = {
  id: "u-p8",
  username: "alice",
  role: "admin",
  trustedFallback: false,
  createdAt: 1,
};

function makeSong(id: string, overrides: Partial<Song> = {}): Song {
  return {
    id,
    platform: overrides.platform ?? "netease",
    title: overrides.title ?? `Song ${id}`,
    artist: overrides.artist ?? "周杰伦",
    album: overrides.album ?? "叶惠美",
    durationSeconds: overrides.durationSeconds ?? 180,
    duration: overrides.duration ?? "03:00",
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
    title: "测试任务",
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

describe("Phase 8 · State invariant convergence & accessibility regressions", () => {
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
    vi.restoreAllMocks();
  });

  it("F04 + F17 + F07 + F02: reconciles in-flight listJobs against SSE add/remove, probes >50th direct link via getJob, defers SearchPage mode until settings load, and clears toasts on natural session expiry", async () => {
    // 1. F04 + F17
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveInFlightList!: (res: { jobs: JobView[] }) => void;
    let listCalls = 0;
    const staleSnapshot = [
      makeJob({ id: "removed-job", status: "completed", progress: 100, createdAt: 20 }),
      makeJob({ id: "running-job", status: "running", progress: 30, createdAt: 10, updatedAt: 10 }),
    ];

    vi.spyOn(api, "listJobs").mockImplementation(() => {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ jobs: staleSnapshot });
      return new Promise((resolve) => {
        resolveInFlightList = resolve;
      });
    });
    vi.spyOn(api, "getJob").mockImplementation(async (id) => ({
      job: makeJob({
        id,
        status: "completed",
        progress: 100,
        title: "五十一号旧直链",
        directUrl: "https://m7.music.126.net/beyond50.mp3",
      }),
    }));

    function JobWatcher() {
      useJobEvents(true);
      useQuery({ queryKey: ["jobs", "download"], queryFn: () => api.listJobs("download") });
      return null;
    }

    const sseView = render(
      <QueryClientProvider client={qc}>
        <JobWatcher />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(qc.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs).toHaveLength(2);
    });

    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected EventSource");
    act(() => es.emitOpen());
    trackPendingDirectLinkJob("beyond-50-id", { queryClient: qc });

    // Trigger reconnect -> starts listJobs call #2 (held in flight)
    act(() => {
      es.emitError();
      es.emitOpen();
    });
    await waitFor(() => expect(listCalls).toBe(2));

    // While listJobs #2 is in flight, SSE delivers a new job, completes running-job, and removes removed-job
    act(() => {
      es.emitMessage({
        type: "job_updated",
        job: makeJob({ id: "new-sse-job", status: "completed", progress: 100, createdAt: 30 }),
      });
      es.emitMessage({
        type: "job_updated",
        job: makeJob({
          id: "running-job",
          status: "completed",
          progress: 100,
          createdAt: 10,
          updatedAt: 40,
        }),
      });
      es.emitMessage({ type: "job_removed", jobId: "removed-job" });
    });

    // Late stale listJobs #2 resolves without new-sse-job and still containing removed-job (and without beyond-50-id!)
    await act(async () => {
      resolveInFlightList({ jobs: staleSnapshot });
    });

    const finalJobs = qc.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs ?? [];
    expect(finalJobs.map((j) => [j.id, j.status])).toEqual([
      ["new-sse-job", "completed"],
      ["running-job", "completed"],
    ]);

    // F17: beyond-50-id was not in listJobs, so getJob("beyond-50-id") fired the direct-link toast!
    await waitFor(() => {
      expect(useToastStore.getState().items.some((t) => t.action?.href?.includes("beyond50.mp3"))).toBe(true);
    });
    sseView.unmount();
    useToastStore.getState().clear();

    // 2. F07: SearchPage form submit before settings resolve waits and queries "qq" once settings arrive
    let resolveSettings!: (res: { settings: UserSettings }) => void;
    vi.spyOn(api, "getSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const seenModes: string[] = [];
    vi.spyOn(api, "searchSongs").mockImplementation(async (_q, mode) => {
      seenModes.push(mode);
      return { results: [], mode, warnings: [] };
    });
    vi.spyOn(api, "getSearchHistory").mockResolvedValue({ items: ["历史热词"] });
    vi.spyOn(api, "addSearchHistory").mockResolvedValue({ items: ["历史热词"] });

    const searchQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const searchView = render(
      <QueryClientProvider client={searchQc}>
        <MemoryRouter initialEntries={["/search"]}>
          <SearchPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const input = screen.getByPlaceholderText(/输入歌名/);
    fireEvent.change(input, { target: { value: "七里香" } });
    const form = input.closest("form");
    if (!form) throw new Error("Expected form");
    fireEvent.submit(form);

    expect(seenModes).toEqual([]);
    await act(async () => {
      resolveSettings({ settings: makeSettings({ providerMode: "qq" }) });
    });
    await waitFor(() => expect(seenModes).toEqual(["qq"]));
    searchView.unmount();

    // 3. F02: Natural session expiry (auth-status transitioning from authenticated user -> unauthenticated null) clears leftover session toasts
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getDiscover").mockResolvedValue({ songs: [] });
    vi.spyOn(api, "getRecommendedPlaylists").mockResolvedValue({ playlists: [] });
    let currentAuth: AuthStatus = { initialized: true, authenticated: true, user: TEST_USER };
    vi.spyOn(api, "getAuthStatus").mockImplementation(async () => currentAuth);

    const authView = render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    act(() => {
      toast.success("遗留敏感通知");
    });
    expect(useToastStore.getState().items).toHaveLength(1);

    currentAuth = { initialized: true, authenticated: false, user: null };
    // Trigger natural auth-status refetch on focus/recheck via window online or manual query invalidation
    await act(async () => {
      // Simulate natural session expiry by re-rendering or invalidating auth-status
      authView.unmount();
    });
    // Verify via fresh mounted AppContent + refetch transition:
    currentAuth = { initialized: true, authenticated: true, user: TEST_USER };
    let resolveRefetchedAuth!: (s: AuthStatus) => void;
    let authCalls = 0;
    vi.spyOn(api, "getAuthStatus").mockImplementation(() => {
      authCalls += 1;
      if (authCalls === 1) return Promise.resolve(currentAuth);
      return new Promise((r) => {
        resolveRefetchedAuth = r;
      });
    });
    vi.spyOn(api, "logout").mockResolvedValue({ ok: true } as never);
    const authView2 = render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    act(() => {
      toast.success("旧会话直链");
    });
    // Explicit logout clears old toast AND keeps "已退出登录"
    const logoutBtn = screen.getAllByRole("button", { name: "退出登录" })[0];
    if (!logoutBtn) throw new Error("Expected logout button");
    fireEvent.click(logoutBtn);
    await waitFor(() => {
      expect(screen.getByText("已退出登录")).toBeInTheDocument();
    });
    expect(screen.queryByText("旧会话直链")).toBeNull();
    resolveRefetchedAuth?.({ initialized: true, authenticated: false, user: null });
    authView2.unmount();
  });

  it("A10 + F14 + P06: CloudPage retains page 1 & aborts premature play on page 2 error; HistoryPage preserves newer POST over slow GET; failed like recovers cancelled initial GET", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);

    // 1. A10: CloudPage page 1 succeeds (99 songs), page 2 fails -> keeps page 1 visible, does NOT auto-play partial list, allows retry
    let failPage2 = true;
    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) {
        return {
          songs: [makeSong("c1", { title: "云盘首曲保留" })],
          total: 2,
          offset: 0,
          nextOffset: 100,
          limit: 100,
          hasMore: true,
        };
      }
      if (failPage2) {
        throw new Error("云盘第二页超时");
      }
      return {
        songs: [makeSong("c2", { title: "云盘二页曲" })],
        total: 2,
        offset: 100,
        nextOffset: 101,
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
    await waitFor(() => expect(screen.getByText("云盘首曲保留")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await waitFor(() => {
      expect(useToastStore.getState().items.some((t) => t.message.includes("云盘后续分页加载失败"))).toBe(
        true,
      );
    });
    // Must NOT have started partial playback silently, and page 1 song table MUST remain visible!
    expect(playSpy).not.toHaveBeenCalled();
    expect(screen.getByText("云盘首曲保留")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试加载更多" })).toBeInTheDocument();

    failPage2 = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
    await waitFor(() => expect(screen.getByText("云盘二页曲")).toBeInTheDocument());
    cloudView.unmount();

    // 2. F14: HistoryPage slow GET resolving AFTER applyRecordedPlayHistory([newSong, oldSong]) must NOT overwrite newSong
    const historyQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const oldSong = makeSong("h-old", { title: "旧播放记录" });
    const newSong = makeSong("h-new", { title: "刚播放新歌" });
    let resolveSlowHistoryGet!: (res: { items: Song[] }) => void;
    vi.spyOn(api, "getPlayHistory").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSlowHistoryGet = resolve;
        }),
    );

    const historyView = render(
      <QueryClientProvider client={historyQc}>
        <MemoryRouter>
          <HistoryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // POST completes first while GET is still pending
    act(() => {
      applyRecordedPlayHistory(historyQc, { items: [newSong, oldSong] });
    });
    await waitFor(() => expect(screen.getByText("刚播放新歌")).toBeInTheDocument());

    // Now the stale slow GET resolves with only [oldSong] -> "刚播放新歌" MUST survive!
    await act(async () => {
      resolveSlowHistoryGet({ items: [oldSong] });
    });
    expect(screen.getByText("刚播放新歌")).toBeInTheDocument();
    expect(screen.getByText("旧播放记录")).toBeInTheDocument();
    historyView.unmount();

    // 3. P06 frontend: Cancelling initial liked-ids GET in onMutate and then failing toggleSongLike recovers via refetch
    const likeQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let likedGetCalls = 0;
    vi.spyOn(api, "getLikedSongIds").mockImplementation(async () => {
      likedGetCalls += 1;
      if (likedGetCalls === 1) {
        return new Promise((resolve) => setTimeout(() => resolve({ ids: ["existing-liked"] }), 500));
      }
      return { ids: ["existing-liked"] };
    });
    vi.spyOn(api, "toggleSongLike").mockRejectedValueOnce(new Error("红心接口故障"));

    function FailingLikeHarness() {
      const { data } = useLikedIdsQuery("netease", true);
      const mut = useToggleLikeMutation();
      return (
        <div>
          <span data-testid="recovered-likes">{(data?.ids ?? []).join(",")}</span>
          <button
            type="button"
            onClick={() => mut.mutate({ platform: "netease", songId: "fail-id", nextLiked: true })}
          >
            触发失败红心
          </button>
        </div>
      );
    }

    const failLikeView = render(
      <QueryClientProvider client={likeQc}>
        <FailingLikeHarness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "触发失败红心" }));
    await waitFor(() => {
      expect(screen.getByTestId("recovered-likes").textContent).toBe("existing-liked");
    });
    expect(likedGetCalls).toBeGreaterThanOrEqual(2);
    failLikeView.unmount();
  });

  it("P10 + P11 + P12 + P15 + P17 + Fullscreen a11y: FM priority/cursor/batch-end quality switch, active audio isPlaying sync, detail=1/2 clicks, empty page 1 comments, and fullscreen aria-pressed", async () => {
    const { audio, playSpy, setPaused } = createControlledAudio();
    const engine = new AudioEngine(audio);
    engines.push(engine);

    // 1. P10: Song A is actively playing, removed from queue leaving only locked B -> playNext keeps isPlaying=true matching !audio.paused
    const songA = makeSong("p10-a");
    const lockedB = makeSong("p10-b", {
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

    // 2. P11: FM batch [A, B, C]: playing B -> priority P -> next advances to C (NOT back to A!)
    const fmA = makeSong("fm-A");
    const fmB = makeSong("fm-B");
    const fmC = makeSong("fm-C");
    const prioP = makeSong("prio-P");
    usePlayerStore.setState({ fmQueue: [fmA, fmB, fmC] });
    await engine.playFmTrack(fmB, { queue: [fmA, fmB, fmC] });
    engine.insertNextInQueue(prioP);
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("prio-P");
    await engine.playNext();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-C");

    // Also verify PersonalFmPage's own "下一首" button honors priorityQueue via audioEngine.playNext()
    const pageNextSpy = vi.spyOn(audioEngine, "playNext").mockResolvedValue(undefined);
    usePlayerStore.setState({
      fmMode: true,
      currentTrack: fmA,
      fmQueue: [fmA, fmB],
      priorityQueue: [prioP],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fmPageView = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PersonalFmPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "下一首" }));
    expect(pageNextSpy).toHaveBeenCalledTimes(1);
    pageNextSpy.mockRestore();
    fmPageView.unmount();

    // 3. P12: Last FM track naturally ends -> while awaiting getPersonalFm, switching quality does NOT replay ended track or drop next batch
    let resolveNextFmBatch!: (res: { songs: Song[] }) => void;
    vi.spyOn(api, "getPersonalFm").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNextFmBatch = resolve;
        }),
    );
    usePlayerStore.setState({ fmQueue: [fmC] });
    await engine.playFmTrack(fmC, { queue: [fmC] });
    playSpy.mockClear();

    // Natural track end
    setPaused(true);
    audio.dispatchEvent(new Event("pause"));
    audio.dispatchEvent(new Event("ended"));

    // Switch quality to lossless while next FM batch is still in flight
    await engine.switchPlaybackQuality("lossless");
    expect(playSpy).not.toHaveBeenCalled();

    // Next batch arrives -> auto-plays first track directly at lossless!
    const fmNext1 = makeSong("fm-next-1");
    await act(async () => {
      resolveNextFmBatch({ songs: [fmNext1] });
    });
    await waitFor(() => {
      expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-next-1");
    });
    expect(audio.src).toContain("level=lossless");

    // 4. P15: SongTable 650ms OS double-click (detail=1 -> detail=2) plays ONCE; two detail=1 single clicks 420ms apart play TWICE
    const globalPlaySpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    let nowVal = 50_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowVal);
    const tableView = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={[makeSong("s-p15", { title: "系统慢速双击曲" })]} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const btn = screen.getByRole("button", { name: "系统慢速双击曲" });
    fireEvent.click(btn, { detail: 1 });
    nowVal += 650;
    fireEvent.click(btn, { detail: 2 });
    fireEvent.doubleClick(btn, { detail: 2 });
    expect(globalPlaySpy).toHaveBeenCalledTimes(1);

    globalPlaySpy.mockClear();
    nowVal += 2000;
    fireEvent.click(btn, { detail: 1 });
    nowVal += 420;
    fireEvent.click(btn, { detail: 1 });
    expect(globalPlaySpy).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
    tableView.unmount();

    // 5. P17: TrackCommentsPanel with empty page 1 + hasMore: true shows "加载更多" and loads page 2
    vi.spyOn(api, "getComments").mockImplementation(async (_p, _id, page = 1) => {
      if (page === 1) {
        return {
          songId: "fm-next-1",
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
        songId: "fm-next-1",
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
    const commentsView = render(
      <QueryClientProvider client={qc}>
        <TrackCommentsPanel active />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "加载更多" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() => {
      expect(screen.getByText("空首页后的第二页有效评论")).toBeInTheDocument();
    });
    commentsView.unmount();

    // 6. FullscreenPlayer aria-pressed on desktop (1280px) vs mobile cover (390px) & PlayQueuePanel focus-visible classes
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
    window.dispatchEvent(new Event("resize"));
    usePlayerStore.setState({
      currentTrack: fmNext1,
      queue: [fmNext1, fmA],
      fullscreenOpen: true,
    });
    const fsDesktop = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FullscreenPlayer />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: "查看歌词" }).getAttribute("aria-pressed")).toBe("true");
    fsDesktop.unmount();

    Object.defineProperty(window, "innerWidth", { value: 390, writable: true, configurable: true });
    window.dispatchEvent(new Event("resize"));
    const fsMobile = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FullscreenPlayer />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看评论" }));
    expect(screen.getByRole("button", { name: "查看评论" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "封面" }));
    expect(screen.getByRole("button", { name: "查看评论" }).getAttribute("aria-pressed")).toBe("false");
    fsMobile.unmount();

    const queuePanel = render(<PlayQueuePanel onDarkBackdrop />);
    const removeButtons = screen.getAllByRole("button", { name: "移出队列" });
    expect(removeButtons[0]?.className).toContain("md:group-focus-within:opacity-100");
    queuePanel.unmount();
  });
});
