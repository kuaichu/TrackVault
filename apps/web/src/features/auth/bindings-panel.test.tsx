import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformBindingView } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import { useToastStore } from "../../shared/store/toast-store.js";
import { BindingsPanel, shouldInvalidateQueryForPlatformChange } from "./BindingsPanel.js";

function makeBinding(
  platform: "netease" | "qq",
  connected: boolean,
  overrides: Partial<PlatformBindingView> = {},
): PlatformBindingView {
  return {
    platform,
    connected,
    accountUid: connected ? `${platform}-uid` : null,
    displayName: connected ? `${platform}-user` : null,
    avatarUrl: null,
    vipEnabled: false,
    vipExpireAt: null,
    verifiedAt: connected ? 1000 : null,
    ...overrides,
  };
}

describe("Platform-scoped cache invalidation in BindingsPanel", () => {
  beforeEach(() => {
    useToastStore.getState().clear();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
  });

  afterEach(() => {
    cleanup();
    useToastStore.getState().clear();
    vi.restoreAllMocks();
  });

  it("shouldInvalidateQueryForPlatformChange accurately scopes invalidation rules per platform", () => {
    // Always invalidate ["bindings"]
    expect(shouldInvalidateQueryForPlatformChange(["bindings"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["bindings"], "netease")).toBe(true);

    // Platform-parameterized queries
    for (const root of [
      "playlists",
      "playlist-tracks",
      "liked-ids",
      "charts",
      "chart-detail",
      "artist-detail",
      "album-detail",
      "lyrics",
      "comments",
    ]) {
      expect(shouldInvalidateQueryForPlatformChange([root, "qq", "id-1"], "qq")).toBe(true);
      expect(shouldInvalidateQueryForPlatformChange([root], "qq")).toBe(true);
      expect(shouldInvalidateQueryForPlatformChange([root, "netease", "id-1"], "qq")).toBe(false);
    }

    // Discover & discover-playlists
    expect(shouldInvalidateQueryForPlatformChange(["discover"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["discover", "aggregate"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["discover", "qq"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["discover", "netease"], "qq")).toBe(false);
    expect(shouldInvalidateQueryForPlatformChange(["discover-playlists", "qq"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["discover-playlists", "netease"], "qq")).toBe(false);

    // Search & search-entities (mode at queryKey[2])
    expect(shouldInvalidateQueryForPlatformChange(["search", "晴天", "aggregate"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["search", "晴天", "qq"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["search", "晴天"], "qq")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["search", "晴天", "netease"], "qq")).toBe(false);
    expect(
      shouldInvalidateQueryForPlatformChange(["search-entities", "周杰伦", "aggregate", "artist"], "qq"),
    ).toBe(true);
    expect(
      shouldInvalidateQueryForPlatformChange(["search-entities", "周杰伦", "netease", "artist"], "qq"),
    ).toBe(false);

    // Netease-only queries
    expect(shouldInvalidateQueryForPlatformChange(["daily-recommend"], "qq")).toBe(false);
    expect(shouldInvalidateQueryForPlatformChange(["cloud-songs"], "qq")).toBe(false);
    expect(shouldInvalidateQueryForPlatformChange(["daily-recommend"], "netease")).toBe(true);
    expect(shouldInvalidateQueryForPlatformChange(["cloud-songs", { offset: 0 }], "netease")).toBe(true);

    // Unrelated queries remain untouched
    expect(shouldInvalidateQueryForPlatformChange(["settings"], "netease")).toBe(false);
    expect(shouldInvalidateQueryForPlatformChange(["play-history"], "netease")).toBe(false);
  });

  it("binding and unbinding qq invalidates ['bindings'], ['playlists', 'qq'], and ['search', '晴天', 'aggregate'] without invalidating netease caches", async () => {
    let qqConnected = false;
    const listBindingsSpy = vi.spyOn(api, "listBindings").mockImplementation(async () => ({
      bindings: {
        netease: makeBinding("netease", true),
        qq: makeBinding("qq", qqConnected),
      },
    }));

    const bindCookieSpy = vi.spyOn(api, "bindPlatformCookie").mockImplementation(async () => {
      qqConnected = true;
      return { binding: makeBinding("qq", true, { message: "QQ 音乐已连接" }) };
    });

    const unbindSpy = vi.spyOn(api, "unbindPlatform").mockImplementation(async () => {
      qqConnected = false;
      return { binding: makeBinding("qq", false) };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });

    const seedAllCaches = () => {
      queryClient.setQueryData(["playlists", "qq"], { playlists: [] });
      queryClient.setQueryData(["search", "晴天", "aggregate"], {
        results: [],
        mode: "aggregate",
        warnings: [],
      });
      queryClient.setQueryData(["playlists", "netease"], { playlists: [] });
      queryClient.setQueryData(["liked-ids", "netease"], { ids: ["n-1"] });
      queryClient.setQueryData(["daily-recommend"], { songs: [] });
      queryClient.setQueryData(["search", "晴天", "netease"], {
        results: [],
        mode: "netease",
        warnings: [],
      });
    };

    seedAllCaches();

    render(
      <QueryClientProvider client={queryClient}>
        <BindingsPanel />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("QQ 音乐")).toBeInTheDocument();
    });
    expect(listBindingsSpy).toHaveBeenCalledTimes(1);

    // 1) Bind QQ via manual cookie
    const manualCookieButtons = screen.getAllByRole("button", { name: /手动粘贴 Cookie/ });
    const qqManualBtn = manualCookieButtons[1];
    if (!qqManualBtn) throw new Error("Expected QQ manual cookie button");
    fireEvent.click(qqManualBtn);

    const qqCookieTextarea = screen.getByLabelText("粘贴包含 uin 与 qm_keyst 的 Cookie");
    fireEvent.change(qqCookieTextarea, { target: { value: "uin=12345; qm_keyst=secret" } });
    fireEvent.click(screen.getByRole("button", { name: "验证并绑定" }));

    await waitFor(() => {
      expect(bindCookieSpy).toHaveBeenCalledWith("qq", "uin=12345; qm_keyst=secret");
      // ["bindings"] had an active observer so invalidating it triggered an immediate refetch (#2)
      expect(listBindingsSpy).toHaveBeenCalledTimes(2);
      expect(screen.getAllByRole("button", { name: /解绑/ })).toHaveLength(2);
    });

    expect(queryClient.getQueryState(["playlists", "qq"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["search", "晴天", "aggregate"])?.isInvalidated).toBe(true);

    expect(queryClient.getQueryState(["playlists", "netease"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["liked-ids", "netease"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["daily-recommend"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["search", "晴天", "netease"])?.isInvalidated).toBe(false);

    // 2) Re-seed caches fresh and unbind QQ -> verify identical platform-scoped invalidation
    seedAllCaches();
    expect(queryClient.getQueryState(["playlists", "qq"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["search", "晴天", "aggregate"])?.isInvalidated).toBe(false);

    const unbindButtons = screen.getAllByRole("button", { name: /解绑/ });
    const qqUnbindBtn = unbindButtons[1];
    if (!qqUnbindBtn) throw new Error("Expected QQ unbind button");
    fireEvent.click(qqUnbindBtn);

    await waitFor(() => {
      expect(unbindSpy).toHaveBeenCalledWith("qq");
      expect(listBindingsSpy).toHaveBeenCalledTimes(3);
      expect(screen.getAllByRole("button", { name: /解绑/ })).toHaveLength(1);
    });

    expect(queryClient.getQueryState(["playlists", "qq"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["search", "晴天", "aggregate"])?.isInvalidated).toBe(true);

    expect(queryClient.getQueryState(["playlists", "netease"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["liked-ids", "netease"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["daily-recommend"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["search", "晴天", "netease"])?.isInvalidated).toBe(false);
  });
});
