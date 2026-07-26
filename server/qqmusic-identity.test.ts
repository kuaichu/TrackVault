import assert from "node:assert/strict";
import test from "node:test";
import { CredentialWriteCancelledError, createCredentialWriteGuardRegistry } from "./credential-write-guard.js";
import { createQqMusicCookiePersister } from "./qqmusic-auth.js";
import { createQqMusicCookieChecker } from "./qqmusic-provider.js";
import type { QqMusicCookieCheckResult } from "./types.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("QQ refresh failure is reported as saved but unverified without exposing a refreshed credential", async () => {
  const checkCookie = createQqMusicCookieChecker(async () => {
    throw new Error("provider unavailable");
  });
  const result = await checkCookie("uin=12345; qm_keyst=unverified");

  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.uin, "12345");
  assert.equal(result.refreshedCookie, undefined);
  assert.match(result.message, /已保存但未验证/);
});

test("QQ refresh without a verified replacement key fails closed", async () => {
  const checkCookie = createQqMusicCookieChecker(async () => ({ uin: null }));
  const result = await checkCookie("uin=12346; qm_keyst=unverified");

  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.refreshedCookie, undefined);
  assert.match(result.message, /缺少服务端验证的稳定账号或密钥/);
});

test("QQ identity is written only after a successful Provider refresh", async () => {
  const registry = createCredentialWriteGuardRegistry();
  let storedCookie = "";
  let verifiedUin: string | null = null;
  const checkCookie = createQqMusicCookieChecker(async () => ({ uin: "23456", musickey: "refreshed-key" }));
  const persister = createQqMusicCookiePersister({
    checkCookie,
    beginCredentialWrite: () => registry.begin("qqmusic", "qq-success"),
    runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
    saveCredential: async (cookie) => {
      storedCookie = cookie;
    },
    writeVerifiedIdentity: async (uin) => {
      verifiedUin = uin;
    },
    clearVerifiedIdentity: async () => undefined
  });

  const result = await persister.importCookie("uin=99999; qm_keyst=old-key");
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(verifiedUin, "23456");
  assert.match(storedCookie, /uin=23456/);
  assert.match(storedCookie, /qm_keyst=refreshed-key/);
});

test("saved-but-unverified QQ results cannot create verified identity", async () => {
  const registry = createCredentialWriteGuardRegistry();
  let saveCalls = 0;
  let identityWrites = 0;
  let identityClears = 0;
  const persister = createQqMusicCookiePersister({
    checkCookie: async () => ({ ok: true, verified: false, uin: "34567", message: "saved only" }),
    beginCredentialWrite: () => registry.begin("qqmusic", "qq-failed"),
    runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
    saveCredential: async () => {
      saveCalls += 1;
    },
    writeVerifiedIdentity: async () => {
      identityWrites += 1;
    },
    clearVerifiedIdentity: async () => {
      identityClears += 1;
    }
  });

  const result = await persister.importCookie("uin=34567; qm_keyst=fake");
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(saveCalls, 1);
  assert.equal(identityWrites, 0);
  assert.equal(identityClears, 1);
});

test("later QQ B verification wins when stale A completes last", async () => {
  const registry = createCredentialWriteGuardRegistry();
  const resultA = deferred<QqMusicCookieCheckResult>();
  const resultB = deferred<QqMusicCookieCheckResult>();
  const startedA = deferred<void>();
  const startedB = deferred<void>();
  let storedCookie = "";
  let verifiedUin: string | null = null;
  const persister = createQqMusicCookiePersister({
    checkCookie: (cookie) => {
      if (cookie.includes("uin=40001")) {
        startedA.resolve();
        return resultA.promise;
      }
      startedB.resolve();
      return resultB.promise;
    },
    beginCredentialWrite: () => registry.begin("qqmusic", "qq-switch"),
    runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
    saveCredential: async (cookie) => {
      storedCookie = cookie;
    },
    writeVerifiedIdentity: async (uin) => {
      verifiedUin = uin;
    },
    clearVerifiedIdentity: async () => undefined
  });

  const importA = persister.importCookie("uin=40001; qm_keyst=a");
  await startedA.promise;
  const importB = persister.importCookie("uin=40002; qm_keyst=b");
  await startedB.promise;

  resultB.resolve({
    ok: true,
    verified: true,
    uin: "40002",
    message: "verified B",
    refreshedCookie: "uin=40002; qm_keyst=verified-b"
  });
  await importB;
  resultA.resolve({
    ok: true,
    verified: true,
    uin: "40001",
    message: "verified A",
    refreshedCookie: "uin=40001; qm_keyst=verified-a"
  });

  await assert.rejects(importA, CredentialWriteCancelledError);
  assert.equal(verifiedUin, "40002");
  assert.equal(storedCookie, "uin=40002; qm_keyst=verified-b");
});
