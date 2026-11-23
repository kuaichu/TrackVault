import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStatus, Song, UserSummary } from "#shared";
import { AudioEngine } from "../features/player/engine/audio-engine.js";
import { usePlaybackClockStore, usePlayerStore } from "../features/player/store/player-store.js";
import { api } from "../shared/api/endpoints.js";
import { ApiClientError, apiRequest, setUnauthorizedHandler } from "../shared/api/http-client.js";
import { AppContent } from "./App.js";

const USER_A: UserSummary = {
  id: "user-a",
  username: "alice",
  role: "admin",
  trustedFallback: true,
  createdAt: 1,
};

const USER_B: UserSummary = {
  id: "user-b",
  username: "bob",
  role: "member",
  trustedFallback: false,
  createdAt: 2,
};

const SAMPLE_SONG: Song = {
  id: "186016",
  platform: "netease",
  title: "晴天",
  artist: "周杰伦",
  album: "叶惠美",
  durationSeconds: 269,
  duration: "04:29",
  quality: "320K",
  availableQualities: [],
};

describe("Phase 1 · Frontend session isolation, 401/abort handling, and AudioEngine stop reset", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    usePlayerStore.getState().reset();
    usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setUnauthorizedHandler(null);
  });

  it("apiRequest does NOT invoke unauthorizedHandler on 401 CREDENTIAL_INVALID, DOES invoke on UNAUTHORIZED, and preserves caller AbortError (C055/B45)", async () => {
    const onUnauth = vi.fn();
    setUnauthorizedHandler(onUnauth);

    // 1) Third-party cookie invalid (401 CREDENTIAL_INVALID) must NOT log user out
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "CREDENTIAL_INVALID", message: "网易云 Cookie 无效" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await assertRejectsCode(
      () => apiRequest("/api/bindings/netease/cookie", { method: "POST" }),
      "CREDENTIAL_INVALID",
    );
    expect(onUnauth).toHaveBeenCalledTimes(0);

    // 2) Local session expired (401 UNAUTHORIZED) MUST trigger unauthorizedHandler
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "请重新登录" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await assertRejectsCode(() => apiRequest("/api/settings"), "UNAUTHORIZED");
    expect(onUnauth).toHaveBeenCalledTimes(1);

    // 3) Caller AbortSignal cancellation must throw AbortError (not 504 UPSTREAM_TIMEOUT)
    const ac = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    const pending = apiRequest("/api/search", { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("renders error + retry view instead of admin setup form when /api/auth/status fails (F05)", async () => {
    vi.spyOn(api, "getAuthStatus").mockRejectedValueOnce(
      new ApiClientError("UPSTREAM_ERROR", "服务暂时不可用", 502),
    );

    render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("无法连接 TrackVault 服务")).toBeInTheDocument();
    });
    expect(screen.queryByText("创建管理员账号")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试连接" })).toBeInTheDocument();
  });

  it("transitions immediately to login form after logout (F01) and isolates per-user QueryClient across account switch (F02)", async () => {
    let currentAuth: AuthStatus = { initialized: true, authenticated: true, user: USER_A };
    let settingsCalls = 0;

    vi.spyOn(api, "getAuthStatus").mockImplementation(async () => currentAuth);
    vi.spyOn(api, "logout").mockImplementation(async () => {
      currentAuth = { initialized: true, authenticated: false, user: null };
      return { ok: true };
    });
    vi.spyOn(api, "login").mockImplementation(async () => {
      currentAuth = { initialized: true, authenticated: true, user: USER_B };
      return { user: USER_B };
    });
    vi.spyOn(api, "getSettings").mockImplementation(async () => {
      settingsCalls += 1;
      return {
        settings: {
          providerMode: "netease",
          defaultPlaybackQuality: "exhigh",
          defaultDownloadQuality: "lossless",
          maxConcurrentDownloads: 2,
          startupView: "discover",
        },
      };
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
    vi.spyOn(api, "getDiscover").mockResolvedValue({ songs: [] });
    vi.spyOn(api, "getRecommendedPlaylists").mockResolvedValue({ playlists: [] });

    render(
      <MemoryRouter initialEntries={["/discover"]}>
        <AppContent />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    const aliceSettingsCalls = settingsCalls;

    // Click logout -> must leave authenticated shell and display login form (F01)
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => {
      expect(screen.getByText("登录 TrackVault")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "退出登录" })).not.toBeInTheDocument();

    // Log in as User B -> fresh UserSessionBoundary must refetch settings in a clean QueryClient (F02)
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "bob" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "BobPassword123!" } });
    fireEvent.click(screen.getByRole("button", { name: /登录/ }));

    await waitFor(() => {
      expect(screen.getByText("bob")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(settingsCalls).toBeGreaterThan(aliceSettingsCalls);
    });
  });

  it("AudioEngine.stop() clears queue, hydrated flag, and fullscreen without firing error/persist side effects (P01/C059)", () => {
    const fakeAudio = document.createElement("audio");
    vi.spyOn(fakeAudio, "play").mockResolvedValue(undefined);
    vi.spyOn(fakeAudio, "load").mockImplementation(() => undefined);
    vi.spyOn(fakeAudio, "pause").mockImplementation(() => {
      fakeAudio.dispatchEvent(new Event("pause"));
    });
    const origRemoveAttr = fakeAudio.removeAttribute.bind(fakeAudio);
    vi.spyOn(fakeAudio, "removeAttribute").mockImplementation((name) => {
      origRemoveAttr(name);
      if (name === "src") {
        fakeAudio.dispatchEvent(new Event("error"));
      }
    });

    const saveSpy = vi.spyOn(api, "savePlayerState").mockResolvedValue({
      state: {
        currentTrack: null,
        playQueue: [],
        playbackSeconds: 0,
        volume: 0.85,
        playbackMode: "sequential",
      },
    });

    const engine = new AudioEngine(fakeAudio);
    engine.hydrate({
      currentTrack: SAMPLE_SONG,
      playQueue: [SAMPLE_SONG],
      playbackSeconds: 30,
      volume: 0.5,
      playbackMode: "shuffle",
    });
    usePlayerStore.getState().setFullscreenOpen(true);

    engine.stop();

    const after = usePlayerStore.getState();
    expect(after.currentTrack).toBeNull();
    expect(after.queue).toEqual([]);
    expect(after.hydrated).toBe(false);
    expect(after.fullscreenOpen).toBe(false);
    expect(after.playerError).toBeNull();
    expect(saveSpy).not.toHaveBeenCalled();

    // New user hydrate after stop must succeed cleanly
    engine.hydrate({
      currentTrack: { ...SAMPLE_SONG, id: "new-user-track", title: "新账号歌曲" },
      playQueue: [{ ...SAMPLE_SONG, id: "new-user-track", title: "新账号歌曲" }],
      playbackSeconds: 12,
      volume: 0.7,
      playbackMode: "sequential",
    });
    expect(usePlayerStore.getState().currentTrack?.id).toBe("new-user-track");
  });
});

async function assertRejectsCode(fn: () => Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await fn();
    throw new Error(`Expected ApiClientError(${expectedCode}) but resolved`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).code).toBe(expectedCode);
  }
}
