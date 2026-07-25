import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, PersonalRadioKind, Song } from "../types.js";
import {
  createMusicDiscoveryRouter,
  type MusicDiscoveryRouterDependencies
} from "./music-discovery-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const song: Song = {
  id: "song-1",
  title: "Track",
  artist: "Artist",
  album: "Album",
  duration: "03:00",
  quality: "无损",
  availableQualities: [{ level: "lossless", label: "无损" }],
  source: "netease"
};

const settings: AppSettings = {
  accountName: "",
  vipEnabled: false,
  providerMode: "netease",
  downloadDirectory: "downloads",
  neteaseCookie: "",
  qqMusicCookie: "",
  notes: "",
  defaultPlaybackQuality: "standard",
  defaultDownloadQuality: "standard",
  maxConcurrentDownloads: 1,
  startupView: "discover",
  autoLoadDiscoverOnStart: true
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected music discovery dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<MusicDiscoveryRouterDependencies> = {}
): MusicDiscoveryRouterDependencies {
  return {
    searchProvider: async () => unexpectedDependency("searchProvider"),
    getSettings: async () => unexpectedDependency("getSettings"),
    getDiscoverSongs: async () => unexpectedDependency("getDiscoverSongs"),
    getQqDiscoverSongs: async () => unexpectedDependency("getQqDiscoverSongs"),
    getDailyRecommendSongs: async () => unexpectedDependency("getDailyRecommendSongs"),
    getPersonalRadioSongs: async () => unexpectedDependency("getPersonalRadioSongs"),
    getHeartbeatSongs: async () => unexpectedDependency("getHeartbeatSongs"),
    ...overrides
  };
}

test("search defaults missing and non-string queries to empty and netease", timeout, async () => {
  const calls: Array<[string, string]> = [];
  const dependencies = createDependencies({
    searchProvider: async (query, provider) => {
      calls.push([query, provider]);
      return [song];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const missing = await request("/api/search");
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { results: [song], provider: "netease" });

    const arrays = await request("/api/search?q=first&q=second&provider=qq&provider=aggregate");
    assert.equal(arrays.status, 200);
    assert.deepEqual(arrays.body, { results: [song], provider: "netease" });
  });

  assert.deepEqual(calls, [["", "netease"], ["", "netease"]]);
});

test("search preserves q and selects qq, aggregate, or netease exactly", timeout, async () => {
  const calls: Array<[string, string]> = [];
  const dependencies = createDependencies({
    searchProvider: async (query, provider) => {
      calls.push([query, provider]);
      return [];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    for (const provider of ["qq", "aggregate", "unknown"] as const) {
      const response = await request(`/api/search?q=%20%20hello%20&provider=${provider}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        results: [],
        provider: provider === "qq" || provider === "aggregate" ? provider : "netease"
      });
    }
  });

  assert.deepEqual(calls, [
    ["  hello ", "qq"],
    ["  hello ", "aggregate"],
    ["  hello ", "netease"]
  ]);
});

test("search keeps Error and non-Error 502 messages", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    searchProvider: async (query) => {
      calls += 1;
      throw query === "known" ? new Error("provider failed") : "provider failed";
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/search?q=known");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "provider failed" });

    const fallback = await request("/api/search?q=unknown");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "搜索失败" });
  });

  assert.equal(calls, 2);
});

test("discover selects QQ only for qq settings and wraps songs", timeout, async () => {
  const modes: AppSettings["providerMode"][] = ["qq", "netease", "aggregate", "demo"];
  const providerCalls: string[] = [];
  let settingsCalls = 0;
  const dependencies = createDependencies({
    getSettings: async () => {
      const providerMode = modes[settingsCalls];
      settingsCalls += 1;
      return { ...settings, providerMode };
    },
    getDiscoverSongs: async () => {
      providerCalls.push("netease");
      return [song];
    },
    getQqDiscoverSongs: async () => {
      providerCalls.push("qq");
      return [song];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    for (const _mode of modes) {
      const response = await request("/api/discover/songs");
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { songs: [song] });
    }
  });

  assert.equal(settingsCalls, 4);
  assert.deepEqual(providerCalls, ["qq", "netease", "netease", "netease"]);
});

test("discover keeps settings Error and provider non-Error failures at 502", timeout, async () => {
  await withTestRouter([
    createMusicDiscoveryRouter(createDependencies({
      getSettings: async () => {
        throw new Error("settings failed");
      }
    }))
  ], async ({ request }) => {
    const response = await request("/api/discover/songs");
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { message: "settings failed" });
  });

  await withTestRouter([
    createMusicDiscoveryRouter(createDependencies({
      getSettings: async () => settings,
      getDiscoverSongs: async () => {
        throw "discover failed";
      }
    }))
  ], async ({ request }) => {
    const response = await request("/api/discover/songs");
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { message: "获取发现音乐失败" });
  });
});

test("daily recommendation calls its dependency once and wraps songs", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    getDailyRecommendSongs: async () => {
      calls += 1;
      return [song];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/recommend/daily");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { songs: [song] });
  });

  assert.equal(calls, 1);
});

test("daily recommendation keeps Error and non-Error failures at 401", timeout, async () => {
  for (const [thrown, message] of [
    [new Error("login required"), "login required"],
    ["login required", "获取每日推荐失败"]
  ] as const) {
    await withTestRouter([
      createMusicDiscoveryRouter(createDependencies({
        getDailyRecommendSongs: async () => {
          throw thrown;
        }
      }))
    ], async ({ request }) => {
      const response = await request("/api/recommend/daily");
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { message });
    });
  }
});

test("personal radio selects roaming exactly and otherwise defaults to radar", timeout, async () => {
  const seenKinds: PersonalRadioKind[] = [];
  const dependencies = createDependencies({
    getPersonalRadioSongs: async (kind) => {
      seenKinds.push(kind);
      return [song];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    for (const [query, expectedKind] of [
      ["kind=roaming", "roaming"],
      ["kind=radar", "radar"],
      ["", "radar"],
      ["kind=invalid", "radar"],
      ["kind=roaming&kind=radar", "radar"]
    ] as const) {
      const response = await request(`/api/recommend/personal-radio${query ? `?${query}` : ""}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { kind: expectedKind, songs: [song] });
    }
  });

  assert.deepEqual(seenKinds, ["roaming", "radar", "radar", "radar", "radar"]);
});

test("personal radio keeps Error and non-Error failures at 401", timeout, async () => {
  for (const [thrown, message] of [
    [new Error("radio failed"), "radio failed"],
    ["radio failed", "获取私人推荐失败"]
  ] as const) {
    await withTestRouter([
      createMusicDiscoveryRouter(createDependencies({
        getPersonalRadioSongs: async () => {
          throw thrown;
        }
      }))
    ], async ({ request }) => {
      const response = await request("/api/recommend/personal-radio");
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { message });
    });
  }
});

