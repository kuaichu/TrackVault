import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../domain/errors.js";
import type { ProviderAuthContext } from "../../domain/ports/music-provider.js";
import { createMockSafeHttp } from "../../test-utils/fixtures.js";
import { NeteaseAdapter } from "./netease/netease-adapter.js";
import { QqMusicAdapter } from "./qq/qq-adapter.js";

const neAuth: ProviderAuthContext = {
  platform: "netease",
  cookie: "MUSIC_U=valid",
  scopeKey: "u-provider-boundary",
  accountUid: "99",
};

const qqAuth: ProviderAuthContext = {
  platform: "qq",
  cookie: "uin=123456; qm_keyst=expired",
  scopeKey: "u-provider-boundary",
};

function createDeferredGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

test("NeteaseAdapter partial 50-track batch failure invalidates cached playlist detail", async () => {
  let upstreamTrackIds = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const adapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 888,
            name: "Batch List",
            trackCount: upstreamTrackIds.length,
            tracks: upstreamTrackIds.map((id) => ({
              id: Number(id),
              name: `Song ${id}`,
              ar: [{ name: "Singer" }],
              al: { name: "Album" },
              dt: 180_000,
            })),
            trackIds: upstreamTrackIds.map((id) => ({ id: Number(id) })),
          },
          privileges: [],
        },
      }),
      playlist_tracks: async (params) => {
        const batch = String(params.tracks ?? "")
          .split(",")
          .filter(Boolean);
        if (batch.length === 50) {
          const removeSet = new Set(batch);
          upstreamTrackIds = upstreamTrackIds.filter((id) => !removeSet.has(id));
          return { body: { code: 200, body: { code: 200 } } };
        }
        return { body: { code: 200, body: { code: 500, message: "第二批写入失败" } } };
      },
    },
  });

  const beforeDel = await adapter.getPlaylistTracks("888", { page: 1, limit: 100 }, neAuth);
  assert.equal(beforeDel.total, 51);

  const all51 = Array.from({ length: 51 }, (_, i) => String(i + 1));
  await assert.rejects(
    () => adapter.removeTracksFromPlaylist("888", all51, neAuth),
    (err: unknown) => err instanceof AppError && err.message.includes("50/51"),
  );

  const afterPartialDel = await adapter.getPlaylistTracks("888", { page: 1, limit: 100 }, neAuth);
  assert.equal(afterPartialDel.total, 1);
});

test("NeteaseAdapter cloud disk pagination advances nextOffset by raw rows and resolveAudio preserves vivid 384K", async () => {
  const adapter = new NeteaseAdapter({
    apiOverride: {
      user_cloud: async () => ({
        body: {
          code: 200,
          count: 205,
          data: Array.from({ length: 100 }, (_, i) =>
            i === 50
              ? { simpleSong: {} }
              : { songId: i + 1, songName: `Cloud ${i + 1}`, artist: "U", album: "A" },
          ),
        },
      }),
      song_url_v1: async () => ({
        body: {
          data: [
            {
              url: "http://m7.music.126.net/v.mp4",
              type: "mp4",
              br: 384_000,
              level: "vivid",
              time: 180_000,
            },
          ],
        },
      }),
    },
  });

  const cloudPage = await adapter.getCloudTracksPage(neAuth, { offset: 0, limit: 100 });
  assert.equal(cloudPage.songs.length, 99);
  assert.equal(cloudPage.nextOffset, 100);
  assert.equal(cloudPage.hasMore, true);

  const vividResolved = await adapter.resolveAudio({ id: "1" }, "exhigh", "playback", neAuth);
  assert.equal(vividResolved.level, "vivid");
  assert.equal(vividResolved.bitrate, 384_000);
});

