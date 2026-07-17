import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { AppSettings } from "./types.js";

const previousDataDir = process.env.TRACKVAULT_DATA_DIR;
const previousDisableSqlite = process.env.TRACKVAULT_DISABLE_SQLITE;
const temporaryDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "trackvault-credentials-"));
process.env.TRACKVAULT_DATA_DIR = temporaryDataDir;
process.env.TRACKVAULT_DISABLE_SQLITE = "1";

const {
  SettingsUpdateConflictError,
  getSettings,
  mergeSettingsUpdate,
  saveSettings,
  toPublicSettings
} = await import("./settings-store.js");
const { runWithRequestContext } = await import("./request-context.js");
const { getSession, loginSession, logoutSession } = await import("./account-store.js");
const { clearOwnedQqQrSessions, getQqMusicCookieForStorage, logoutQqMusicSession } = await import("./qqmusic-auth.js");
const { createQqMusicRuntimeController } = await import("./qqmusic-provider.js");
const { CredentialWriteCancelledError, createCredentialWriteGuardRegistry } = await import("./credential-write-guard.js");

after(async () => {
  if (previousDataDir === undefined) {
    delete process.env.TRACKVAULT_DATA_DIR;
  } else {
    process.env.TRACKVAULT_DATA_DIR = previousDataDir;
  }
  if (previousDisableSqlite === undefined) {
    delete process.env.TRACKVAULT_DISABLE_SQLITE;
  } else {
    process.env.TRACKVAULT_DISABLE_SQLITE = previousDisableSqlite;
  }
  await fs.rm(temporaryDataDir, { recursive: true, force: true });
});

function createSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    accountName: "测试账号",
    vipEnabled: false,
    providerMode: "aggregate",
    downloadDirectory: "downloads",
    neteaseCookie: "MUSIC_U=netease-secret",
    qqMusicCookie: "uin=10001; qm_keyst=qq-secret",
    notes: "notes",
    defaultPlaybackQuality: "standard",
    defaultDownloadQuality: "hires",
    maxConcurrentDownloads: 3,
    startupView: "discover",
    autoLoadDiscoverOnStart: true,
    ...overrides
  };
}

test("public settings expose only credential presence flags", () => {
  const view = toPublicSettings(createSettings());
  const serialized = JSON.stringify(view);

  assert.equal(view.hasNeteaseCookie, true);
  assert.equal(view.hasQqMusicCookie, true);
  assert.equal("neteaseCookie" in view, false);
  assert.equal("qqMusicCookie" in view, false);
  assert.doesNotMatch(serialized, /neteaseCookie|qqMusicCookie|netease-secret|qq-secret/);
});

test("public settings presence flags reflect empty credentials", () => {
  const view = toPublicSettings(createSettings({ neteaseCookie: "", qqMusicCookie: "" }));
  assert.equal(view.hasNeteaseCookie, false);
  assert.equal(view.hasQqMusicCookie, false);
});

test("ordinary settings patches preserve both credentials", () => {
  const next = mergeSettingsUpdate(createSettings(), { downloadDirectory: "D:/Music", maxConcurrentDownloads: 5 });
  assert.equal(next.downloadDirectory, "D:/Music");
  assert.equal(next.maxConcurrentDownloads, 5);
  assert.equal(next.neteaseCookie, "MUSIC_U=netease-secret");
  assert.equal(next.qqMusicCookie, "uin=10001; qm_keyst=qq-secret");
});

test("non-empty credential patches replace only the requested platform", () => {
  const current = createSettings();
  const neteaseNext = mergeSettingsUpdate(current, { neteaseCookie: "MUSIC_U=next-netease" });
  const qqNext = mergeSettingsUpdate(current, { qqMusicCookie: "uin=20002; qm_keyst=next-qq" });

  assert.equal(neteaseNext.neteaseCookie, "MUSIC_U=next-netease");
  assert.equal(neteaseNext.qqMusicCookie, current.qqMusicCookie);
  assert.equal(qqNext.qqMusicCookie, "uin=20002; qm_keyst=next-qq");
  assert.equal(qqNext.neteaseCookie, current.neteaseCookie);
});

