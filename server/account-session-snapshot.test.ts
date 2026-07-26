import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { AuthSession } from "./types.js";

const previousDataDir = process.env.TRACKVAULT_DATA_DIR;
const previousDisableSqlite = process.env.TRACKVAULT_DISABLE_SQLITE;
const temporaryDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "trackvault-identity-snapshot-"));
process.env.TRACKVAULT_DATA_DIR = temporaryDataDir;
process.env.TRACKVAULT_DISABLE_SQLITE = "1";

const {
  readStoredAccountIdentitySnapshot,
  readStoredVerifiedIdentityState,
  clearStoredQqMusicIdentity,
  writeStoredDemoAccountSession,
  writeStoredNeteaseAccountSession,
  writeStoredQqMusicIdentity
} = await import("./account-session-snapshot.js");
const { getBackgroundJobOwnerKey } = await import("./background-job-owner.js");
const { getAccountState } = await import("./data-scope.js");
const { createQqMusicCookiePersister, logoutQqMusicSession } = await import("./qqmusic-auth.js");
const { getQqMusicAccountStatus, getQqMusicUserProfile } = await import("./qqmusic-provider.js");
const { createCredentialWriteGuardRegistry } = await import("./credential-write-guard.js");
const { runWithRequestContext } = await import("./request-context.js");
const { getSettings, saveSettings, saveSettingsWithinCredentialWrite } = await import("./settings-store.js");

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

function accountSession(provider: "demo" | "netease", id: string): AuthSession {
  return {
    loggedIn: true,
    profile: {
      id,
      displayName: id,
      level: 0,
      vipEnabled: false,
      avatarSeed: id.slice(0, 2),
      provider,
      bio: "test",
      favoriteGenres: [],
      lastLoginAt: "2026-07-26T00:00:00.000Z"
    }
  };
}

test("versioned demo identity remains local and needs no platform credential", async () => {
  await runWithRequestContext("snapshot-demo", async () => {
    const session = accountSession("demo", "demo-stable-id");
    await writeStoredDemoAccountSession(session);

    assert.deepEqual(await readStoredVerifiedIdentityState({ neteaseCookie: "", qqMusicCookie: "" }), {
      session,
      qqMusicUin: null
    });
    assert.equal(await getBackgroundJobOwnerKey(), "account:demo:demo-stable-id");
  });
});

test("legacy and credential-unbound account snapshots fail closed", async () => {
  const legacySid = "snapshot-legacy";
  const legacySession = accountSession("netease", "10001");
  await fs.writeFile(
    path.join(temporaryDataDir, `account-session.${legacySid}.json`),
    JSON.stringify(legacySession),
    "utf8"
  );
  await runWithRequestContext(legacySid, async () => {
    assert.deepEqual(await readStoredVerifiedIdentityState({
      neteaseCookie: "MUSIC_U=legacy",
      qqMusicCookie: ""
    }), { session: { loggedIn: false, profile: null }, qqMusicUin: null });
  });

  const unboundSid = "snapshot-unbound";
  await fs.writeFile(
    path.join(temporaryDataDir, `account-session.${unboundSid}.json`),
    JSON.stringify({
      version: 1,
      session: legacySession,
      sessionIdentity: null,
      qqMusicIdentity: { provider: "qqmusic", accountId: "10001", verified: true }
    }),
    "utf8"
  );
  await runWithRequestContext(unboundSid, async () => {
    const identityState = await readStoredVerifiedIdentityState({
      neteaseCookie: "MUSIC_U=legacy",
      qqMusicCookie: "uin=10001; qm_keyst=legacy"
    });
    assert.equal(identityState.session.loggedIn, false);
    assert.equal(identityState.qqMusicUin, null);
  });
});

test("Netease identity is trusted only for the credential it was verified with", async () => {
  await runWithRequestContext("snapshot-netease-binding", async () => {
    const session = accountSession("netease", "20002");
    await writeStoredNeteaseAccountSession(session, "MUSIC_U=credential-a");

    assert.deepEqual((await readStoredVerifiedIdentityState({
      neteaseCookie: "MUSIC_U=credential-a",
      qqMusicCookie: ""
    })).session, session);
    assert.equal((await readStoredVerifiedIdentityState({
      neteaseCookie: "MUSIC_U=credential-b",
      qqMusicCookie: ""
    })).session.loggedIn, false);
    assert.equal((await readStoredVerifiedIdentityState({
      neteaseCookie: "",
      qqMusicCookie: ""
    })).session.loggedIn, false);
  });
});

