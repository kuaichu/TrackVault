import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserSettings } from "#shared";
import { SearchPage } from "../pages/search/index.js";
import { api } from "../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../shared/hooks/use-capabilities.js";
import { toast, useToastStore } from "../shared/store/toast-store.js";
import { ToastContainer } from "../shared/ui/primitives.js";
import { makeTestSettings, makeTestUser, renderWithProviders } from "../test-utils/fixtures.js";
import { AppContent } from "./App.js";
import { AppShell } from "./AppShell.js";

describe("Session lifecycle, AppShell accessibility, and SearchPage settings hydration", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeTestSettings() });
    vi.spyOn(api, "getPlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => ({ state }));
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "getSearchHistory").mockResolvedValue({ items: [] });
    vi.spyOn(api, "addSearchHistory").mockResolvedValue({ items: ["晴天"] });
    vi.spyOn(api, "getDiscover").mockResolvedValue({ songs: [] });
    vi.spyOn(api, "getRecommendedPlaylists").mockResolvedValue({ playlists: [] });
  });

  afterEach(() => {
    act(() => onlineManager.setOnline(true));
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("AppShell quick search defers SearchPage query until settings load and uses configured providerMode", async () => {
    let resolveSettings: ((res: { settings: UserSettings }) => void) | undefined;
    vi.spyOn(api, "getSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const searchSpy = vi
      .spyOn(api, "searchSongs")
      .mockResolvedValue({ results: [], mode: "qq", warnings: [] });

    const testUser = makeTestUser();
    renderWithProviders(
      <>
        <AppShell user={testUser}>
          <Routes>
            <Route path="/discover" element={<div>发现</div>} />
            <Route path="/search" element={<SearchPage />} />
          </Routes>
        </AppShell>
        <ToastContainer />
      </>,
      { initialEntries: ["/discover"] },
    );

    const searchInput = screen.getByRole("textbox", { name: "搜索歌曲、歌手或专辑" });
    fireEvent.change(searchInput, { target: { value: "晴天" } });
    const searchForm = searchInput.closest("form");
    if (!searchForm) throw new Error("Expected form");
    fireEvent.submit(searchForm);

    expect(searchSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveSettings?.({ settings: makeTestSettings({ providerMode: "qq" }) });
    });
    await waitFor(() => {
      expect(searchSpy).toHaveBeenCalledWith("晴天", "qq", expect.anything());
    });
  });

  it("SearchPage direct submit before settings resolve waits and queries configured providerMode", async () => {
    let resolveSettings: ((res: { settings: UserSettings }) => void) | undefined;
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

    renderWithProviders(<SearchPage />, { initialEntries: ["/search"] });

    const input = screen.getByPlaceholderText(/输入歌名/);
    fireEvent.change(input, { target: { value: "七里香" } });
    const form = input.closest("form");
    if (!form) throw new Error("Expected form");
    fireEvent.submit(form);

    expect(seenModes).toEqual([]);

    await act(async () => {
      resolveSettings?.({ settings: makeTestSettings({ providerMode: "qq" }) });
    });
    await waitFor(() => expect(seenModes).toEqual(["qq"]));
  });

  it("SearchPage offline mount with ?q=keyword waits for settings after coming online before searching", async () => {
    let resolveOfflineSettings: ((res: { settings: UserSettings }) => void) | undefined;
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
    renderWithProviders(<SearchPage />, { initialEntries: ["/search?q=offline-test"] });

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(typeof resolveOfflineSettings).toBe("function"));
    expect(offlineModes).toEqual([]);

    await act(async () => {
      resolveOfflineSettings?.({ settings: makeTestSettings({ providerMode: "qq" }) });
    });
    await waitFor(() => expect(offlineModes).toEqual(["qq"]));
  });

  it("natural session expiry (401 UNAUTHORIZED) wipes leftover session toasts and returns to auth gate", async () => {
    const testUser = makeTestUser();
    const authStatusSpy = vi
      .spyOn(api, "getAuthStatus")
      .mockResolvedValue({ initialized: true, authenticated: true, user: testUser });

    render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    act(() => {
      toast.success("遗留敏感通知", {
        action: { label: "打开直链", href: "https://m7.music.126.net/secret.mp3" },
      });
    });
    expect(screen.getByRole("link", { name: "打开直链" })).toBeInTheDocument();

    authStatusSpy.mockResolvedValue({ initialized: true, authenticated: false, user: null });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "会话已过期" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await act(async () => {
      await expect(api.getUserPlaylists("netease")).rejects.toThrow("会话已过期");
    });

    await waitFor(() => {
      expect(useToastStore.getState().items).toHaveLength(0);
      expect(screen.queryByRole("link", { name: "打开直链" })).toBeNull();
      expect(screen.queryByText("alice")).toBeNull();
    });
  });

  it("explicit logout wipes leftover direct-link toast while keeping '已退出登录' toast", async () => {
    const testUser = makeTestUser();
    vi.spyOn(api, "getAuthStatus").mockResolvedValueOnce({
      initialized: true,
      authenticated: true,
      user: testUser,
    });
    vi.spyOn(api, "logout").mockResolvedValue({ ok: true });

    render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());

    act(() => {
      toast.success("旧会话直链", {
        action: { label: "打开直链", href: "https://m7.music.126.net/secret.mp3" },
      });
    });
    expect(screen.getByRole("link", { name: "打开直链" })).toBeInTheDocument();

    const logoutBtn = screen.getAllByRole("button", { name: "退出登录" })[0];
    if (!logoutBtn) throw new Error("Expected logout button");
    fireEvent.click(logoutBtn);

    await waitFor(() => {
      expect(screen.getByText("已退出登录")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "打开直链" })).toBeNull();
  });

  it("AppShell removes inert before restoring focus on Escape and auto-closes mobile drawer across 768px breakpoint", () => {
    const nativeFocus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.closest("[inert]")) {
        return;
      }
      nativeFocus.call(this, options);
    });

    Object.defineProperty(window, "innerWidth", { value: 390, writable: true, configurable: true });
    renderWithProviders(
      <AppShell user={makeTestUser()}>
        <div>主视图内容</div>
      </AppShell>,
      { initialEntries: ["/discover"] },
    );

    const openMenuBtn = screen.getByRole("button", { name: "打开导航菜单" });
    openMenuBtn.focus();
    expect(document.activeElement).toBe(openMenuBtn);

    fireEvent.click(openMenuBtn);
    expect(screen.getByRole("dialog", { name: "导航菜单" })).toBeInTheDocument();
    expect(screen.getByRole("main").closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
    expect(screen.getByRole("main").closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(openMenuBtn);

    fireEvent.click(openMenuBtn);
    expect(screen.getByRole("main").closest("[inert]")).not.toBeNull();

    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("dialog", { name: "导航菜单" })).toBeNull();
    expect(screen.getByRole("main").closest("[inert]")).toBeNull();
  });
});
