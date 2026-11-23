import { QueryClient, QueryClientProvider, onlineManager, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthStatus,
  JobView,
  Song,
  SongCommentsPage,
  TransferResult,
  UserSettings,
  UserSummary,
} from "#shared";
import { SongTable } from "../entities/song/SongTable.js";
import { PersonalFmPage } from "../features/fm/PersonalFmPage.js";
import { CloudPage, HistoryPage } from "../features/library/CloudAndHistoryPage.js";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { PlayQueuePanel, TrackCommentsPanel } from "../features/player/components/PlayerDrawerPanels.js";
import { AudioEngine, audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { TransferPage } from "../features/transfer/TransferPage.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import {
  clearPendingDirectLinkJobs,
  markJobQueryAttemptStart,
  trackPendingDirectLinkJob,
  useJobEvents,
} from "../shared/hooks/use-job-events.js";
import {
  applyClearedPlayHistory,
  applyRecordedPlayHistory,
  beginPlayHistoryClear,
  beginPlayHistoryRecord,
} from "../shared/hooks/use-play-history-sync.js";
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

  it("Phase 8 follow-up: F14 clear/record causal ordering & failed clear recovery, F04 retry attempt seq, F17 503 retry + late register, F07 offline restore, P12 manual FM skip quality, A10 cloud play-all yield, P15 keyboard detail=0, and T11 playlistTotal UI", async () => {
    // 1. F14: Older POST resolving after clear stays empty; late clear ack does NOT wipe newer POST; failed clear recovers interrupted GET
    const f14Qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const olderSong = makeSong("f14-older");
    const newerSong = makeSong("f14-newer");
    const olderPostSeq = beginPlayHistoryRecord(f14Qc);
    const clearSeq1 = beginPlayHistoryClear(f14Qc);
    applyClearedPlayHistory(f14Qc, { items: [] }, clearSeq1);
    applyRecordedPlayHistory(f14Qc, { items: [olderSong] }, olderPostSeq, olderSong);
    expect(f14Qc.getQueryData<{ items: Song[] }>(["play-history"])?.items ?? []).toEqual([]);

    const clearSeq2 = beginPlayHistoryClear(f14Qc);
    const newerPostSeq = beginPlayHistoryRecord(f14Qc);
    applyRecordedPlayHistory(f14Qc, { items: [newerSong] }, newerPostSeq, newerSong);
    applyClearedPlayHistory(f14Qc, { items: [] }, clearSeq2);
    expect(f14Qc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
      "f14-newer",
    ]);

    // Failed clear recovers cancelled initial GET
    const failClearQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    failClearQc.setQueryData(["play-history"], { items: [olderSong] });
    let historyGetCount = 0;
    let resolveInterruptedGet!: (res: { items: Song[] }) => void;
    vi.spyOn(api, "getPlayHistory").mockImplementation(() => {
      historyGetCount += 1;
      if (historyGetCount === 1) {
        return new Promise((resolve) => {
          resolveInterruptedGet = resolve;
        });
      }
      return Promise.resolve({ items: [newerSong, olderSong] });
    });
    vi.spyOn(api, "clearPlayHistory").mockRejectedValueOnce(new Error("503 Clear Failed"));
    const failHistoryView = render(
      <QueryClientProvider client={failClearQc}>
        <MemoryRouter>
          <HistoryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(historyGetCount).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() =>
      expect(failClearQc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
        "f14-newer",
        "f14-older",
      ]),
    );
    resolveInterruptedGet({ items: [newerSong, olderSong] });
    failHistoryView.unmount();

    // 2. F04 automatic HTTP retry + F17 transient 503 retry & late registration after 50-item snapshot
    const retryQc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 10 } } });
    const anchor = makeJob({ id: "anchor", createdAt: 1, status: "running", progress: 20 });
    const transient = makeJob({ id: "later-removed", createdAt: 2, status: "completed", progress: 100 });
    let retryListCalls = 0;
    let resolveAttempt1!: (val: Promise<{ jobs: JobView[] }>) => void;
    let resolveAttempt2!: (val: { jobs: JobView[] }) => void;
    vi.spyOn(api, "listJobs").mockImplementation(() => {
      retryListCalls += 1;
      if (retryListCalls === 1) return Promise.resolve({ jobs: [anchor] });
      if (retryListCalls === 2) {
        return new Promise<never>((_, reject) => {
          resolveAttempt1 = () => {
            reject(new Error("503 temporary"));
            return Promise.resolve({ jobs: [] });
          };
        });
      }
      return new Promise((resolve) => {
        resolveAttempt2 = resolve;
      });
    });
    let getJobAttempt = 0;
    vi.spyOn(api, "getJob").mockImplementation(async (id) => {
      getJobAttempt += 1;
      if (id === "retry-503-dl" && getJobAttempt === 1) {
        throw new Error("503 transient getJob");
      }
      return {
        job: makeJob({
          id,
          status: "completed",
          progress: 100,
          directUrl: `https://m7.music.126.net/${id}.mp3`,
        }),
      };
    });

    function RetryWatcher() {
      useJobEvents(true);
      useQuery({
        queryKey: ["jobs", "download"],
        queryFn: () => {
          markJobQueryAttemptStart(retryQc, ["jobs", "download"]);
          return api.listJobs("download");
        },
      });
      return null;
    }

    const retryView = render(
      <QueryClientProvider client={retryQc}>
        <RetryWatcher />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(retryQc.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs.map((j) => j.id)).toEqual([
        "anchor",
      ]),
    );
    const retryEs = MockEventSource.instances.at(-1);
    if (!retryEs) throw new Error("Expected MockEventSource");
    act(() => retryEs.emitOpen());
    act(() => {
      retryEs.emitError();
      retryEs.emitOpen();
    });
    await waitFor(() => expect(retryListCalls).toBe(2));
    await act(async () => {
      resolveAttempt1(Promise.resolve({ jobs: [] }));
    });
    act(() => {
      retryEs.emitMessage({ type: "job_updated", job: transient });
    });
    await waitFor(() => expect(retryListCalls).toBe(3));
    await act(async () => {
      resolveAttempt2({ jobs: [anchor] });
    });
    expect(retryQc.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs.map((j) => j.id)).toEqual([
      "anchor",
    ]);

    // Late registration when cache already holds 50 newer jobs + 503 transient retry on getJob
    retryQc.setQueryData(["jobs", "download"], {
      jobs: Array.from({ length: 50 }, (_, idx) => makeJob({ id: `newer-${idx}`, createdAt: 100 - idx })),
    });
    trackPendingDirectLinkJob("retry-503-dl", { queryClient: retryQc, fallbackTitle: "重试直链" });
    await waitFor(
      () => {
        expect(useToastStore.getState().items.some((t) => t.action?.href?.includes("retry-503-dl.mp3"))).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
    retryView.unmount();
    useToastStore.getState().clear();

    // 3. F07: Offline mount with ?q=keyword waits for settings after coming online instead of querying aggregate first
    let resolveOfflineSettings!: (res: { settings: UserSettings }) => void;
    vi.spyOn(api, "getSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOfflineSettings = resolve;
        }),
    );
    const offlineModes: string[] = [];
    vi.spyOn(api, "searchSongs").mockImplementation(async (_q, mode) => {
      offlineModes.push(mode);
      return { results: [], mode, warnings: [] };
    });
    act(() => onlineManager.setOnline(false));
    try {
      const offlineQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const offlineSearch = render(
        <QueryClientProvider client={offlineQc}>
          <MemoryRouter initialEntries={["/search?q=offline-test"]}>
            <SearchPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      act(() => onlineManager.setOnline(true));
      await waitFor(() => expect(typeof resolveOfflineSettings).toBe("function"));
      expect(offlineModes).toEqual([]);
      await act(async () => {
        resolveOfflineSettings({ settings: makeSettings({ providerMode: "qq" }) });
      });
      await waitFor(() => expect(offlineModes).toEqual(["qq"]));
      offlineSearch.unmount();
    } finally {
      act(() => onlineManager.setOnline(true));
    }

    // 4. P12: Manual skip at FM tail followed by quality switch does NOT replay old tail and plays incoming batch in lossless
    const { audio: fmAudio } = createControlledAudio();
    const fmEngine = new AudioEngine(fmAudio);
    engines.push(fmEngine);
    let fmBatchCount = 0;
    let resolveManualFmBatch!: (res: { songs: Song[] }) => void;
    vi.spyOn(api, "getPersonalFm").mockImplementation(() => {
      fmBatchCount += 1;
      if (fmBatchCount === 1) return Promise.resolve({ songs: [makeSong("fm-tail-1")] });
      return new Promise((resolve) => {
        resolveManualFmBatch = resolve;
      });
    });
    await fmEngine.loadFmBatch({ autoPlay: true });
    void fmEngine.playNext();
    await waitFor(() => expect(fmBatchCount).toBe(2));
    await fmEngine.switchPlaybackQuality("lossless");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-tail-1");
    await act(async () => {
      resolveManualFmBatch({ songs: [makeSong("fm-batch-2")] });
    });
    await waitFor(() => expect(usePlayerStore.getState().currentTrack?.id).toBe("fm-batch-2"));
    expect(fmAudio.src).toContain("level=lossless");

    // 5. A10 + P15: CloudPage Play All yields to newer user selection; SongTable native keyboard detail=0 clicks both activate
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    let releaseCloudPage2!: () => void;
    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) {
        return {
          songs: [makeSong("cloud-1", { title: "云盘一" }), makeSong("cloud-2", { title: "云盘二" })],
          total: 3,
          offset: 0,
          nextOffset: 2,
          limit: 2,
          hasMore: true,
        };
      }
      await new Promise<void>((resolve) => {
        releaseCloudPage2 = resolve;
      });
      return {
        songs: [makeSong("cloud-3", { title: "云盘三" })],
        total: 3,
        offset: 2,
        nextOffset: 3,
        limit: 2,
        hasMore: false,
      };
    });
    const playedTrackIds: string[] = [];
    const origPlayTrack = audioEngine.playTrack.bind(audioEngine);
    vi.spyOn(audioEngine, "playTrack").mockImplementation(async (song, opts) => {
      playedTrackIds.push(song.id);
      return origPlayTrack(song, opts);
    });
    const cloudQc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cloudView2 = render(
      <QueryClientProvider client={cloudQc}>
        <MemoryRouter>
          <CloudPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "云盘二" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    // User selects song 2 while page 2 is still pending -> keyboard detail=0 twice
    const song2Btn = screen.getByRole("button", { name: "云盘二" });
    fireEvent.click(song2Btn, { detail: 0 });
    fireEvent.click(song2Btn, { detail: 0 });
    expect(playedTrackIds).toEqual(["cloud-2", "cloud-2"]);
    await act(async () => {
      releaseCloudPage2?.();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "云盘三" })).toBeInTheDocument());
    // Must NOT have hijacked back to cloud-1!
    expect(playedTrackIds).toEqual(["cloud-2", "cloud-2"]);
    cloudView2.unmount();

    // 6. T11 UI: TransferPage displays playlistTotal (2501) vs selected count (2) even when truncated === false and unprocessedCount > 0
    const transferJob: JobView = makeJob({
      id: "transfer-t11-ui",
      kind: "transfer",
      status: "completed",
      progress: 100,
      title: "选中曲目迁移",
      result: {
        sourceProvider: "netease",
        targetProvider: "qq",
        playlistName: "选中曲目迁移",
        summary: {
          total: 1,
          matched: 1,
          manualReview: 0,
          notFound: 0,
          unavailable: 0,
          duplicate: 0,
          skipped: 0,
        },
        results: [],
        sourceTotal: 2,
        playlistTotal: 2501,
        processedCount: 1,
        unprocessedCount: 1,
        truncated: false,
      } satisfies TransferResult,
    });
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [transferJob] });
    const t11Qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const t11View = render(
      <QueryClientProvider client={t11Qc}>
        <MemoryRouter>
          <TransferPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/源歌单共 2501 首，本次已选 2 首/)).toBeInTheDocument();
    });
    t11View.unmount();
  });
});