test("empty credential strings preserve stored values", () => {
  const current = createSettings();
  const next = mergeSettingsUpdate(current, { neteaseCookie: "   ", qqMusicCookie: "" });
  assert.equal(next.neteaseCookie, current.neteaseCookie);
  assert.equal(next.qqMusicCookie, current.qqMusicCookie);
});

test("explicit clear flags clear only the requested credential", () => {
  const current = createSettings();
  const neteaseNext = mergeSettingsUpdate(current, { clearNeteaseCookie: true });
  const qqNext = mergeSettingsUpdate(current, { clearQqMusicCookie: true });

  assert.equal(neteaseNext.neteaseCookie, "");
  assert.equal(neteaseNext.qqMusicCookie, current.qqMusicCookie);
  assert.equal(qqNext.qqMusicCookie, "");
  assert.equal(qqNext.neteaseCookie, current.neteaseCookie);
});

test("setting and clearing the same credential is rejected", () => {
  assert.throws(
    () => mergeSettingsUpdate(createSettings(), { neteaseCookie: "MUSIC_U=next", clearNeteaseCookie: true }),
    SettingsUpdateConflictError
  );
  assert.throws(
    () => mergeSettingsUpdate(createSettings(), { qqMusicCookie: "uin=2", clearQqMusicCookie: true }),
    SettingsUpdateConflictError
  );
});

test("settings reads, patches, and clears remain isolated between client session IDs", async () => {
  await runWithRequestContext("sid-a", () => saveSettings({
    neteaseCookie: "MUSIC_U=sid-a",
    qqMusicCookie: "uin=1; qm_keyst=sid-a"
  }));
  await runWithRequestContext("sid-b", () => saveSettings({
    neteaseCookie: "MUSIC_U=sid-b",
    qqMusicCookie: "uin=2; qm_keyst=sid-b"
  }));

  await runWithRequestContext("sid-a", () => saveSettings({ notes: "only-a", clearNeteaseCookie: true }));
  const [settingsA, settingsB] = await Promise.all([
    runWithRequestContext("sid-a", () => getSettings()),
    runWithRequestContext("sid-b", () => getSettings())
  ]);

  assert.equal(settingsA.neteaseCookie, "");
  assert.equal(settingsA.qqMusicCookie, "uin=1; qm_keyst=sid-a");
  assert.equal(settingsA.notes, "only-a");
  assert.equal(settingsB.neteaseCookie, "MUSIC_U=sid-b");
  assert.equal(settingsB.qqMusicCookie, "uin=2; qm_keyst=sid-b");
  assert.notEqual(settingsB.notes, "only-a");
});

test("Netease logout clears the local session and only the current SID credential", async () => {
  await runWithRequestContext("netease-b", () => saveSettings({
    neteaseCookie: "MUSIC_U=keep-b",
    qqMusicCookie: "uin=12; qm_keyst=keep-b"
  }));

  await runWithRequestContext("netease-a", async () => {
    await saveSettings({
      neteaseCookie: "MUSIC_U=logout-a",
      qqMusicCookie: "uin=11; qm_keyst=keep-a"
    });
    await loginSession({ accountName: "Local A", vipEnabled: false, note: "test" });
    const result = await logoutSession();
    const settings = await getSettings();
    const session = await getSession();

    assert.deepEqual(result, { loggedIn: false, profile: null });
    assert.deepEqual(session, { loggedIn: false, profile: null });
    assert.equal(settings.neteaseCookie, "");
    assert.equal(settings.qqMusicCookie, "uin=11; qm_keyst=keep-a");
  });

  await runWithRequestContext("netease-b", async () => {
    const settings = await getSettings();
    assert.equal(settings.neteaseCookie, "MUSIC_U=keep-b");
    assert.equal(settings.qqMusicCookie, "uin=12; qm_keyst=keep-b");
  });
});

