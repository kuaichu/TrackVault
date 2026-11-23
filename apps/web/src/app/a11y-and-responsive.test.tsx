import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song, UserSettings, UserSummary } from "#shared";
import { SongTable } from "../entities/song/SongTable.js";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { RightDrawer } from "../features/player/components/RightDrawer.js";
import { audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import { useModalFocusTrap } from "../shared/hooks/use-modal-focus-trap.js";
import { useToastStore } from "../shared/store/toast-store.js";
import { CoverArt, ExpandableText } from "../shared/ui/primitives.js";
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

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: overrides.id ?? "s1",
    platform: overrides.platform ?? "netease",
    title: overrides.title ?? "测试歌曲",
    artist: overrides.artist ?? "测试歌手",
    album: overrides.album ?? "测试专辑",
    durationSeconds: overrides.durationSeconds ?? 210,
    duration: overrides.duration ?? "03:30",
    quality: overrides.quality ?? "320K",
    availableQualities: overrides.availableQualities ?? [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
    ...overrides,
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

function FocusTrapHarness() {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDialogElement | null>(null);
  useModalFocusTrap(modalRef, open, { onClose: () => setOpen(false) });

  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开弹窗
      </button>
      {open && (
        <dialog ref={modalRef} open aria-modal="true" aria-label="测试弹窗">
          <button type="button">第一个按钮</button>
          <button type="button">第二个按钮</button>
          <button type="button" onClick={() => setOpen(false)}>
            关闭按钮
          </button>
        </dialog>
      )}
    </div>
  );
}

describe("Phase 6 · Responsive layout, safe-area, focus trap, keyboard a11y, and UI polish", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
    useToastStore.getState().clear();

    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      capabilities: DEFAULT_PROVIDER_CAPABILITIES,
    });
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
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "isSongLiked").mockResolvedValue({ liked: false });
    vi.spyOn(api, "getLyrics").mockResolvedValue({
      lyrics: { platform: "netease", songId: "s1", lines: [], source: "none" },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    usePlayerStore.getState().reset();
    useToastStore.getState().clear();
  });

  it("resets CoverArt failed state when src changes and applies darkBackdrop styles (U07/C077)", () => {
    const { rerender } = render(
      <CoverArt src="https://p1.music.126.net/broken.jpg" alt="封面A" darkBackdrop />,
    );

    const img = screen.getByRole("img", { name: "封面A" });
    expect(img.className).toContain("bg-white/10");

    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "封面A" })).toBeNull();
    const fallback = screen.getByLabelText("封面A");
    expect(fallback.className).toContain("bg-white/10");
    expect(fallback.className).not.toContain("bg-[var(--tv-surface)]");

    rerender(<CoverArt src="https://p1.music.126.net/good.jpg" alt="封面B" darkBackdrop />);
    const recoveredImg = screen.getByRole("img", { name: "封面B" });
    expect(recoveredImg.getAttribute("src")).toBe("https://p1.music.126.net/good.jpg");
  });

  it("ExpandableText detects actual overflow and toggles expand/collapse (U06)", () => {
    const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(60);
    const clientHeightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(36);

    const { rerender } = render(
      <ExpandableText text="这是一段在窄屏上只有七十多字但实际超过两行高度而被截断的简介。" />,
    );

    const expandBtn = screen.getByRole("button", { name: /展开/ });
    expect(expandBtn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(expandBtn);
    const collapseBtn = screen.getByRole("button", { name: /收起/ });
    expect(collapseBtn.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseBtn);
    expect(screen.getByRole("button", { name: /展开/ })).toBeTruthy();

    scrollHeightSpy.mockReturnValue(36);
    clientHeightSpy.mockReturnValue(36);
    rerender(<ExpandableText text="短简介" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("useModalFocusTrap cycles Tab/Shift+Tab inside modal and restores focus on close (U04)", () => {
    render(<FocusTrapHarness />);

    const trigger = screen.getByRole("button", { name: "打开弹窗" });
    trigger.focus();
    fireEvent.click(trigger);

    const first = screen.getByRole("button", { name: "第一个按钮" });
    const closeBtn = screen.getByRole("button", { name: "关闭按钮" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from first wraps to last
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeBtn);

    // Tab from last wraps back to first
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Escape closes and restores focus to trigger
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("sets inert on underlying shell when fullscreen player or mobile drawer opens, closes drawer on same-route click, and guards shortcuts (U03/U04/U05/C072/C077)", () => {
    const togglePlaySpy = vi.spyOn(audioEngine, "togglePlay").mockResolvedValue(undefined);
    const qc = createTestQueryClient();

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/discover"]}>
          <AppShell user={ADMIN_USER}>
            <div>
              <button type="button">普通按钮</button>
              <a href="#demo">普通链接</a>
              <div
                role="slider"
                tabIndex={0}
                aria-label="示例滑块"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={50}
              />
              <div role="tab" tabIndex={0}>
                示例页签
              </div>
            </div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Top bar search input has explicit aria-label (C077)
    const searchInput = screen.getByRole("textbox", { name: "搜索歌曲、歌手或专辑" });
    expect(searchInput).toBeTruthy();

    // Space key on interactive elements must NOT trigger audioEngine.togglePlay (U05)
    for (const el of [
      screen.getByRole("button", { name: "普通按钮" }),
      screen.getByRole("link", { name: "普通链接" }),
      screen.getByRole("slider", { name: "示例滑块" }),
      screen.getByRole("tab", { name: "示例页签" }),
    ]) {
      fireEvent.keyDown(el, { key: " ", code: "Space", bubbles: true });
    }
    expect(togglePlaySpy).not.toHaveBeenCalled();

    // Space key on non-interactive main area triggers playback
    fireEvent.keyDown(document.body, { key: " ", code: "Space", bubbles: true });
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);

    // '/' focuses search input when no modal is open
    fireEvent.keyDown(document.body, { key: "/", bubbles: true });
    expect(document.activeElement).toBe(searchInput);
    searchInput.blur();

    // Open mobile navigation drawer -> underlying main shell becomes inert
    fireEvent.click(screen.getByRole("button", { name: "打开导航菜单" }));
    const mobileNavDialog = screen.getByRole("dialog", { name: "导航菜单" });
    expect(mobileNavDialog).toBeTruthy();
    const mainEl = screen.getByRole("main");
    expect(mainEl.closest("[inert]")).not.toBeNull();

    // Clicking the already-active '/discover' link inside mobile drawer closes it immediately (U03)
    const discoverLinks = mobileNavDialog.querySelectorAll("a[href='/discover']");
    expect(discoverLinks.length).toBeGreaterThan(0);
    fireEvent.click(discoverLinks[0] as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
    expect(mainEl.closest("[inert]")).toBeNull();

    // Opening FullscreenPlayer sets inert on shell and blocks '/' from focusing underlying search input (C072)
    act(() => {
      usePlayerStore.getState().setStatePatch({
        currentTrack: makeSong({ id: "fs-1", title: "全屏歌曲" }),
        fullscreenOpen: true,
      });
    });
    expect(mainEl.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(document.body, { key: "/", bubbles: true });
    expect(document.activeElement).not.toBe(searchInput);
  });

  it("FullscreenPlayer mounts a single PlaybackProgressBar, renders loading/error states, and exposes desktop controls (U01/C072)", () => {
    const qc = createTestQueryClient();
    usePlayerStore.getState().setStatePatch({
      currentTrack: makeSong({ id: "fs-2", title: "横屏曲目" }),
      fullscreenOpen: true,
      isLoading: true,
      playerError: "音源暂时不可用",
    });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FullscreenPlayer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Exactly ONE progress slider is mounted (no hidden duplicate)
    expect(screen.getAllByRole("slider", { name: "播放进度" })).toHaveLength(1);
    // Error banner & desktop controls (comments, queue, volume) are visible
    expect(screen.getByRole("alert").textContent).toContain("音源暂时不可用");
    expect(screen.getByRole("button", { name: "查看评论" }).className).not.toContain("md:hidden");
    expect(screen.getByRole("button", { name: "查看队列" }).className).not.toContain("md:hidden");
    expect(screen.getByRole("slider", { name: "全屏音量" })).toBeTruthy();
    // Main container allows vertical scroll fallback for short landscape screens
    const dialog = screen.getByRole("dialog", { name: "沉浸歌词播放" });
    expect(dialog.innerHTML).toContain("overflow-y-auto");
    expect(dialog.innerHTML).toContain("dvh");
  });

  it("SongTable deduplicates rapid click/double-click within 350ms, respects download.locked, handles duplicate tracks, and flips bottom menu upward (P15/C069/C076)", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const playlistsDeferred: { resolve?: (val: { playlists: [] }) => void } = {};
    vi.spyOn(api, "getUserPlaylists").mockImplementation(
      () =>
        new Promise((resolve) => {
          playlistsDeferred.resolve = resolve;
        }),
    );

    const dupSong = makeSong({ id: "dup-1", title: "重复曲目" });
    const lockedSong = makeSong({
      id: "lock-1",
      title: "不可下载曲目",
      availability: {
        playback: { status: "available", label: "可播放", reason: "", locked: false },
        download: { status: "copyright", label: "无版权", reason: "版权方禁止下载", locked: true },
      },
    });
    const songs = [dupSong, dupSong, makeSong({ id: "s3", title: "第三首" }), lockedSong];

    const qc = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SongTable songs={songs} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Container query enabled on table root (C069)
    expect(container.firstElementChild?.className).toContain("@container");

    // No React duplicate key warnings even with duplicate songs
    expect(consoleErrorSpy.mock.calls.some((args) => String(args[0]).includes("same key"))).toBe(false);

    // Rapid double click sequence (click + click + dblclick) invokes playTrack only once within 350ms (P15)
    const firstTitleBtn = screen.getAllByRole("button", { name: "重复曲目" })[0] as HTMLElement;
    fireEvent.click(firstTitleBtn);
    fireEvent.click(firstTitleBtn);
    fireEvent.doubleClick(firstTitleBtn);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Locked song disables download button with clear reason title
    const lockedDownloadBtn = screen.getByRole("button", { name: "下载 不可下载曲目" });
    expect((lockedDownloadBtn as HTMLButtonElement).disabled).toBe(true);
    expect(lockedDownloadBtn.getAttribute("title")).toContain("版权方禁止下载");

    // Bottom row's context menu flips upward (bottom-full) and shows loading state for playlists
    const moreButtons = screen.getAllByRole("button", { name: "更多操作" });
    fireEvent.click(moreButtons[moreButtons.length - 1] as HTMLElement);
    const nextPlayItem = screen.getByRole("button", { name: "下一首播放" });
    expect(nextPlayItem.parentElement?.className).toContain("bottom-full");

    fireEvent.click(screen.getByRole("button", { name: /收藏到歌单/ }));
    expect(screen.getByText("加载歌单中...")).toBeTruthy();

    playlistsDeferred.resolve?.({ playlists: [] });
    await waitFor(() => {
      expect(screen.getByText("暂无自建歌单")).toBeTruthy();
    });
  });

  it("SettingsPage prevents 320px member row overflow and supports disabling/enabling system fallback without re-pasting Cookie (U02/C077)", async () => {
    const longUsername = "a".repeat(32);
    vi.spyOn(api, "listMembers").mockResolvedValue({
      members: [
        ADMIN_USER,
        {
          id: "u-long",
          username: longUsername,
          role: "member",
          trustedFallback: false,
          createdAt: 2,
        },
      ],
    });
    vi.spyOn(api, "listSystemFallbacks").mockResolvedValue({
      fallbacks: {
        netease: { platform: "netease", configured: true, enabled: true, updatedAt: 10 },
        qq: { platform: "qq", configured: false, enabled: false, updatedAt: null },
      },
    });
    const saveFallbackSpy = vi.spyOn(api, "saveSystemFallback").mockResolvedValue({
      fallback: { platform: "netease", configured: true, enabled: false, updatedAt: 11 },
    });

    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SettingsPage user={ADMIN_USER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const longNameEl = await screen.findByText(longUsername);
    expect(longNameEl.className).toContain("truncate");
    expect(longNameEl.parentElement?.className).toContain("min-w-0");
    expect(longNameEl.parentElement?.className).toContain("flex-1");

    // Disable button toggles enabled: false without clearing cookie or requiring draft input
    const disableBtn = await screen.findByRole("button", { name: "停用" });
    fireEvent.click(disableBtn);

    await waitFor(() => {
      expect(saveFallbackSpy).toHaveBeenCalledWith("netease", {
        cookie: undefined,
        enabled: false,
        clearCookie: undefined,
      });
    });
  });

  it("RightDrawer uses xl: static breakpoint without inline zIndex and closes on Escape in overlay mode (C069/C073)", () => {
    const qc = createTestQueryClient();
    usePlayerStore.getState().setStatePatch({ drawerOpen: true, drawerTab: "queue" });

    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RightDrawer />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.style.zIndex).toBe("");
    expect(rootDiv.className).toContain("xl:static");
    expect(rootDiv.className).toContain("xl:z-auto");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(usePlayerStore.getState().drawerOpen).toBe(false);
  });
});