test("NeteaseAdapter search reports scannedTotal=10,000 when 12,005-track playlist has unmappable slot", async () => {
  const all12005Ids = Array.from({ length: 12_005 }, (_, i) => i + 1);
  const adapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 901,
            name: "Huge Playlist",
            trackCount: all12005Ids.length,
            trackIds: all12005Ids.map((id) => ({ id })),
          },
        },
      }),
      song_detail: async ({ ids }) => ({
        body: {
          code: 200,
          songs: String(ids)
            .split(",")
            .map(Number)
            .map((id) =>
              id === 500
                ? { id }
                : { id, name: `Track ${id}`, ar: [{ name: "Artist" }], dt: 180_000, al: { name: "Album" } },
            ),
        },
      }),
    },
  });

  const searchPage = await adapter.getPlaylistTracks(
    "901",
    { page: 1, limit: 20, keyword: "Track 2001" },
    neAuth,
  );
  assert.equal(searchPage.truncated, true);
  assert.equal(searchPage.scannedTotal, 10_000);
  assert.equal(searchPage.songs[0]?.id, "2001");
});

test("NeteaseAdapter slow in-flight likelist GET does not overwrite toggleSongLike cache update", async () => {
  const slowStarted = createDeferredGate();
  const slowRelease = createDeferredGate();
  let likelistCalls = 0;

  const adapter = new NeteaseAdapter({
    apiOverride: {
      likelist: async () => {
        likelistCalls += 1;
        slowStarted.release();
        await slowRelease.promise;
        return { body: { code: 200, ids: ["old-heart"] } };
      },
      like: async () => ({ body: { code: 200 } }),
    },
  });

  const slowGetPromise = adapter.getLikedSongIds(neAuth);
  await slowStarted.promise;
  await adapter.toggleSongLike("new-heart", true, neAuth);
  slowRelease.release();

  const initialIds = await slowGetPromise;
  assert.deepEqual(initialIds.sort(), ["new-heart", "old-heart"]);

  const cachedIds = await adapter.getLikedSongIds(neAuth);
  assert.equal(likelistCalls, 1);
  assert.deepEqual(cachedIds.sort(), ["new-heart", "old-heart"]);
});

test("NeteaseAdapter overlapping likelist GETs never let an older GET clobber newer reads or writes", async () => {
  const oldGetGate = createDeferredGate();
  const oldGetStarted = createDeferredGate();
  let overlapCalls = 0;
  const upstreamLikes = new Set(["old-heart"]);

  const adapter = new NeteaseAdapter({
    apiOverride: {
      likelist: async () => {
        overlapCalls += 1;
        const snapshot = { body: { code: 200, ids: [...upstreamLikes] } };
        if (overlapCalls === 1) {
          oldGetStarted.release();
          await oldGetGate.promise;
        }
        return snapshot;
      },
      like: async (params) => {
        if (params.like === "true") upstreamLikes.add(String(params.id));
        else upstreamLikes.delete(String(params.id));
        return { body: { code: 200 } };
      },
    },
  });

  const overlapAuth: ProviderAuthContext = { ...neAuth, scopeKey: "u-overlap", accountUid: "88" };
  const getA = adapter.getLikedSongIds(overlapAuth);
  await oldGetStarted.promise;
  await adapter.toggleSongLike("new-heart", true, overlapAuth);
  await adapter.toggleSongLike("old-heart", false, overlapAuth);
  const resB = await adapter.getLikedSongIds(overlapAuth);
  oldGetGate.release();
  const resA = await getA;
  const resCached = await adapter.getLikedSongIds(overlapAuth);

  assert.deepEqual(resB, ["new-heart"]);
  assert.deepEqual(resA, ["new-heart"]);
  assert.deepEqual(resCached, ["new-heart"]);
  assert.equal(overlapCalls, 2);
});