test("QQ logout clears only the current SID credential", async () => {
  await runWithRequestContext("qq-a", () => saveSettings({
    neteaseCookie: "MUSIC_U=keep-netease-a",
    qqMusicCookie: "uin=21; qm_keyst=logout-a"
  }));
  await runWithRequestContext("qq-b", () => saveSettings({
    neteaseCookie: "MUSIC_U=keep-netease-b",
    qqMusicCookie: "uin=22; qm_keyst=keep-b"
  }));

  const status = await runWithRequestContext("qq-a", () => logoutQqMusicSession());
  const [settingsA, settingsB] = await Promise.all([
    runWithRequestContext("qq-a", () => getSettings()),
    runWithRequestContext("qq-b", () => getSettings())
  ]);

  assert.equal(status.ok, false);
  assert.equal(settingsA.qqMusicCookie, "");
  assert.equal(settingsA.neteaseCookie, "MUSIC_U=keep-netease-a");
  assert.equal(settingsB.qqMusicCookie, "uin=22; qm_keyst=keep-b");
  assert.equal(settingsB.neteaseCookie, "MUSIC_U=keep-netease-b");
});

test("QQ runtime calls serialize SDK-internal cookie refreshes by client session", async () => {
  let runtimeCookie: Record<string, string> = {};
  const mutationSnapshots: Record<string, string>[] = [];
  const fakeApi = {
    cookie: runtimeCookie,
    setCookie(cookies: string | Record<string, string>) {
      runtimeCookie = typeof cookies === "string" ? {} : { ...cookies };
      this.cookie = runtimeCookie;
    },
    async api(path: string) {
      const seenCookie = { ...runtimeCookie };
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.setCookie({ ...runtimeCookie, refreshedBy: path });
      mutationSnapshots.push({ ...runtimeCookie });
      return seenCookie;
    }
  };
  const controller = createQqMusicRuntimeController(fakeApi as never);

  const [resultA, resultB] = await Promise.all([
    controller.call<Record<string, string>>("sid-a", { uin: "11" }, "refresh-a"),
    controller.call<Record<string, string>>("sid-b", { uin: "22" }, "refresh-b")
  ]);

  assert.deepEqual(resultA, { uin: "11" });
  assert.deepEqual(resultB, { uin: "22" });
  assert.deepEqual(mutationSnapshots, [
    { uin: "11", refreshedBy: "refresh-a" },
    { uin: "22", refreshedBy: "refresh-b" }
  ]);
  assert.equal(controller.getOwnerClientSessionId(), "sid-b");
  assert.equal(await controller.clearCookie("sid-a"), false);
  assert.equal(await controller.clearCookie("sid-b"), true);
  assert.deepEqual(runtimeCookie, {});
  assert.equal(controller.getOwnerClientSessionId(), null);
});

test("QQ Cookie import stores the refreshed secret without exposing it in the public result", () => {
  const publicResult = {
    ok: true,
    uin: "22",
    message: "ok"
  };
  const internalResult = {
    ...publicResult,
    refreshedCookie: "uin=22; qm_keyst=refreshed"
  };

  assert.equal(getQqMusicCookieForStorage("uin=22; qm_keyst=old", internalResult), "uin=22; qm_keyst=refreshed");
  assert.doesNotMatch(JSON.stringify(publicResult), /refreshed|qm_keyst/);
});

test("credential invalidation is ordered after an in-flight write and rejects stale future writes", async () => {
  const registry = createCredentialWriteGuardRegistry();
  const guard = registry.capture("netease", "sid-a");
  let credential = "";
  let releaseWrite: (() => void) | undefined;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const inFlightWrite = registry.runIfCurrent(guard, async () => {
    await writeGate;
    credential = "secret";
  });
  const logout = registry.invalidate("netease", "sid-a", () => {
    credential = "";
  });

  releaseWrite?.();
  await Promise.all([inFlightWrite, logout]);

  assert.equal(credential, "");
  await assert.rejects(() => registry.runIfCurrent(guard, () => {
    credential = "restored";
  }), CredentialWriteCancelledError);
  assert.equal(credential, "");
});

test("QQ QR cleanup removes only sessions owned by the current client", () => {
  const sessions = new Map([
    ["a-1", { clientSessionId: "sid-a" }],
    ["a-2", { clientSessionId: "sid-a" }],
    ["b-1", { clientSessionId: "sid-b" }]
  ]);

  assert.equal(clearOwnedQqQrSessions(sessions, "sid-a"), 2);
  assert.deepEqual([...sessions.keys()], ["b-1"]);
});