test("heartbeat maps id, pid, sid, and a numeric count without normalization", timeout, async () => {
  const seen: Array<Parameters<MusicDiscoveryRouterDependencies["getHeartbeatSongs"]>[0]> = [];
  const dependencies = createDependencies({
    getHeartbeatSongs: async (options) => {
      seen.push(options);
      return [song];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/playmode/heartbeat?id=%20song%20&pid=list&sid=start&count=-2.5");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { songs: [song] });
  });

  assert.deepEqual(seen, [{ songId: " song ", playlistId: "list", startSongId: "start", count: -2.5 }]);
});

test("heartbeat maps missing and invalid count to undefined but empty count to zero", timeout, async () => {
  const seen: Array<{ songId: string; playlistId: string; startSongId?: string; count?: number }> = [];
  const dependencies = createDependencies({
    getHeartbeatSongs: async (options) => {
      seen.push(options);
      return [];
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    for (const suffix of ["", "&count=not-a-number", "&count="]) {
      const response = await request(`/api/playmode/heartbeat?id=song&pid=list${suffix}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { songs: [] });
    }
  });

  assert.deepEqual(seen, [
    { songId: "song", playlistId: "list", startSongId: undefined, count: undefined },
    { songId: "song", playlistId: "list", startSongId: undefined, count: undefined },
    { songId: "song", playlistId: "list", startSongId: undefined, count: 0 }
  ]);
});

test("heartbeat keeps Error status at 401 with both ids and 400 when either is absent", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    getHeartbeatSongs: async () => {
      calls += 1;
      throw new Error("heartbeat failed");
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    for (const [query, status] of [
      ["id=song&pid=list", 401],
      ["id=song", 400],
      ["pid=list", 400],
      ["", 400]
    ] as const) {
      const response = await request(`/api/playmode/heartbeat${query ? `?${query}` : ""}`);
      assert.equal(response.status, status);
      assert.deepEqual(response.body, { message: "heartbeat failed" });
    }
  });

  assert.equal(calls, 4);
});

test("heartbeat keeps the non-Error fallback and raw truthy id status behavior", timeout, async () => {
  const dependencies = createDependencies({
    getHeartbeatSongs: async () => {
      throw "heartbeat failed";
    }
  });

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/playmode/heartbeat?id=%20&pid=%20");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { message: "获取心动模式歌曲失败" });
  });
});

test("unknown, unrelated, and wrong-method paths fall through without dependency calls", timeout, async () => {
  const dependencies = createDependencies();

  await withTestRouter([createMusicDiscoveryRouter(dependencies)], async ({ request }) => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/unknown", undefined],
      ["/api/cloud/songs", undefined],
      ["/api/playlists", undefined],
      ["/api/lyrics/song-1", undefined],
      ["/api/user/profile", undefined],
      ["/api/search", { method: "POST" }]
    ];

    for (const [path, init] of requests) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
