import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSessionResolver } from "./account-store.js";
import { createCredentialWriteGuardRegistry } from "./credential-write-guard.js";
import type { AppSettings, AuthSession } from "./types.js";

const emptySession: AuthSession = { loggedIn: false, profile: null };

function createSettings(neteaseCookie: string): AppSettings {
  return {
    accountName: "test",
    vipEnabled: false,
    providerMode: "netease",
    downloadDirectory: "downloads",
    neteaseCookie,
    qqMusicCookie: "",
    notes: "",
    defaultPlaybackQuality: "standard",
    defaultDownloadQuality: "hires",
    maxConcurrentDownloads: 3,
    startupView: "discover",
    autoLoadDiscoverOnStart: true
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function loginStatusBody(accountId: number) {
  return {
    body: {
      data: {
        account: { id: accountId, vipType: 0 },
        profile: { userId: accountId, nickname: `User ${accountId}`, vipType: 0 }
      }
    }
  };
}

test("Netease login_status completing after logout cannot restore the old snapshot", async () => {
  const registry = createCredentialWriteGuardRegistry();
  const statusA = deferred<{ body: unknown }>();
  const startedA = deferred<void>();
  let currentCookie = "MUSIC_U=A";
  let stored: { session: AuthSession; cookie: string } | null = null;
  const resolveSession = createAccountSessionResolver({
    getSettings: async () => createSettings(currentCookie),
    loginStatus: () => {
      startedA.resolve();
      return statusA.promise;
    },
    vipInfo: async () => ({ body: {} }),
    vipInfoV2: async () => ({ body: {} }),
    captureCredentialGuard: () => registry.capture("netease", "netease-logout-race"),
    isCredentialGuardCurrent: (guard) => registry.isCurrent(guard),
    runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
    readStoredSession: async (cookie) => stored?.cookie === cookie ? stored.session : emptySession,
    writeVerifiedSession: async (session, cookie) => {
      stored = { session, cookie };
    }
  });

  const staleRequest = resolveSession();
  await startedA.promise;
  await registry.invalidate("netease", "netease-logout-race", () => {
    currentCookie = "";
    stored = null;
  });
  statusA.resolve(loginStatusBody(50001));

  assert.deepEqual(await staleRequest, emptySession);
  assert.equal(stored, null);
  assert.deepEqual(await resolveSession(), emptySession);
});

test("Netease B remains current when older A login_status finishes last", async () => {
  const registry = createCredentialWriteGuardRegistry();
  const statusA = deferred<{ body: unknown }>();
  const statusB = deferred<{ body: unknown }>();
  const startedA = deferred<void>();
  const startedB = deferred<void>();
  let currentCookie = "MUSIC_U=A";
  let stored: { session: AuthSession; cookie: string } | null = null;
  const writes: string[] = [];
  const resolveSession = createAccountSessionResolver({
    getSettings: async () => createSettings(currentCookie),
    loginStatus: ({ cookie }) => {
      if (cookie === "MUSIC_U=A") {
        startedA.resolve();
        return statusA.promise;
      }
      startedB.resolve();
      return statusB.promise;
    },
    vipInfo: async () => ({ body: {} }),
    vipInfoV2: async () => ({ body: {} }),
    captureCredentialGuard: () => registry.capture("netease", "netease-switch-race"),
    isCredentialGuardCurrent: (guard) => registry.isCurrent(guard),
    runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
    readStoredSession: async (cookie) => stored?.cookie === cookie ? stored.session : emptySession,
    writeVerifiedSession: async (session, cookie) => {
      writes.push(cookie);
      stored = { session, cookie };
    }
  });

  const requestA = resolveSession();
  await startedA.promise;
  await registry.invalidate("netease", "netease-switch-race", () => {
    currentCookie = "MUSIC_U=B";
    stored = null;
  });
  const requestB = resolveSession();
  await startedB.promise;
  statusB.resolve(loginStatusBody(50002));
  const sessionB = await requestB;
  statusA.resolve(loginStatusBody(50001));
  const staleAResult = await requestA;

  assert.equal(sessionB.profile?.id, "50002");
  assert.equal(staleAResult.profile?.id, "50002");
  assert.deepEqual(writes, ["MUSIC_U=B"]);
  const finalStored = stored as { session: AuthSession; cookie: string } | null;
  assert.equal(finalStored?.cookie, "MUSIC_U=B");
  assert.equal(finalStored?.session.profile?.id, "50002");
});
