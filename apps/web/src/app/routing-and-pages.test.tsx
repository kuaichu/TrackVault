import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthStatus,
  MusicPlatform,
  PlaylistSummary,
  PlaylistTracksPage,
  ProviderCapabilities,
  Song,
  UserSettings,
  UserSummary,
} from "#shared";
import { BindingsPanel } from "../features/auth/index.js";
import { clearPendingDirectLinkJobs } from "../features/downloads/index.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { AuthGatePage } from "../pages/auth/index.js";
import { ChartDetailPage, ChartsPage } from "../pages/charts/index.js";
import { DiscoverPage } from "../pages/discover/index.js";
import { PlaylistDetailPage, PlaylistsPage } from "../pages/library/index.js";
import { SearchPage } from "../pages/search/index.js";
import { SettingsPage } from "../pages/settings/index.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import { useToastStore } from "../shared/store/toast-store.js";
import { ToastContainer } from "../shared/ui/primitives.js";
import { SongTable } from "../widgets/song-table/index.js";
import { AppContent } from "./App.js";
import { AppShell } from "./AppShell.js";

const ADMIN_USER: UserSummary = {
  id: "u-admin",
  username: "admin",
  role: "admin",
  trustedFallback: true,
  createdAt: 1,
};

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

function makeSong(id: string, platform: MusicPlatform = "netease", title = `歌曲 ${id}`): Song {
  return {
    id,
    platform,
    title,
    artist: "测试歌手",
    album: "测试专辑",
    durationSeconds: 210,
    duration: "03:30",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

describe("Phase 5 · Routing, providerMode defaults, URL state, QR polling, error states, capabilities, and validation", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();
  });

  it("navigates '/' according to settings.startupView and renders 404 for unknown routes (F06/C065)", async () => {
    const authStatus: AuthStatus = { initialized: true, authenticated: true, user: ADMIN_USER };
    vi.spyOn(api, "getAuthStatus").mockResolvedValue(authStatus);
    vi.spyOn(api, "getSettings").mockResolvedValue({
      settings: makeSettings({ startupView: "downloads" }),
    });
    vi.spyOn(api, "getPlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });

    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "下载管理" })).toBeInTheDocument();
    });
    unmount();

    // Unknown route renders 404 page instead of silent redirect to /discover
    render(
      <MemoryRouter initialEntries={["/non-existent-path"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("404 · 页面未找到")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/");
  });

  it("SearchPage uses URL as single source of truth, preserves uncommitted draft on filter change, and clears all history (F07/F08/F09/U08)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getSettings").mockResolvedValue({
      settings: makeSettings({ providerMode: "qq" }),
    });
    vi.spyOn(api, "getSearchHistory").mockResolvedValue({ items: ["周杰伦", "林俊杰"] });
    const removeHistorySpy = vi.spyOn(api, "removeSearchHistory").mockResolvedValue({ items: [] });
    const searchSongsSpy = vi.spyOn(api, "searchSongs").mockResolvedValue({
      results: [makeSong("s1", "qq", "晴天")],
      mode: "qq",
      warnings: [],
    });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/search?q=晴天"]}>
          <LocationProbe />
          <SearchPage />
          <ToastContainer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Defaults to user settings providerMode ('qq') when URL lacks mode
    await waitFor(() => {
      expect(searchSongsSpy).toHaveBeenCalledWith("晴天", "qq", expect.any(AbortSignal));
    });

    // Type an uncommitted new draft, then switch mode -> draft must NOT be overwritten (F09)
    const input = screen.getByPlaceholderText("输入歌名、歌手、专辑或歌单...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "未提交草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "网易云" }));

    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toContain("mode=netease");
    });
    expect(input.value).toBe("未提交草稿");

    // Clear all search history button calls api.removeSearchHistory(undefined)
    fireEvent.click(screen.getByRole("button", { name: /清空全部历史/ }));
    await waitFor(() => {
      expect(removeHistorySpy).toHaveBeenCalledWith(undefined);
    });
  });

  it("ChartsPage persists ?platform= in URL and macOS < > history controls navigate back/forward preserving platform (U08)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getSettings").mockResolvedValue({
      settings: makeSettings({ providerMode: "netease" }),
    });
    vi.spyOn(api, "getCharts").mockImplementation(async (platform) => ({
      charts: [
        {
          id: platform === "qq" ? "qq-top-1" : "ne-top-1",
          platform,
          name: platform === "qq" ? "QQ 热歌榜" : "云音乐飙升榜",
        },
      ],
    }));
    vi.spyOn(api, "getChartDetail").mockResolvedValue({
      chart: { id: "qq-top-1", platform: "qq", name: "QQ 热歌榜" },
      songs: [],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/charts"]}>
          <LocationProbe />
          <AppShell user={ADMIN_USER}>
            <Routes>
              <Route path="/charts" element={<ChartsPage />} />
              <Route path="/charts/:platform/:id" element={<ChartDetailPage />} />
            </Routes>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const backBtn = screen.getByRole("button", { name: "后退" });
    const forwardBtn = screen.getByRole("button", { name: "前进" });
    expect(backBtn).toBeDisabled();
    expect(forwardBtn).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText("云音乐飙升榜")).toBeInTheDocument();
    });

    // Switch to QQ -> URL pushes ?platform=qq onto history stack (< lights up)
    fireEvent.click(screen.getByRole("button", { name: "QQ 音乐" }));
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe("/charts?platform=qq");
      expect(screen.getByText("QQ 热歌榜")).toBeInTheDocument();
    });
    expect(backBtn).not.toBeDisabled();

    // Navigate into QQ chart detail -> clicking < returns to /charts?platform=qq and lights up >
    fireEvent.click(screen.getByText("QQ 热歌榜"));
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe("/charts/qq/qq-top-1");
      expect(screen.getByRole("heading", { name: "QQ 热歌榜" })).toBeInTheDocument();
    });
    expect(backBtn).not.toBeDisabled();
    expect(forwardBtn).toBeDisabled();

    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe("/charts?platform=qq");
    });
    expect(backBtn).not.toBeDisabled();
    expect(forwardBtn).not.toBeDisabled();

    // Second < click reaches initial entry /charts -> < dims back to disabled
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe("/charts");
    });
    expect(backBtn).toBeDisabled();
    expect(forwardBtn).not.toBeDisabled();
  });

  it("PlaylistDetailPage resets on playlist switch, clamps page after deleting last track on final page, and offers title-desc sort (F12/F13/C065)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });

    let totalTracks = 51;
    const getPlaylistTracksSpy = vi
      .spyOn(api, "getPlaylistTracks")
      .mockImplementation(async (platform, id, params): Promise<PlaylistTracksPage> => {
        const page = params?.page ?? 1;
        const playlist: PlaylistSummary = {
          id,
          platform,
          name: `歌单 ${id}`,
          trackCount: totalTracks,
          creatorName: "Tester",
          owned: true,
        };
        if (page === 2) {
          return {
            playlist,
            songs: totalTracks > 50 ? [makeSong("last-51", platform, "末页唯一曲")] : [],
            total: totalTracks,
            page: 2,
            limit: 50,
            hasMore: false,
          };
        }
        return {
          playlist,
          songs: [makeSong("first-1", platform, "首页曲目")],
          total: totalTracks,
          page: 1,
          limit: 50,
          hasMore: totalTracks > 50,
        };
      });

    vi.spyOn(api, "removeTracksFromPlaylist").mockImplementation(async () => {
      totalTracks = 50;
      return { removedCount: 1 };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/playlists/netease/pl-1"]}>
          <Routes>
            <Route path="/playlists/:platform/:id" element={<PlaylistDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("首页曲目")).toBeInTheDocument();
    });

    // AppleSelect custom combobox exposes '按歌名 Z–A' (title-desc) option in portaled listbox
    const sortTrigger = screen.getByRole("combobox", { name: "歌单排序" });
    fireEvent.click(sortTrigger);
    expect(screen.getByRole("option", { name: "按歌名 Z–A" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "默认排序" }));

    // Go to page 2
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => {
      expect(screen.getByText("末页唯一曲")).toBeInTheDocument();
      expect(screen.getByText("第 2 / 2 页")).toBeInTheDocument();
    });

    // Delete the only track on page 2 -> clamps back to page 1 and invalidates ["playlists"]
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: /从歌单移除/ }));

    await waitFor(() => {
      expect(screen.getByText("首页曲目")).toBeInTheDocument();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["playlists", "netease"] });
    expect(getPlaylistTracksSpy).toHaveBeenLastCalledWith(
      "netease",
      "pl-1",
      expect.objectContaining({ page: 1 }),
    );
  });

  it("BindingsPanel uses serial QR polling with AbortSignal, isolates regenerated QR keys, surfaces errors, and renders error retry (F10/F18/B47)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });

    // 1) Bindings load error shows retry button instead of stuck skeleton
    const listBindingsSpy = vi
      .spyOn(api, "listBindings")
      .mockRejectedValueOnce(new Error("服务不可达"))
      .mockResolvedValue({
        bindings: {
          netease: {
            platform: "netease",
            connected: false,
            accountUid: null,
            displayName: null,
            avatarUrl: null,
            vipEnabled: false,
            vipExpireAt: null,
            verifiedAt: null,
          },
          qq: {
            platform: "qq",
            connected: false,
            accountUid: null,
            displayName: null,
            avatarUrl: null,
            vipEnabled: false,
            vipExpireAt: null,
            verifiedAt: null,
          },
          kugou: {
            platform: "kugou",
            connected: false,
            accountUid: null,
            displayName: null,
            avatarUrl: null,
            vipEnabled: false,
            vipExpireAt: null,
            verifiedAt: null,
          },
        },
      });

    let qrSeq = 0;
    vi.spyOn(api, "startQrLogin").mockImplementation(async () => {
      qrSeq += 1;
      return {
        key: `qr-${qrSeq}`,
        qrImage: `data:image/png;base64,QR${qrSeq}`,
      };
    });

    let resolveQr1!: (val: { status: "expired"; code: number; message: string }) => void;
    let capturedSignal1: AbortSignal | undefined;
    const checkQrSpy = vi.spyOn(api, "checkQrLogin").mockImplementation((_platform, key, signal) => {
      if (key === "qr-1") {
        capturedSignal1 = signal;
        return new Promise((resolve) => {
          resolveQr1 = resolve;
        });
      }
      return Promise.reject(new Error("网络断开"));
    });

    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <BindingsPanel />
        <ToastContainer />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("未能加载平台绑定状态")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(screen.getByText("网易云音乐")).toBeInTheDocument();
    });
    expect(listBindingsSpy).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();

    // Start QR-1
    const [neteaseScanButton] = screen.getAllByRole("button", { name: /扫码登录/ });
    expect(neteaseScanButton).toBeDefined();
    await act(async () => {
      if (neteaseScanButton) fireEvent.click(neteaseScanButton);
      await Promise.resolve();
    });
    expect(screen.getByAltText("网易云音乐登录二维码")).toHaveAttribute("src", "data:image/png;base64,QR1");

    // Advance 2.5s -> QR-1 check starts (in-flight)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(checkQrSpy).toHaveBeenCalledWith("netease", "qr-1", expect.any(AbortSignal));

    // Regenerate QR-2 while QR-1 is still in-flight -> QR-1 AbortSignal is aborted
    await act(async () => {
      if (neteaseScanButton) fireEvent.click(neteaseScanButton);
      await Promise.resolve();
    });
    expect(capturedSignal1?.aborted).toBe(true);
    expect(screen.getByAltText("网易云音乐登录二维码")).toHaveAttribute("src", "data:image/png;base64,QR2");

    // Even if QR-1 resolves as expired afterwards, QR-2 MUST stay visible (F10)
    await act(async () => {
      resolveQr1({ status: "expired", code: 800, message: "旧码已过期" });
      await Promise.resolve();
    });
    expect(screen.getByAltText("网易云音乐登录二维码")).toHaveAttribute("src", "data:image/png;base64,QR2");

    // Advance 2.5s -> QR-2 poll fails -> error message is shown visibly instead of silently swallowed
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText(/网络波动（网络断开）/)).toBeInTheDocument();

    unmount();
  });

  it("DiscoverPage decouples recommended playlists and songs error/empty states with independent retry (F11/B48)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getDiscover").mockResolvedValue({ songs: [] });
    const recSpy = vi
      .spyOn(api, "getRecommendedPlaylists")
      .mockRejectedValueOnce(new Error("推荐歌单超时"))
      .mockResolvedValue({
        playlists: [
          {
            id: "rec-1",
            platform: "netease",
            name: "深夜自习室",
            trackCount: 25,
            creatorName: "Editor",
            owned: false,
          },
        ],
      });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/discover"]}>
          <DiscoverPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Songs are empty, yet Recommended Playlists section still renders independently and shows its error + retry
    await waitFor(() => {
      expect(screen.getByText("暂无推荐内容")).toBeInTheDocument();
      expect(screen.getByText("未能加载推荐歌单")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => {
      expect(screen.getByText("深夜自习室")).toBeInTheDocument();
    });
    expect(recSpy).toHaveBeenCalledTimes(2);
  });

  it("enforces username minLength/pattern on AuthGatePage and SettingsPage and disables empty fallback submission (B47/B49/C063)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // 1) AuthGatePage setup admin username attributes
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <AuthGatePage initialized={false} />
      </QueryClientProvider>,
    );

    const setupUsername = screen.getByLabelText("用户名") as HTMLInputElement;
    expect(setupUsername).toHaveAttribute("minLength", "2");
    expect(setupUsername).toHaveAttribute("maxLength", "32");
    expect(setupUsername).toHaveAttribute("pattern", "^[a-zA-Z0-9_.-]+$");
    unmount();

    // 2) SettingsPage admin console member input + fallback submit disabled when empty & unconfigured
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "listBindings").mockResolvedValue({
      bindings: {
        netease: {
          platform: "netease",
          connected: false,
          accountUid: null,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          verifiedAt: null,
        },
        qq: {
          platform: "qq",
          connected: false,
          accountUid: null,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          verifiedAt: null,
        },
        kugou: {
          platform: "kugou",
          connected: false,
          accountUid: null,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          verifiedAt: null,
        },
      },
    });
    vi.spyOn(api, "listMembers").mockResolvedValue({ members: [ADMIN_USER] });
    vi.spyOn(api, "listSystemFallbacks").mockResolvedValue({
      fallbacks: {
        netease: { platform: "netease", configured: false, enabled: false, updatedAt: null },
        qq: { platform: "qq", configured: false, enabled: false, updatedAt: null },
        kugou: { platform: "kugou", configured: false, enabled: false, updatedAt: null },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SettingsPage user={ADMIN_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const memberUsername = screen.getByPlaceholderText("新成员用户名") as HTMLInputElement;
    expect(memberUsername).toHaveAttribute("minLength", "2");
    expect(memberUsername).toHaveAttribute("maxLength", "32");
    expect(memberUsername).toHaveAttribute("pattern", "^[a-zA-Z0-9_.-]+$");

    await waitFor(() => {
      const saveButtons = screen.getAllByRole("button", { name: "保存并启用" });
      expect(saveButtons).toHaveLength(3);
      expect(saveButtons[0]).toBeDisabled();
      expect(saveButtons[1]).toBeDisabled();
      expect(saveButtons[2]).toBeDisabled();
    });

    const [neteaseCookieInput] = screen.getAllByPlaceholderText("输入新的保底 Cookie");
    expect(neteaseCookieInput).toBeDefined();
    if (neteaseCookieInput) {
      fireEvent.change(neteaseCookieInput, { target: { value: "MUSIC_U=validtoken" } });
    }

    const saveButtonsAfter = screen.getAllByRole("button", { name: "保存并启用" });
    expect(saveButtonsAfter[0]).not.toBeDisabled();
    expect(saveButtonsAfter[1]).toBeDisabled();
    expect(saveButtonsAfter[2]).toBeDisabled();
  });

  it("SongTable disables only the clicked song's download button and PlaylistsPage obeys api.getCapabilities (B51/C066)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    const customCaps: Record<MusicPlatform, ProviderCapabilities> = {
      netease: { ...DEFAULT_PROVIDER_CAPABILITIES.netease, canCreatePlaylist: false },
      qq: { ...DEFAULT_PROVIDER_CAPABILITIES.qq, canCreatePlaylist: true },
      kugou: { ...DEFAULT_PROVIDER_CAPABILITIES.kugou, canCreatePlaylist: true },
    };
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: customCaps });
    vi.spyOn(api, "getUserPlaylists").mockResolvedValue({ playlists: [] });

    let resolveDownload!: (val: { job: import("#shared").JobView }) => void;
    vi.spyOn(api, "createDownloadJob").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const songs = [makeSong("1", "netease", "第一首"), makeSong("2", "netease", "第二首")];

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/playlists"]}>
          <PlaylistsPage />
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Capabilities override: NetEase canCreatePlaylist=false hides 新建歌单; switching to QQ (true) shows it
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /新建歌单/ })).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "QQ 音乐" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /新建歌单/ })).toBeInTheDocument();
    });

    // Clicking download on song 1 disables ONLY song 1's button, leaving song 2 enabled
    const btn1 = screen.getByRole("button", { name: "下载 第一首" });
    const btn2 = screen.getByRole("button", { name: "下载 第二首" });
    fireEvent.click(btn1);

    await waitFor(() => {
      expect(btn1).toBeDisabled();
      expect(btn2).not.toBeDisabled();
    });

    await act(async () => {
      resolveDownload({
        job: {
          id: "dl-1",
          kind: "download",
          status: "queued",
          progress: 0,
          title: "第一首",
          createdAt: 1,
          updatedAt: 1,
          downloadReady: false,
          artifactExpired: false,
        },
      });
    });

    await waitFor(() => {
      expect(btn1).not.toBeDisabled();
    });
  });

  it("PlaylistsPage separates owned and collected sections, hides group headers in single-filter mode, omits repetitive '自建' tag, and pins favorite badge", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getUserPlaylists").mockResolvedValue({
      playlists: [
        {
          id: "pl-fav",
          platform: "netease",
          name: "KuaiChu喜欢的音乐",
          trackCount: 7636,
          creatorName: "KuaiChu",
          owned: true,
        },
        {
          id: "pl-own-2",
          platform: "netease",
          name: "纯音乐",
          trackCount: 25,
          creatorName: "KuaiChu",
          owned: true,
        },
        {
          id: "pl-col-1",
          platform: "netease",
          name: "孤独诗人的慰藉",
          trackCount: 42,
          creatorName: "独立策展人",
          owned: false,
        },
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/playlists"]}>
          <PlaylistsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "我创建的" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "收藏的歌单" })).toBeInTheDocument();
    });

    // Owned subtitles omit repetitive '自建'; collected subtitles show creator + count; favorite badge is pinned
    expect(screen.queryByText("自建")).toBeNull();
    expect(screen.getByText("独立策展人")).toBeInTheDocument();
    expect(screen.getByLabelText("我喜欢的音乐")).toBeInTheDocument();

    // Switching to '收藏' hides group headings and shows only collected playlists
    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(screen.queryByRole("heading", { name: "收藏的歌单" })).toBeNull();
    expect(screen.queryByText("纯音乐")).toBeNull();
    expect(screen.getByText("孤独诗人的慰藉")).toBeInTheDocument();

    // Switching to '我创建的' hides group headings and keeps '+ 新建歌单' accessible
    fireEvent.click(screen.getByRole("button", { name: "我创建的" }));
    expect(screen.queryByRole("heading", { name: "我创建的" })).toBeNull();
    expect(screen.getByText("纯音乐")).toBeInTheDocument();
    expect(screen.queryByText("孤独诗人的慰藉")).toBeNull();
    expect(screen.getByRole("button", { name: /新建歌单/ })).toBeInTheDocument();
  });

  it("DiscoverPage omits '点击即播', exposes '···' context menu on quick picks, and AppShell shows mobile '< 返回' only on detail sub-pages", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeSettings() });
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getDiscover").mockResolvedValue({
      songs: [makeSong("d-1", "netease", "冬天又来临"), makeSong("d-2", "netease", "Hong Kong")],
    });
    vi.spyOn(api, "getRecommendedPlaylists").mockResolvedValue({ playlists: [] });

    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/discover"]}>
          <AppShell user={ADMIN_USER}>
            <DiscoverPage />
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("冬天又来临").length).toBeGreaterThanOrEqual(2);
    });

    // Primary route hides mobile '<' back button (`hidden md:inline-flex`), keeps top-bar flex-1 wrapper pointer-events-none so Row 1 controls stay clickable, and sets scroll-px-4 on showcase strip
    const primaryBackBtn = screen.getByRole("button", { name: "后退" });
    expect(primaryBackBtn.className).toContain("hidden md:inline-flex");
    expect(primaryBackBtn.parentElement?.parentElement?.className).toContain("pointer-events-none");
    expect(document.querySelector("[data-discover-carousel='true']")?.className).toContain("scroll-px-4");
    expect(screen.queryByText("点击即播")).toBeNull();
    expect(screen.getByRole("button", { name: "播放全部" }).parentElement?.className).toContain(
      "items-center",
    );

    // Compact mobile platform dropdown pill opens popover with platform radio items & refresh action
    const mobilePlatformPill = document.querySelector("button[aria-haspopup='menu']") as HTMLElement | null;
    expect(mobilePlatformPill).not.toBeNull();
    fireEvent.click(mobilePlatformPill as HTMLElement);
    expect(screen.getByRole("menu", { name: "选择推荐音源" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /刷新推荐/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: "更多操作 冬天又来临" }));
    const portalMenu = screen.getByRole("menu", { name: "冬天又来临 操作菜单" });
    expect(portalMenu).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下一首播放/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /收藏到歌单/ })).toBeInTheDocument();
    unmount();

    // Detail sub-page reveals mobile '< 返回' (`inline-flex`)
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/playlists/netease/pl-99"]}>
          <AppShell user={ADMIN_USER}>
            <div>详情页</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const detailBackBtn = screen.getByRole("button", { name: "后退" });
    expect(detailBackBtn.className).toContain("inline-flex");
    expect(detailBackBtn.className).not.toContain("hidden md:inline-flex");
    expect(detailBackBtn).toHaveTextContent("返回");
  });
});