test("ordinary QQ Cookie settings cannot create or retain an account owner", async () => {
  await runWithRequestContext("snapshot-fake-qq", async () => {
    const victimCookie = "uin=34567; qm_keyst=attacker-controlled";
    await saveSettings({ qqMusicCookie: victimCookie });
    assert.equal(await getBackgroundJobOwnerKey(), "guest:snapshot-fake-qq");
    assert.equal((await getQqMusicAccountStatus()).ok, false);
    await assert.rejects(getQqMusicUserProfile(), /尚未通过服务端身份验证/);

    await writeStoredQqMusicIdentity("34567", victimCookie);
    assert.equal(await getBackgroundJobOwnerKey(), "account:qqmusic:34567");

    await saveSettings({ qqMusicCookie: "uin=45678; qm_keyst=replacement" });
    assert.equal(await getBackgroundJobOwnerKey(), "guest:snapshot-fake-qq");

    await writeStoredQqMusicIdentity("45678", "uin=45678; qm_keyst=replacement");
    assert.equal(await getBackgroundJobOwnerKey(), "account:qqmusic:45678");
    await saveSettings({ clearQqMusicCookie: true });
    assert.equal(await getBackgroundJobOwnerKey(), "guest:snapshot-fake-qq");
  });
});

test("QQ refresh failure may save the credential but cannot create verified owner identity", async () => {
  await runWithRequestContext("snapshot-qq-unverified-save", async () => {
    const registry = createCredentialWriteGuardRegistry();
    const persister = createQqMusicCookiePersister({
      checkCookie: async () => ({
        ok: true,
        verified: false,
        uin: "40003",
        message: "已保存但未验证"
      }),
      beginCredentialWrite: () => registry.begin("qqmusic", "snapshot-qq-unverified-save"),
      runCredentialWriteIfCurrent: (guard, operation) => registry.runIfCurrent(guard, operation),
      saveCredential: async (cookie) => {
        await saveSettingsWithinCredentialWrite({ qqMusicCookie: cookie });
      },
      writeVerifiedIdentity: writeStoredQqMusicIdentity,
      clearVerifiedIdentity: clearStoredQqMusicIdentity
    });

    const cookie = "uin=40003; qm_keyst=provider-down";
    const result = await persister.importCookie(cookie);
    assert.equal(result.verified, false);
    assert.equal((await getSettings()).qqMusicCookie, cookie);
    assert.equal(await getBackgroundJobOwnerKey(), "guest:snapshot-qq-unverified-save");
  });
});

test("QQ logout immediately clears the verified identity", async () => {
  await runWithRequestContext("snapshot-qq-logout", async () => {
    const cookie = "uin=45679; qm_keyst=verified";
    await saveSettings({ qqMusicCookie: cookie });
    await writeStoredQqMusicIdentity("45679", cookie);
    assert.equal(await getBackgroundJobOwnerKey(), "account:qqmusic:45679");

    await logoutQqMusicSession();
    assert.equal(await getBackgroundJobOwnerKey(), "guest:snapshot-qq-logout");
  });
});

test("credential fingerprints stay internal to the identity snapshot", async () => {
  await runWithRequestContext("snapshot-public-shape", async () => {
    const cookie = "uin=56789; qm_keyst=verified-secret";
    await saveSettings({ qqMusicCookie: cookie });
    await writeStoredQqMusicIdentity("56789", cookie);

    const stored = JSON.stringify(await readStoredAccountIdentitySnapshot());
    const publicState = JSON.stringify(await getAccountState());
    assert.match(stored, /credentialFingerprint/);
    assert.doesNotMatch(stored, /verified-secret/);
    assert.doesNotMatch(publicState, /credentialFingerprint|verified-secret|qm_keyst/);
  });
});