test("NeteaseAdapter same-epoch cold-cache GETs and reversed same-song toggle ACKs remain monotonic", async () => {
  const sameEpochGate = createDeferredGate();
  const sameEpochStarted = createDeferredGate();
  const firstWriteGate = createDeferredGate();
  const firstWriteStarted = createDeferredGate();
  let sameEpochCalls = 0;
  let sameSongWriteCount = 0;
  const externalLikes = new Set(["old-heart"]);

  const adapter = new NeteaseAdapter({
    apiOverride: {
      likelist: async () => {
        const snap = [...externalLikes];
        if (++sameEpochCalls === 1) {
          sameEpochStarted.release();
          await sameEpochGate.promise;
        }
        return { body: { code: 200, ids: snap } };
      },
      like: async (params) => {
        const id = String(params.id);
        if (params.like === "true") externalLikes.add(id);
        else externalLikes.delete(id);
        if (++sameSongWriteCount === 1) {
          firstWriteStarted.release();
          await firstWriteGate.promise;
        }
        return { body: { code: 200 } };
      },
    },
  });

  const epochAuth: ProviderAuthContext = { ...neAuth, scopeKey: "u-same-epoch" };
  const coldGet1 = adapter.getLikedSongIds(epochAuth);
  await sameEpochStarted.promise;
  externalLikes.clear();
  externalLikes.add("new-heart");
  const coldGet2 = await adapter.getLikedSongIds(epochAuth);
  sameEpochGate.release();
  await coldGet1;
  assert.deepEqual(coldGet2, ["new-heart"]);
  assert.deepEqual(await adapter.getLikedSongIds(epochAuth), ["new-heart"]);
  assert.equal((await adapter.getLikedSongIds(epochAuth)).includes("new-heart"), true);

  const w1 = adapter.toggleSongLike("same-song", true, epochAuth);
  await firstWriteStarted.promise;
  await adapter.toggleSongLike("same-song", false, epochAuth);
  assert.equal((await adapter.getLikedSongIds(epochAuth)).includes("same-song"), false);
  firstWriteGate.release();
  await w1;
  assert.equal((await adapter.getLikedSongIds(epochAuth)).includes("same-song"), false);
});

test("QqMusicAdapter propagates HTTP 401 from collected playlists and playlist detail as CREDENTIAL_INVALID", async () => {
  const http = createMockSafeHttp(async (url) => {
    if (String(url).includes("fcg_user_created_diss")) {
      return new Response(JSON.stringify({ code: 0, data: { disslist: [] } }), { status: 200 });
    }
    return new Response("Unauthorized", { status: 401 });
  });
  const adapter = new QqMusicAdapter(http);

  try {
    await assert.rejects(
      () => adapter.getUserPlaylists(qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
    );
    await assert.rejects(
      () => adapter.getPlaylistTracks("1001", { page: 1, limit: 20 }, qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
    );
  } finally {
    http.close();
  }
});

test("QqMusicAdapter propagates inner 503 and fallback-tier HTTP 503 as UPSTREAM_ERROR", async () => {
  const inner503Http = createMockSafeHttp(
    async () => new Response(JSON.stringify({ code: 503, req_0: { code: 503 } }), { status: 200 }),
  );
  const inner503Adapter = new QqMusicAdapter(inner503Http);
  try {
    await assert.rejects(
      () => inner503Adapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "standard", "playback", qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
    );
  } finally {
    inner503Http.close();
  }

  let callCount = 0;
  const mixed503Http = createMockSafeHttp(async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: { sip: ["https://ws.stream.qqmusic.qq.com/"], midurlinfo: [{ purl: "" }] },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("Service Unavailable", { status: 503 });
  });
  const mixed503Adapter = new QqMusicAdapter(mixed503Http);
  try {
    await assert.rejects(
      () => mixed503Adapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "lossless", "playback", qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
    );
  } finally {
    mixed503Http.close();
  }
});

test("QqMusicAdapter distinguishes missing req_0 data/midurlinfo from intact empty purl", async () => {
  const missingStructHttp = createMockSafeHttp(
    async () => new Response(JSON.stringify({ code: 0, req_0: { code: 0 } }), { status: 200 }),
  );
  const missingStructQq = new QqMusicAdapter(missingStructHttp);
  try {
    await assert.rejects(
      () => missingStructQq.resolveAudio({ id: "001" }, "standard", "playback", qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
    );
  } finally {
    missingStructHttp.close();
  }

  const emptyPurlHttp = createMockSafeHttp(
    async () =>
      new Response(
        JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: { sip: ["https://ws.stream.qqmusic.qq.com/"], midurlinfo: [{ purl: "" }] },
          },
        }),
        { status: 200 },
      ),
  );
  const emptyPurlQq = new QqMusicAdapter(emptyPurlHttp);
  try {
    await assert.rejects(
      () => emptyPurlQq.resolveAudio({ id: "001" }, "standard", "playback", qqAuth),
      (err: unknown) => err instanceof AppError && err.code === "COPYRIGHT_UNAVAILABLE",
    );
  } finally {
    emptyPurlHttp.close();
  }
});
