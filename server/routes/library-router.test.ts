import assert from "node:assert/strict";
import test from "node:test";
import type { AppSettings, PlaylistSongsPage, UserPlaylist } from "../types.js";
import {
  createLibraryRouter,
  type LibraryRouterDependencies,
  resolvePlaylistProvider
} from "./library-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

function createSettings(providerMode: AppSettings["providerMode"]): AppSettings {
  return {
    accountName: "tester",
    vipEnabled: false,
    providerMode,
    downloadDirectory: "downloads",
    neteaseCookie: "",
    qqMusicCookie: "",
    notes: "",
    defaultPlaybackQuality: "standard",
    defaultDownloadQuality: "standard",
    maxConcurrentDownloads: 1,
    startupView: "playlists",
    autoLoadDiscoverOnStart: false
  };
}

const neteasePlaylist: UserPlaylist = {
  id: "netease-list",
  name: "Netease list",
  trackCount: 2,
  creatorName: "Netease user",
  playCount: 3,
  owned: true
};

const qqPlaylist: UserPlaylist = {
  id: "qq-list",
  name: "QQ list",
  trackCount: 4,
  creatorName: "QQ user",
  playCount: 5,
  owned: false
};

const playlistSongsPage: PlaylistSongsPage = {
  songs: [],
  page: 7,
  limit: 19,
  hasMore: true,
  total: 23,
  sourceTotal: 29,
  keyword: "dependency result"
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected library dependency call: ${name}`);
}

function createDependencies(overrides: Partial<LibraryRouterDependencies> = {}): LibraryRouterDependencies {
  return {
    getSettings: async () => unexpectedDependency("getSettings"),
    getUserPlaylists: async () => unexpectedDependency("getUserPlaylists"),
    getQqUserPlaylists: async () => unexpectedDependency("getQqUserPlaylists"),
    getPlaylistSongs: async () => unexpectedDependency("getPlaylistSongs"),
    getQqPlaylistSongs: async () => unexpectedDependency("getQqPlaylistSongs"),
    addSongToUserPlaylist: async () => unexpectedDependency("addSongToUserPlaylist"),
    removeSongsFromUserPlaylist: async () => unexpectedDependency("removeSongsFromUserPlaylist"),
    getCloudSongs: async () => unexpectedDependency("getCloudSongs"),
    ...overrides
  };
}

test("playlist provider resolution preserves query priority and settings fallback", () => {
  const cases: Array<{
    queryProvider: unknown;
    settingsProvider: AppSettings["providerMode"];
    expected: "netease" | "qq";
  }> = [
    { queryProvider: "qq", settingsProvider: "netease", expected: "qq" },
    { queryProvider: "netease", settingsProvider: "qq", expected: "netease" },
    { queryProvider: "aggregate", settingsProvider: "qq", expected: "qq" },
    { queryProvider: "unknown", settingsProvider: "qq", expected: "qq" },
    { queryProvider: ["qq"], settingsProvider: "netease", expected: "netease" },
    { queryProvider: "", settingsProvider: "qq", expected: "qq" },
    { queryProvider: "QQ", settingsProvider: "netease", expected: "netease" },
    { queryProvider: undefined, settingsProvider: "qq", expected: "qq" },
    { queryProvider: undefined, settingsProvider: "aggregate", expected: "netease" },
    { queryProvider: undefined, settingsProvider: "demo", expected: "netease" },
    { queryProvider: undefined, settingsProvider: "netease", expected: "netease" }
  ];

  for (const testCase of cases) {
    assert.equal(
      resolvePlaylistProvider(testCase.queryProvider, { providerMode: testCase.settingsProvider }),
      testCase.expected
    );
  }
});

test("playlist list dispatches to one provider and wraps successful results", timeout, async () => {
  let settingsCalls = 0;
  let neteaseCalls = 0;
  let qqCalls = 0;
  const dependencies = createDependencies({
    getSettings: async () => {
      settingsCalls += 1;
      return createSettings("qq");
    },
    getUserPlaylists: async () => {
      neteaseCalls += 1;
      return [neteasePlaylist];
    },
    getQqUserPlaylists: async () => {
      qqCalls += 1;
      return [qqPlaylist];
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const neteaseResponse = await request("/api/playlists?provider=netease");
    assert.equal(neteaseResponse.status, 200);
    assert.deepEqual(neteaseResponse.body, { playlists: [neteasePlaylist] });

    const qqResponse = await request("/api/playlists?provider=qq");
    assert.equal(qqResponse.status, 200);
    assert.deepEqual(qqResponse.body, { playlists: [qqPlaylist] });

    const fallbackResponse = await request("/api/playlists?provider=aggregate");
    assert.equal(fallbackResponse.status, 200);
    assert.deepEqual(fallbackResponse.body, { playlists: [qqPlaylist] });
  });

  assert.equal(settingsCalls, 3);
  assert.equal(neteaseCalls, 1);
  assert.equal(qqCalls, 2);
});

test("playlist list errors preserve the 401 status and messages", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    getSettings: async () => createSettings("netease"),
    getUserPlaylists: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("playlist failure");
      }
      throw "non-error failure";
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const errorResponse = await request("/api/playlists");
    assert.equal(errorResponse.status, 401);
    assert.deepEqual(errorResponse.body, { message: "playlist failure" });

    const fallbackResponse = await request("/api/playlists");
    assert.equal(fallbackResponse.status, 401);
    assert.deepEqual(fallbackResponse.body, { message: "获取歌单失败" });
  });

  assert.equal(calls, 2);
});

test("playlist songs preserves parameter conversion and returns the provider page directly", timeout, async () => {
  const seen: Array<{
    playlistId: string;
    page: number;
    limit: number;
    keyword: string;
    sort: string;
  }> = [];
  const dependencies = createDependencies({
    getSettings: async () => createSettings("netease"),
    getPlaylistSongs: async (playlistId, page, limit, keyword, sort) => {
      seen.push({ playlistId, page, limit, keyword, sort });
      return playlistSongsPage;
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const firstResponse = await request(
      "/api/playlists/raw%20id/songs?page=2&limit=25&keyword=%20hello%20&sort=recent"
    );
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(firstResponse.body, playlistSongsPage);
    assert.equal(Object.prototype.hasOwnProperty.call(firstResponse.body, "songsPage"), false);

    for (const path of [
      "/api/playlists/missing/songs",
      "/api/playlists/empty/songs?page=&limit=",
      "/api/playlists/invalid/songs?page=nope&limit=bad&keyword=one&keyword=two&sort=a&sort=b"
    ]) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, playlistSongsPage);
    }
  });

  assert.deepEqual(seen[0], {
    playlistId: "raw id",
    page: 2,
    limit: 25,
    keyword: " hello ",
    sort: "recent"
  });
  assert.equal(seen[1]?.playlistId, "missing");
  assert.equal(Number.isNaN(seen[1]?.page), true);
  assert.equal(Number.isNaN(seen[1]?.limit), true);
  assert.equal(seen[1]?.keyword, "");
  assert.equal(seen[1]?.sort, "default");
  assert.deepEqual(seen[2], {
    playlistId: "empty",
    page: 0,
    limit: 0,
    keyword: "",
    sort: "default"
  });
  assert.equal(seen[3]?.playlistId, "invalid");
  assert.equal(Number.isNaN(seen[3]?.page), true);
  assert.equal(Number.isNaN(seen[3]?.limit), true);
  assert.equal(seen[3]?.keyword, "");
  assert.equal(seen[3]?.sort, "default");
});

test("playlist songs dispatches by read provider and preserves 502 errors", timeout, async () => {
  let settingsCalls = 0;
  let neteaseCalls = 0;
  let qqCalls = 0;
  const dependencies = createDependencies({
    getSettings: async () => {
      settingsCalls += 1;
      return createSettings(settingsCalls % 2 === 1 ? "netease" : "qq");
    },
    getPlaylistSongs: async (playlistId) => {
      neteaseCalls += 1;
      if (playlistId === "netease-error") {
        throw new Error("netease songs failure");
      }
      return playlistSongsPage;
    },
    getQqPlaylistSongs: async (playlistId) => {
      qqCalls += 1;
      if (playlistId === "qq-error") {
        throw "qq songs failure";
      }
      return playlistSongsPage;
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const qqResponse = await request("/api/playlists/qq-success/songs?provider=qq");
    assert.equal(qqResponse.status, 200);

    const neteaseResponse = await request("/api/playlists/netease-success/songs?provider=netease");
    assert.equal(neteaseResponse.status, 200);

    const errorResponse = await request("/api/playlists/netease-error/songs?provider=netease");
    assert.equal(errorResponse.status, 502);
    assert.deepEqual(errorResponse.body, { message: "netease songs failure" });

    const fallbackResponse = await request("/api/playlists/qq-error/songs?provider=qq");
    assert.equal(fallbackResponse.status, 502);
    assert.deepEqual(fallbackResponse.body, { message: "获取歌单歌曲失败" });
  });

  assert.equal(settingsCalls, 4);
  assert.equal(neteaseCalls, 2);
  assert.equal(qqCalls, 2);
});

test("adding tracks uses only settings and preserves songId conversion and 201 responses", timeout, async () => {
  const modes: AppSettings["providerMode"][] = ["netease", "aggregate", "demo"];
  let settingsCalls = 0;
  const seen: Array<{ playlistId: string; songId: string }> = [];
  const dependencies = createDependencies({
    getSettings: async () => createSettings(modes[settingsCalls++] ?? "netease"),
    addSongToUserPlaylist: async (playlistId, songId) => {
      seen.push({ playlistId, songId });
      return {
        playlistId,
        playlistName: "Target list",
        songId,
        addedCount: 1
      };
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ requestJson }) => {
    const originalResponse = await requestJson(
      "POST",
      "/api/playlists/list%20one/tracks?provider=qq",
      { songId: "  song one  " }
    );
    assert.equal(originalResponse.status, 201);
    assert.deepEqual(originalResponse.body, {
      playlistId: "list one",
      playlistName: "Target list",
      songId: "  song one  ",
      addedCount: 1
    });

    for (const body of [{ songId: 7 }, {}]) {
      const response = await requestJson("POST", "/api/playlists/another/tracks", body);
      assert.equal(response.status, 201);
    }
  });

  assert.equal(settingsCalls, 3);
  assert.deepEqual(seen, [
    { playlistId: "list one", songId: "  song one  " },
    { playlistId: "another", songId: "" },
    { playlistId: "another", songId: "" }
  ]);
});

test("adding tracks keeps QQ at 501 and other failures at 400", timeout, async () => {
  let qqMutationCalls = 0;
  const qqDependencies = createDependencies({
    getSettings: async () => createSettings("qq"),
    addSongToUserPlaylist: async () => {
      qqMutationCalls += 1;
      return unexpectedDependency("addSongToUserPlaylist");
    }
  });

  await withTestRouter([createLibraryRouter(qqDependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      "/api/playlists/qq-list/tracks?provider=netease",
      { songId: "song" }
    );
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, { message: "QQ 音乐收藏到歌单暂未接入。" });
  });
  assert.equal(qqMutationCalls, 0);

  let failureCalls = 0;
  const failingDependencies = createDependencies({
    getSettings: async () => createSettings("netease"),
    addSongToUserPlaylist: async () => {
      failureCalls += 1;
      if (failureCalls === 1) {
        throw new Error("add failure");
      }
      throw "non-error add failure";
    }
  });

  await withTestRouter([createLibraryRouter(failingDependencies)], async ({ requestJson }) => {
    const errorResponse = await requestJson("POST", "/api/playlists/list/tracks", { songId: "song" });
    assert.equal(errorResponse.status, 400);
    assert.deepEqual(errorResponse.body, { message: "add failure" });

    const fallbackResponse = await requestJson("POST", "/api/playlists/list/tracks", { songId: "song" });
    assert.equal(fallbackResponse.status, 400);
    assert.deepEqual(fallbackResponse.body, { message: "添加到歌单失败" });
  });
});

test("removing tracks filters only non-strings and preserves order, duplicates, and empty strings", timeout, async () => {
  const modes: AppSettings["providerMode"][] = ["netease", "aggregate", "demo"];
  let settingsCalls = 0;
  const seen: Array<{ playlistId: string; songIds: string[] }> = [];
  const dependencies = createDependencies({
    getSettings: async () => createSettings(modes[settingsCalls++] ?? "netease"),
    removeSongsFromUserPlaylist: async (playlistId, songIds) => {
      seen.push({ playlistId, songIds });
      return {
        playlistId,
        playlistName: "Target list",
        songIds,
        removedCount: songIds.length
      };
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/playlists/list%20one/tracks?provider=qq", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songIds: ["first", 7, "", "first", null, "last"] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      playlistId: "list one",
      playlistName: "Target list",
      songIds: ["first", "", "first", "last"],
      removedCount: 4
    });

    for (const body of [{ songIds: "not-an-array" }, {}]) {
      const emptyResponse = await request("/api/playlists/another/tracks", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(emptyResponse.status, 200);
    }
  });

  assert.equal(settingsCalls, 3);
  assert.deepEqual(seen, [
    { playlistId: "list one", songIds: ["first", "", "first", "last"] },
    { playlistId: "another", songIds: [] },
    { playlistId: "another", songIds: [] }
  ]);
});

test("removing tracks keeps QQ at 501 and other failures at 400", timeout, async () => {
  let qqMutationCalls = 0;
  const qqDependencies = createDependencies({
    getSettings: async () => createSettings("qq"),
    removeSongsFromUserPlaylist: async () => {
      qqMutationCalls += 1;
      return unexpectedDependency("removeSongsFromUserPlaylist");
    }
  });

  await withTestRouter([createLibraryRouter(qqDependencies)], async ({ request }) => {
    const response = await request("/api/playlists/qq-list/tracks?provider=netease", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ songIds: ["song"] })
    });
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, { message: "QQ 音乐歌单删除暂未接入。" });
  });
  assert.equal(qqMutationCalls, 0);

  let failureCalls = 0;
  const failingDependencies = createDependencies({
    getSettings: async () => createSettings("netease"),
    removeSongsFromUserPlaylist: async () => {
      failureCalls += 1;
      if (failureCalls === 1) {
        throw new Error("remove failure");
      }
      throw "non-error remove failure";
    }
  });

  await withTestRouter([createLibraryRouter(failingDependencies)], async ({ request }) => {
    for (const expectedMessage of ["remove failure", "从歌单移除失败"]) {
      const response = await request("/api/playlists/list/tracks", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ songIds: ["song"] })
      });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: expectedMessage });
    }
  });
});

test("cloud songs returns the full dependency result directly and preserves 401 errors", timeout, async () => {
  const cloudResult = {
    songs: [],
    count: 3,
    size: 4_096,
    maxSize: 8_192
  };
  let cloudCalls = 0;
  const dependencies = createDependencies({
    getCloudSongs: async () => {
      cloudCalls += 1;
      if (cloudCalls === 1) {
        return cloudResult;
      }
      if (cloudCalls === 2) {
        throw new Error("cloud failure");
      }
      throw "non-error cloud failure";
    }
  });

  await withTestRouter([createLibraryRouter(dependencies)], async ({ request }) => {
    const successResponse = await request("/api/cloud/songs");
    assert.equal(successResponse.status, 200);
    assert.deepEqual(successResponse.body, cloudResult);

    const errorResponse = await request("/api/cloud/songs");
    assert.equal(errorResponse.status, 401);
    assert.deepEqual(errorResponse.body, { message: "cloud failure" });

    const fallbackResponse = await request("/api/cloud/songs");
    assert.equal(fallbackResponse.status, 401);
    assert.deepEqual(fallbackResponse.body, { message: "获取云盘音乐失败" });
  });

  assert.equal(cloudCalls, 3);
});

test("library router passes unrelated paths and unsupported methods downstream", timeout, async () => {
  await withTestRouter([createLibraryRouter(createDependencies())], async ({ request }) => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/api/unknown", undefined],
      ["/api/lyrics/song", undefined],
      ["/api/comments/songs/song", undefined],
      ["/api/playlist-transfer/jobs", undefined],
      ["/api/playlists", { method: "POST" }],
      ["/api/playlists/list/songs", { method: "POST" }],
      ["/api/playlists/list/tracks", { method: "PUT" }],
      ["/api/cloud/songs", { method: "POST" }]
    ];

    for (const [path, init] of cases) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
