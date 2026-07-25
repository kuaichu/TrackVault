import assert from "node:assert/strict";
import test from "node:test";
import { getClientSessionId } from "../request-context.js";
import type { AppSettings, AppSettingsUpdate, PublicAppSettings } from "../types.js";
import {
  createPlatformCookieRouter,
  createSettingsRouter,
  type PlatformCookieRouterDependencies,
  type SettingsRouterDependencies
} from "./settings-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    accountName: "测试账号",
    vipEnabled: false,
    providerMode: "aggregate",
    downloadDirectory: "downloads",
    neteaseCookie: "MUSIC_U=stored-netease",
    qqMusicCookie: "uin=stored-qq",
    notes: "notes",
    defaultPlaybackQuality: "standard",
    defaultDownloadQuality: "hires",
    maxConcurrentDownloads: 3,
    startupView: "discover",
    autoLoadDiscoverOnStart: true,
    ...overrides
  };
}

function toPublicSettings(settings: AppSettings): PublicAppSettings {
  const { neteaseCookie, qqMusicCookie, ...publicFields } = settings;
  return {
    ...publicFields,
    hasNeteaseCookie: Boolean(neteaseCookie),
    hasQqMusicCookie: Boolean(qqMusicCookie)
  };
}

class SettingsConflictError extends Error {}

test("settings GET exposes the public view without credentials and preserves request SID", timeout, async () => {
  const settings = createSettings();
  let getCalls = 0;
  let observedSessionId = "";
  const dependencies = {
    getSettings: async () => {
      getCalls += 1;
      observedSessionId = getClientSessionId();
      return settings;
    },
    saveSettings: async () => settings,
    toPublicSettings,
    isSettingsUpdateConflictError: () => false
  } satisfies SettingsRouterDependencies;

  await withTestRouter([createSettingsRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/settings?sid=query-sid", {
      headers: { "x-client-session-id": "header-sid" }
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, toPublicSettings(settings));
    assert.doesNotMatch(JSON.stringify(response.body), /stored-netease|stored-qq|neteaseCookie|qqMusicCookie/);
  });

  assert.equal(getCalls, 1);
  assert.equal(observedSessionId, "header-sid");
});

test("settings PUT forwards the patch once and maps update conflicts to 400", timeout, async () => {
  const settings = createSettings({ notes: "updated" });
  const received: AppSettingsUpdate[] = [];
  const dependencies = {
    getSettings: async () => settings,
    saveSettings: async (input: AppSettingsUpdate) => {
      received.push(input);
      if (input.clearNeteaseCookie && input.neteaseCookie) {
        throw new SettingsConflictError("不能同时设置和清除网易云 Cookie。 ");
      }
      return settings;
    },
    toPublicSettings,
    isSettingsUpdateConflictError: (error: unknown) => error instanceof SettingsConflictError
  } satisfies SettingsRouterDependencies;

  await withTestRouter([createSettingsRouter(dependencies)], async ({ requestJson }) => {
    const patch: AppSettingsUpdate = { notes: "updated", maxConcurrentDownloads: 4 };
    const success = await requestJson("PUT", "/api/settings", patch);
    assert.equal(success.status, 200);
    assert.deepEqual(success.body, toPublicSettings(settings));

    const conflictPatch: AppSettingsUpdate = { neteaseCookie: "new", clearNeteaseCookie: true };
    const conflict = await requestJson("PUT", "/api/settings", conflictPatch);
    assert.equal(conflict.status, 400);
    assert.deepEqual(conflict.body, { message: "不能同时设置和清除网易云 Cookie。 " });
    assert.deepEqual(received, [patch, conflictPatch]);
  });
});

test("platform cookie routes preserve platform-specific normalization and stored-cookie behavior", timeout, async () => {
  const settings = createSettings();
  const importedNetease: string[] = [];
  const checkedNetease: string[] = [];
  const importedQq: string[] = [];
  let getSettingsCalls = 0;
  const dependencies = {
    getSettings: async () => {
      getSettingsCalls += 1;
      return settings;
    },
    checkNeteaseCookie: async (cookie: string) => {
      checkedNetease.push(cookie);
      return { ok: true, accountName: "stored", message: "checked" };
    },
    importNeteaseCookie: async (cookie: string) => {
      importedNetease.push(cookie);
      return { ok: true, accountName: "submitted", message: "imported" };
    },
    importQqMusicCookie: async (cookie: string) => {
      importedQq.push(cookie);
      return { ok: true, uin: "10001", message: "imported" };
    }
  } satisfies PlatformCookieRouterDependencies;

  await withTestRouter([createPlatformCookieRouter(dependencies)], async ({ requestJson }) => {
    const imported = await requestJson("POST", "/api/settings/netease-cookie/check", { cookie: "  MUSIC_U=new  " });
    assert.equal(imported.status, 200);

    const stored = await requestJson("POST", "/api/settings/netease-cookie/check", { cookie: "   " });
    assert.equal(stored.status, 200);

    const qq = await requestJson("POST", "/api/settings/qqmusic-cookie/check", { cookie: "  uin=raw  " });
    assert.equal(qq.status, 200);
  });

  assert.deepEqual(importedNetease, ["MUSIC_U=new"]);
  assert.deepEqual(checkedNetease, ["MUSIC_U=stored-netease"]);
  assert.deepEqual(importedQq, ["  uin=raw  "]);
  assert.equal(getSettingsCalls, 1);
});

test("both platform cookie failures retain 409 responses and fallback messages", timeout, async () => {
  let neteaseCalls = 0;
  let qqCalls = 0;
  const dependencies = {
    getSettings: async () => createSettings(),
    checkNeteaseCookie: async () => ({ ok: true, accountName: null, message: "unused" }),
    importNeteaseCookie: async () => {
      neteaseCalls += 1;
      throw new Error("网易凭证无效");
    },
    importQqMusicCookie: async () => {
      qqCalls += 1;
      throw "not-an-error";
    }
  } satisfies PlatformCookieRouterDependencies;

  await withTestRouter([createPlatformCookieRouter(dependencies)], async ({ requestJson }) => {
    const netease = await requestJson("POST", "/api/settings/netease-cookie/check", { cookie: "bad" });
    assert.equal(netease.status, 409);
    assert.deepEqual(netease.body, { message: "网易凭证无效" });

    const qq = await requestJson("POST", "/api/settings/qqmusic-cookie/check", { cookie: "bad" });
    assert.equal(qq.status, 409);
    assert.deepEqual(qq.body, { message: "QQ 音乐 Cookie 导入失败" });
  });

  assert.equal(neteaseCalls, 1);
  assert.equal(qqCalls, 1);
});
