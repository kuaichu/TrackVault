import assert from "node:assert/strict";
import test from "node:test";
import { createBackgroundJobOwnerResolver } from "./background-job-owner.js";
import { getRequiredClientSessionId, runWithRequestContext } from "./request-context.js";
import { getPlaylistCompareJob, startPlaylistCompareJob } from "./playlist-transfer/playlist-compare-job.js";
import type { AuthSession } from "./types.js";

const emptySession: AuthSession = { loggedIn: false, profile: null };

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

test("background owner priority is local account, QQ UIN, then strict guest SID", async () => {
  let session = accountSession("netease", "10001");
  let qqMusicUin: string | null = "20001";
  let localReads = 0;
  let settingsReads = 0;
  const resolveOwner = createBackgroundJobOwnerResolver({
    getClientSessionId: getRequiredClientSessionId,
    getCredentials: async () => {
      settingsReads += 1;
      return { neteaseCookie: "netease", qqMusicCookie: "qq" };
    },
    readVerifiedIdentityState: async () => {
      localReads += 1;
      return { session, qqMusicUin };
    }
  });
  const resolveFor = (sid: string) => runWithRequestContext(sid, resolveOwner);

  assert.equal(await resolveFor("client-a"), "account:netease:10001");
  session = accountSession("demo", "demo-a");
  assert.equal(await resolveFor("client-a"), "account:demo:demo-a");
  session = accountSession("demo", "demo-b");
  assert.equal(await resolveFor("client-a"), "account:demo:demo-b");

  session = emptySession;
  assert.equal(await resolveFor("client-a"), "account:qqmusic:20001");
  qqMusicUin = "20002";
  assert.equal(await resolveFor("client-a"), "account:qqmusic:20002");

  qqMusicUin = null;
  assert.equal(await resolveFor("client-a"), "guest:client-a");
  assert.equal(await resolveFor("client-b"), "guest:client-b");
  assert.equal(localReads, 7);
  assert.equal(settingsReads, 7);
});

test("background owner rejects missing, default, and malformed SIDs", async () => {
  const resolveOwner = createBackgroundJobOwnerResolver({
    getClientSessionId: getRequiredClientSessionId,
    getCredentials: async () => ({ neteaseCookie: "", qqMusicCookie: "" }),
    readVerifiedIdentityState: async () => ({ session: emptySession, qqMusicUin: null })
  });

  for (const sid of [undefined, "default", "bad!sid"]) {
    await assert.rejects(
      runWithRequestContext(sid, resolveOwner),
      /客户端会话标识/
    );
  }
});

test("QQ account switch cannot read a job created by the previous account", async () => {
  let qqMusicUin: string | null = "30001";
  const resolveOwner = createBackgroundJobOwnerResolver({
    getClientSessionId: getRequiredClientSessionId,
    getCredentials: async () => ({ neteaseCookie: "", qqMusicCookie: "" }),
    readVerifiedIdentityState: async () => ({ session: emptySession, qqMusicUin })
  });
  const resolveForCurrentAccount = () => runWithRequestContext("shared-browser", resolveOwner);

  const ownerA = await resolveForCurrentAccount();
  const job = startPlaylistCompareJob(ownerA, {
    leftProvider: "netease",
    leftPlaylistId: "left",
    leftPlaylistName: "Left",
    rightProvider: "qq",
    rightPlaylistId: "right",
    rightPlaylistName: "Right"
  }, {
    loadSideTracks: async () => []
  });

  qqMusicUin = "30002";
  const ownerB = await resolveForCurrentAccount();
  assert.notEqual(ownerA, ownerB);
  assert.equal(getPlaylistCompareJob(ownerB, job.id), null);
  assert.equal(getPlaylistCompareJob(ownerB, "missing"), null);
});
