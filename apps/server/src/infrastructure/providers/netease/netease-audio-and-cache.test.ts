import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import test from "node:test";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { NeteaseAdapter } from "./netease-adapter.js";
import { mapNeteaseSong } from "./netease-mapper.js";
import { type NeteaseAxiosRequestConfig, NeteaseRpcClient, neteaseAxios } from "./netease-rpc-client.js";

const neAuthA: ProviderAuthContext = {
  platform: "netease",
  cookie: "MUSIC_U=account_a",
  scopeKey: "user-1",
  accountUid: "111",
};

const neAuthB: ProviderAuthContext = {
  platform: "netease",
  cookie: "MUSIC_U=account_b",
  scopeKey: "user-1",
  accountUid: "222",
};

test("NeteaseAdapter.resolveAudio prunes via availableLevels, short-circuits on 301/UPSTREAM_TIMEOUT, and preserves upstream errors over trailing empty URL", async () => {
  const probedLevels: string[] = [];
  const adapterLevels = new NeteaseAdapter({
    apiOverride: {
      song_url_v1: async (params) => {
        probedLevels.push(String(params.level));
        return {
          body: {
            code: 200,
            data: [
              {
                url: "https://m7.music.126.net/ok.mp3",
                type: "mp3",
                br: 320_000,
                level: "exhigh",
                time: 200_000,
              },
            ],
          },
        };
      },
    },
  });

  const resolved = await adapterLevels.resolveAudio(
    { id: "100", availableLevels: ["standard", "exhigh"] },
    "hires",
    "playback",
    neAuthA,
  );
  assert.equal(resolved.level, "exhigh");
  assert.deepEqual(probedLevels, ["exhigh"]);
  adapterLevels.close();

  // 301 auth invalidation short-circuits immediately
  let auth301Calls = 0;
  const adapter301 = new NeteaseAdapter({
    apiOverride: {
      song_url_v1: async () => {
        auth301Calls += 1;
        return { body: { code: 301, message: "需要登录" } };
      },
    },
  });
  await assert.rejects(
    () => adapter301.resolveAudio({ id: "100" }, "hires", "playback", neAuthA),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  assert.equal(auth301Calls, 1);
  adapter301.close();

  // Higher tier UPSTREAM_ERROR is preserved when trailing standard tier returns empty URL (in both download & playback modes)
  const mixedHandler = async (params: Record<string, unknown>) => {
    if (params.level === "lossless") {
      throw new Error("502 Bad Gateway");
    }
    return { body: { code: 200, data: [{ url: null }] } };
  };
  const adapterMixed = new NeteaseAdapter({
    apiOverride: {
      song_url_v1: mixedHandler,
      song_download_url_v1: mixedHandler,
    },
  });
  await assert.rejects(
    () =>
      adapterMixed.resolveAudio(
        { id: "100", availableLevels: ["standard", "lossless"] },
        "lossless",
        "download",
        neAuthA,
      ),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  await assert.rejects(
    () =>
      adapterMixed.resolveAudio(
        { id: "100", availableLevels: ["standard", "lossless"] },
        "lossless",
        "playback",
        neAuthA,
      ),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  adapterMixed.close();
});

test("NeteaseAdapter blocks stale Account A like-read/write backfill after invalidateScope rebind to Account B", async () => {
  let releaseSlowReadA: () => void = () => undefined;
  let slowReadAStarted: () => void = () => undefined;
  const slowReadAGate = new Promise<void>((r) => {
    releaseSlowReadA = r;
  });
  const slowReadAReady = new Promise<void>((r) => {
    slowReadAStarted = r;
  });

  let releaseSlowWriteA: () => void = () => undefined;
  let slowWriteAStarted: () => void = () => undefined;
  const slowWriteAGate = new Promise<void>((r) => {
    releaseSlowWriteA = r;
  });
  const slowWriteAReady = new Promise<void>((r) => {
    slowWriteAStarted = r;
  });

  const adapter = new NeteaseAdapter({
    apiOverride: {
      likelist: async (params) => {
        if (params.uid === "111") {
          slowReadAStarted();
          await slowReadAGate;
          return { body: { code: 200, ids: ["song-from-A"] } };
        }
        return { body: { code: 200, ids: ["song-from-B"] } };
      },
      like: async (params) => {
        if (String(params.cookie ?? "").includes("account_a")) {
          slowWriteAStarted();
          await slowWriteAGate;
        }
        return { body: { code: 200 } };
      },
    },
  });

  try {
    // Start slow Account A read & write
    const pendingReadA = adapter.getLikedSongIds(neAuthA);
    await slowReadAReady;
    const pendingWriteA = adapter.toggleSongLike("only-in-A", true, neAuthA);
    await slowWriteAReady;

    // User unbinds A and binds B under the same scopeKey ("user-1")
    adapter.invalidateScope("user-1");

    // Account B reads its like list first -> caches ["song-from-B"]
    const likesB1 = await adapter.getLikedSongIds(neAuthB);
    assert.deepEqual(likesB1, ["song-from-B"]);

    // Now Account A's old-epoch read and write resolve late -> MUST NOT poison Account B's caches!
    releaseSlowReadA();
    releaseSlowWriteA();
    await pendingReadA;
    await pendingWriteA;

    const likesB2 = await adapter.getLikedSongIds(neAuthB);
    assert.deepEqual(likesB2, ["song-from-B"]);
    assert.equal((await adapter.getLikedSongIds(neAuthB)).includes("only-in-A"), false);
  } finally {
    adapter.close();
  }
});

test("NeteaseAdapter shares public cache without forwarding private cookies and coalesces playlist detail + hydration singleflight", async () => {
  let discoverCalls = 0;
  let chartsCalls = 0;
  let lyricCalls = 0;
  let chartsSawCookie = false;
  let lyricSawCookie = false;
  let playlistDetailCalls = 0;
  let songDetailCalls = 0;

  let releaseSongDetail: () => void = () => undefined;
  let songDetailStarted: () => void = () => undefined;
  const songDetailGate = new Promise<void>((r) => {
    releaseSongDetail = r;
  });
  const songDetailReady = new Promise<void>((r) => {
    songDetailStarted = r;
  });

  const adapter = new NeteaseAdapter({
    apiOverride: {
      personalized_newsong: async () => {
        discoverCalls += 1;
        return { body: { code: 200, result: [{ id: 1 }] } };
      },
      toplist: async (params) => {
        chartsCalls += 1;
        if (params.cookie) chartsSawCookie = true;
        return { body: { code: 200, list: [{ id: 10, name: "Hot", trackCount: 1 }] } };
      },
      lyric_new: async (params) => {
        lyricCalls += 1;
        if (params.cookie) lyricSawCookie = true;
        return { body: { code: 200, lrc: { lyric: "[00:01.00]Line" } } };
      },
      playlist_detail: async () => {
        playlistDetailCalls += 1;
        return {
          body: {
            code: 200,
            playlist: {
              id: 555,
              name: "Shared",
              trackCount: 2,
              trackIds: [{ id: 1 }, { id: 2 }],
            },
          },
        };
      },
      song_detail: async ({ ids }) => {
        songDetailCalls += 1;
        if (String(ids) === "1,2") {
          songDetailStarted();
          await songDetailGate;
        }
        return {
          body: {
            code: 200,
            songs: String(ids)
              .split(",")
              .map((id) => ({
                id: Number(id),
                name: `Song ${id}`,
                ar: [{ name: "Artist" }],
                al: { name: "Album" },
                dt: 180_000,
              })),
          },
        };
      },
    },
  });

  try {
    // 1. Unauthenticated discover shares "public" cache across different user scopeKeys
    await adapter.getDiscoverTracks({ platform: "netease", cookie: null, scopeKey: "u1" });
    await adapter.getDiscoverTracks({ platform: "netease", cookie: null, scopeKey: "u2" });
    assert.equal(discoverCalls, 1);

    // 2. Public endpoints (charts & lyrics) never send private user cookie into shared "public" cache
    await adapter.getCharts(neAuthA);
    await adapter.getLyrics("1", undefined, neAuthA);
    assert.equal(chartsCalls, 1);
    assert.equal(lyricCalls, 1);
    assert.equal(chartsSawCookie, false);
    assert.equal(lyricSawCookie, false);

    // 3. Concurrent playlist detail + hydration coalesces into singleflight and invalidation prevents stale songMap commit
    songDetailCalls = 0;
    const p1 = adapter.getPlaylistTracks("555", { page: 1, limit: 10 }, neAuthA);
    const p2 = adapter.getPlaylistTracks("555", { page: 1, limit: 10 }, neAuthA);
    await songDetailReady;
    assert.equal(playlistDetailCalls, 1);
    assert.equal(songDetailCalls, 1);

    // Invalidate scope mid-flight: p1/p2 still resolve cleanly, and next read re-fetches fresh data instead of stale cache
    adapter.invalidateScope("user-1");
    releaseSongDetail();
    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.songs.length, 2);
    assert.equal(res2.songs.length, 2);

    await adapter.getPlaylistTracks("555", { page: 1, limit: 10 }, neAuthA);
    assert.equal(playlistDetailCalls, 2);
  } finally {
    adapter.close();
  }
});

test("NeteaseRpcClient.call propagates AbortSignal and shared bounded keep-alive agents into Axios while preserving custom proxy agents", async () => {
  const interceptedConfigs: NeteaseAxiosRequestConfig[] = [];
  const originalAdapter = neteaseAxios.defaults.adapter;
  let hangUntilAbort = false;

  neteaseAxios.defaults.adapter = async (config: NeteaseAxiosRequestConfig) => {
    interceptedConfigs.push(config);
    if (hangUntilAbort) {
      await new Promise<never>((_resolve, reject) => {
        const sig = config.signal;
        if (sig?.aborted) {
          const err = new Error("canceled");
          err.name = "CanceledError";
          reject(err);
          return;
        }
        sig?.addEventListener(
          "abort",
          () => {
            const err = new Error("canceled");
            err.name = "CanceledError";
            reject(err);
          },
          { once: true },
        );
      });
    }
    return {
      data: JSON.stringify({ code: 200, list: [] }),
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };

  const rpc = new NeteaseRpcClient({ timeoutMs: 8000 });
  try {
    const controller1 = new AbortController();
    await rpc.call(
      () => rpc.api.toplist(rpc.baseParams(undefined, { e_r: false }, controller1.signal)),
      controller1.signal,
    );

    const controller2 = new AbortController();
    await rpc.call(
      () => rpc.api.toplist(rpc.baseParams(undefined, { e_r: false }, controller2.signal)),
      controller2.signal,
    );

    assert.equal(interceptedConfigs.length, 2);
    const first = interceptedConfigs[0];
    const second = interceptedConfigs[1];
    assert.ok(first && second);
    assert.equal(first.signal, controller1.signal);
    assert.equal(second.signal, controller2.signal);
    assert.equal(first.proxy, false);

    assert.ok(first.httpAgent instanceof http.Agent);
    assert.ok(first.httpsAgent instanceof https.Agent);
    assert.equal(first.httpAgent, second.httpAgent);
    assert.equal(first.httpsAgent, second.httpsAgent);
    assert.equal((first.httpAgent as http.Agent & { keepAlive?: boolean }).keepAlive, true);
    assert.equal(first.httpAgent.maxSockets, 32);
    assert.equal(first.httpAgent.maxFreeSockets, 8);
    assert.equal((first.httpsAgent as https.Agent & { keepAlive?: boolean }).keepAlive, true);
    assert.equal(first.httpsAgent.maxSockets, 32);
    assert.equal(first.httpsAgent.maxFreeSockets, 8);

    // Custom proxy/tunnel agent (non-plain Agent subclass) must not be overwritten
    class CustomTunnelAgent extends https.Agent {}
    const customAgent = new CustomTunnelAgent();
    try {
      await rpc.call(() =>
        neteaseAxios({
          url: "https://music.163.com/api/test",
          method: "POST",
          proxy: false,
          httpAgent: customAgent,
          httpsAgent: customAgent,
        }),
      );
      const third = interceptedConfigs[2];
      assert.ok(third);
      assert.equal(third.httpAgent, customAgent);
      assert.equal(third.httpsAgent, customAgent);
      assert.equal(third.signal, undefined);
    } finally {
      customAgent.destroy();
    }

    // Aborting in-flight controller aborts the intercepted Axios config.signal and rejects with UPSTREAM_TIMEOUT
    hangUntilAbort = true;
    const abortInFlight = new AbortController();
    const pendingCall = rpc.call(
      () => rpc.api.toplist(rpc.baseParams(undefined, { e_r: false }, abortInFlight.signal)),
      abortInFlight.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(interceptedConfigs[3]?.signal, abortInFlight.signal);
    assert.equal(interceptedConfigs[3]?.signal?.aborted, false);

    abortInFlight.abort();
    await assert.rejects(
      () => pendingCall,
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
    );
    assert.equal(interceptedConfigs[3]?.signal?.aborted, true);
  } finally {
    neteaseAxios.defaults.adapter = originalAdapter;
    rpc.close();
  }
});

test("mapNeteaseSong derives multi-tier qualities from hMusic/sqMusic, privilege maxBrLevel/maxbr, and cloud flag", () => {
  const fmSong = mapNeteaseSong({
    id: 1001,
    name: "FM Song",
    artists: [{ id: 1, name: "Artist" }],
    album: { id: 2, name: "Album" },
    duration: 210_000,
    hMusic: { br: 320_000, size: 8_400_000 },
    sqMusic: { br: 999_000, size: 26_000_000 },
    hrMusic: { br: 0, size: 0 },
  });
  assert.deepEqual(
    fmSong?.availableQualities.map((q) => q.level),
    ["standard", "exhigh", "lossless"],
  );
  assert.equal(fmSong?.quality, "FLAC");

  const privHiresSong = mapNeteaseSong(
    {
      id: 1002,
      name: "Privilege Hi-Res Song",
      ar: [{ id: 1, name: "Artist" }],
      al: { id: 2, name: "Album" },
      dt: 180_000,
    },
    {
      privilege: {
        id: 1002,
        maxbr: 999_000,
        maxBrLevel: "hires",
      },
    },
  );
  assert.deepEqual(
    privHiresSong?.availableQualities.map((q) => q.level),
    ["standard", "exhigh", "lossless", "hires"],
  );
  assert.equal(privHiresSong?.quality, "Hi-Res");

  const cloudSong = mapNeteaseSong(
    {
      id: 1003,
      name: "Cloud Song",
    },
    { isCloud: true },
  );
  assert.deepEqual(
    cloudSong?.availableQualities.map((q) => q.level),
    ["standard", "exhigh"],
  );
});
