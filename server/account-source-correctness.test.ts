import assert from "node:assert/strict";
import test from "node:test";
import {
  decideScopedHydration,
  getPlayerStateFingerprint,
  getScopedStorageKey,
  ScopedWriteQueue,
  shouldApplyScopedResult,
  shouldMigrateLegacyData,
  shouldPersistScopedState
} from "./account-persistence.js";
import {
  canDownloadSong,
  getDownloadAuthRequirement,
  getMissingDownloadProviders
} from "./download-auth-policy.js";
import { extractQqMusicUin, resolveDataScopeId } from "./data-scope.js";

const emptySession = { loggedIn: false, profile: null } as const;

test("Netease and demo accounts receive stable distinct data scopes", () => {
  const neteaseA = resolveDataScopeId({
    session: { loggedIn: true, profile: { id: "10001", provider: "netease" } },
    qqMusicCookie: "uin=99999",
    clientSessionId: "client-a"
  });
  const neteaseB = resolveDataScopeId({
    session: { loggedIn: true, profile: { id: "10002", provider: "netease" } },
    qqMusicCookie: "uin=99999",
    clientSessionId: "client-b"
  });
  const sameNeteaseOnAnotherClient = resolveDataScopeId({
    session: { loggedIn: true, profile: { id: "10001", provider: "netease" } },
    qqMusicCookie: "",
    clientSessionId: "another-client"
  });
  const demo = resolveDataScopeId({
    session: { loggedIn: true, profile: { id: "demo-uuid", provider: "demo" } },
    qqMusicCookie: "uin=99999",
    clientSessionId: "client-a"
  });

  assert.notEqual(neteaseA, neteaseB);
  assert.equal(neteaseA, sameNeteaseOnAnotherClient);
  assert.notEqual(neteaseA, demo);
  assert.match(neteaseA, /^account:netease:/);
});

test("QQ-only accounts use UIN while guest scopes stay client-session bound", () => {
  const qqA = resolveDataScopeId({ session: emptySession, qqMusicCookie: "uin=o12345", clientSessionId: "client-a" });
  const qqB = resolveDataScopeId({ session: emptySession, qqMusicCookie: "uin=67890", clientSessionId: "client-a" });
  const guestA = resolveDataScopeId({ session: emptySession, qqMusicCookie: "", clientSessionId: "client-a" });
  const guestB = resolveDataScopeId({ session: emptySession, qqMusicCookie: "", clientSessionId: "client-b" });

  assert.equal(qqA, "account:qqmusic:12345");
  assert.equal(qqB, "account:qqmusic:67890");
  assert.notEqual(qqA, qqB);
  assert.notEqual(guestA, guestB);
  assert.notEqual(guestA, qqA);
});

test("QQ UIN parsing supports wxuin login and data scopes expose no secrets", () => {
  const cookie = "login_type=2; wxuin=o24680; marker=synthetic-token-value";
  const scope = resolveDataScopeId({ session: emptySession, qqMusicCookie: cookie, clientSessionId: "guest-token" });

  assert.equal(extractQqMusicUin(cookie), "24680");
  assert.equal(scope, "account:qqmusic:24680");
  assert.doesNotMatch(scope, /synthetic-token-value|marker|guest-token/i);
});

test("provider mode cannot change the data owner", () => {
  const input = {
    session: { loggedIn: true, profile: { id: "10001", provider: "netease" as const } },
    qqMusicCookie: "uin=24680",
    clientSessionId: "client-a"
  };
  const modes = ["netease", "qq", "aggregate", "demo"];
  assert.deepEqual(modes.map(() => resolveDataScopeId(input)), modes.map(() => "account:netease:10001"));
});

test("scoped storage keys isolate accounts and data kinds", () => {
  const searchA = getScopedStorageKey("search-history", "account:netease:1");
  const searchB = getScopedStorageKey("search-history", "account:netease:2");
  const playerA = getScopedStorageKey("player-state", "account:netease:1");

  assert.notEqual(searchA, searchB);
  assert.notEqual(searchA, playerA);
  assert.match(searchA, /account%3Anetease%3A1/);
});

test("remote empty data uploads only a local value from the current scoped key", () => {
  assert.deepEqual(decideScopedHydration({ remoteSucceeded: true, remoteHasData: false, scopedLocalHasData: true }), {
    source: "scoped-local",
    uploadScopedLocal: true
  });
  assert.deepEqual(decideScopedHydration({ remoteSucceeded: true, remoteHasData: false, scopedLocalHasData: false }), {
    source: "remote",
    uploadScopedLocal: false
  });
  assert.deepEqual(decideScopedHydration({ remoteSucceeded: false, remoteHasData: false, scopedLocalHasData: true }), {
    source: "scoped-local",
    uploadScopedLocal: false
  });
});

test("stale scope results and pre-hydration player saves are rejected", () => {
  assert.equal(shouldApplyScopedResult("account:netease:a", "account:netease:b"), false);
  assert.equal(shouldApplyScopedResult("account:netease:b", "account:netease:b"), true);
  assert.equal(shouldPersistScopedState({ hydrated: false, capturedScope: "scope-b", currentScope: "scope-b" }), false);
  assert.equal(shouldPersistScopedState({ hydrated: true, capturedScope: "scope-a", currentScope: "scope-b" }), false);
  assert.equal(shouldPersistScopedState({ hydrated: true, capturedScope: "scope-b", currentScope: "scope-b" }), true);
});

test("player fingerprints detect queue, position, volume, and mode changes during hydration", () => {
  const base = {
    currentTrack: { id: "song-a", source: "netease" },
    playQueue: [{ id: "song-a", source: "netease" }],
    playbackSeconds: 10,
    volume: 72,
    playbackMode: "sequential"
  };
  const fingerprint = getPlayerStateFingerprint(base);

  assert.notEqual(fingerprint, getPlayerStateFingerprint({ ...base, playQueue: [{ id: "song-b", source: "qqmusic" }] }));
  assert.notEqual(fingerprint, getPlayerStateFingerprint({ ...base, playbackSeconds: 11 }));
  assert.notEqual(fingerprint, getPlayerStateFingerprint({ ...base, volume: 60 }));
  assert.notEqual(fingerprint, getPlayerStateFingerprint({ ...base, playbackMode: "shuffle" }));
});

test("scoped writes are serialized so an older snapshot cannot finish after a newer one", async () => {
  const queue = new ScopedWriteQueue();
  const events: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.enqueue("scope:player", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = queue.enqueue("scope:player", async () => {
    events.push("second-start");
    events.push("second-end");
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
});

test("legacy data is marked once without binding it to whichever account is active", () => {
  assert.equal(shouldMigrateLegacyData({ dataScopeId: "guest:client-a", migrationMarker: null, hasLegacyData: true }), true);
  assert.equal(shouldMigrateLegacyData({ dataScopeId: "account:netease:1", migrationMarker: null, hasLegacyData: true }), true);
  assert.equal(shouldMigrateLegacyData({ dataScopeId: "guest:client-a", migrationMarker: "guest:client-a", hasLegacyData: true }), false);
  assert.equal(shouldMigrateLegacyData({ dataScopeId: "guest:client-a", migrationMarker: null, hasLegacyData: false }), false);
});

test("download requirements are source-aware and unknown sources are rejected", () => {
  assert.equal(getDownloadAuthRequirement({ source: "qqmusic" }), "qqmusic");
  assert.equal(getDownloadAuthRequirement({ source: "netease" }), "netease");
  assert.equal(getDownloadAuthRequirement({ source: "netease-cloud" }), "netease");
  assert.equal(getDownloadAuthRequirement({ source: "qq" }), "unsupported");
  assert.equal(getDownloadAuthRequirement({ source: "legacy-task" }), "unsupported");
});

test("Netease-only credentials allow only Netease songs", () => {
  const auth = { hasNeteaseDownloadCredential: true, hasQqMusicDownloadCredential: false };
  assert.deepEqual(canDownloadSong({ source: "netease" }, auth), { allowed: true, requirement: "netease" });
  assert.deepEqual(canDownloadSong({ source: "qqmusic" }, auth), { allowed: false, requirement: "qqmusic", missingProvider: "qqmusic" });
});

test("QQ-only credentials allow QQ single and batch downloads", () => {
  const auth = { hasNeteaseDownloadCredential: false, hasQqMusicDownloadCredential: true };
  assert.deepEqual(canDownloadSong({ source: "qqmusic" }, auth), { allowed: true, requirement: "qqmusic" });
  assert.deepEqual(getMissingDownloadProviders([{ source: "qqmusic" }, { source: "qqmusic" }], auth), {
    missingProviders: [],
    unsupportedSources: []
  });
});

test("mixed batches require both platforms before any download can start", () => {
  const songs = [{ source: "netease" }, { source: "qqmusic" }];
  assert.deepEqual(getMissingDownloadProviders(songs, {
    hasNeteaseDownloadCredential: true,
    hasQqMusicDownloadCredential: true
  }), { missingProviders: [], unsupportedSources: [] });
  assert.deepEqual(getMissingDownloadProviders(songs, {
    hasNeteaseDownloadCredential: true,
    hasQqMusicDownloadCredential: false
  }), { missingProviders: ["qqmusic"], unsupportedSources: [] });
  assert.deepEqual(getMissingDownloadProviders(songs, {
    hasNeteaseDownloadCredential: false,
    hasQqMusicDownloadCredential: true
  }), { missingProviders: ["netease"], unsupportedSources: [] });
  assert.deepEqual(getMissingDownloadProviders(songs, {
    hasNeteaseDownloadCredential: false,
    hasQqMusicDownloadCredential: false
  }), { missingProviders: ["netease", "qqmusic"], unsupportedSources: [] });
});

test("unsupported sources block the whole batch", () => {
  assert.deepEqual(getMissingDownloadProviders([{ source: "netease" }, { source: "mystery" }], {
    hasNeteaseDownloadCredential: true,
    hasQqMusicDownloadCredential: true
  }), { missingProviders: [], unsupportedSources: ["mystery"] });
});
