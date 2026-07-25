import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedPlayerState, Song } from "../types.js";
import { createUserStateRouter, type UserStateRouterDependencies } from "./user-state-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };
const scopeHeader = { "x-data-scope-id": "scope-a" };

const song: Song = {
  id: "song-1",
  providerSongId: "provider-song-1",
  title: "Track",
  artist: "Artist",
  primaryArtistId: "artist-1",
  artists: [{ id: "artist-1", name: "Artist" }],
  album: "Album",
  albumId: "album-1",
  mediaId: "media-1",
  coverUrl: "https://example.invalid/cover.jpg",
  duration: "03:00",
  quality: "无损",
  availableQualities: [{ level: "lossless", label: "无损" }],
  availability: {
    playback: { status: "available", locked: false, label: "可播放", reason: "" },
    download: { status: "vip", locked: true, label: "VIP", reason: "需要权限" }
  },
  source: "qqmusic"
};

const playerState: PersistedPlayerState = {
  currentTrack: song,
  playQueue: [song],
  playbackSeconds: 42,
  volume: 68,
  playbackMode: "shuffle"
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected user state dependency call: ${name}`);
}

function createDependencies(overrides: Partial<UserStateRouterDependencies> = {}): UserStateRouterDependencies {
  return {
    getDataScopeId: async () => unexpectedDependency("getDataScopeId"),
    getSearchHistory: async () => unexpectedDependency("getSearchHistory"),
    saveSearchHistory: async () => unexpectedDependency("saveSearchHistory"),
    removeSearchHistory: async () => unexpectedDependency("removeSearchHistory"),
    getPlayHistory: async () => unexpectedDependency("getPlayHistory"),
    savePlayHistory: async () => unexpectedDependency("savePlayHistory"),
    getPlayerState: async () => unexpectedDependency("getPlayerState"),
    savePlayerState: async () => unexpectedDependency("savePlayerState"),
    ...overrides
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("every endpoint rejects missing, blank, and mismatched scopes before store calls", timeout, async () => {
  let scopeCalls = 0;
  const dependencies = createDependencies({
    getDataScopeId: async () => {
      scopeCalls += 1;
      return "scope-a";
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const endpointCases: Array<[string, RequestInit | undefined]> = [
      ["/api/history/search", undefined],
      ["/api/history/search", { method: "PUT", body: JSON.stringify({ items: ["query"] }) }],
      ["/api/history/search?keyword=query", { method: "DELETE" }],
      ["/api/history/play", undefined],
      ["/api/history/play", { method: "PUT", body: JSON.stringify({ items: [song] }) }],
      ["/api/player-state", undefined],
      ["/api/player-state", { method: "PUT", body: JSON.stringify(playerState) }]
    ];
    const invalidHeaders: Array<Record<string, string> | undefined> = [
      undefined,
      { "x-data-scope-id": "   " },
      { "x-data-scope-id": "scope-b" }
    ];

    for (const headers of invalidHeaders) {
      for (const [path, init] of endpointCases) {
        const response = await request(path, {
          ...init,
          headers: {
            ...(init?.body ? { "content-type": "application/json" } : {}),
            ...headers
          }
        });
        assert.equal(response.status, 409);
        assert.deepEqual(response.body, { message: "账号数据作用域已变化，请重试。" });
      }
    }
  });

  assert.equal(scopeCalls, 21);
});

test("search history GET trims the header, resolves scope once, and wraps items", timeout, async () => {
  let scopeCalls = 0;
  const seenScopes: string[] = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => {
      scopeCalls += 1;
      return "scope-a";
    },
    getSearchHistory: async (scope) => {
      seenScopes.push(scope);
      return ["first", "second"];
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/history/search", {
      headers: { "x-data-scope-id": "  scope-a  " }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items: ["first", "second"] });
  });

  assert.equal(scopeCalls, 1);
  assert.deepEqual(seenScopes, ["scope-a"]);
});

test("search history PUT forwards arrays unchanged and defaults other inputs to an empty array", timeout, async () => {
  const seen: Array<{ items: unknown[]; scope: string }> = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    saveSearchHistory: async (items, scope) => {
      seen.push({ items, scope });
      return items.map(String);
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ requestJson }) => {
    const input = ["  spaced  ", 7];
    const arrayResponse = await requestJson("PUT", "/api/history/search", { items: input }, scopeHeader);
    assert.equal(arrayResponse.status, 200);
    assert.deepEqual(arrayResponse.body, { items: ["  spaced  ", "7"] });

    for (const body of [{ items: "not-an-array" }, {}, { items: null }]) {
      const response = await requestJson("PUT", "/api/history/search", body, scopeHeader);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { items: [] });
    }
  });

  assert.deepEqual(seen, [
    { items: ["  spaced  ", 7], scope: "scope-a" },
    { items: [], scope: "scope-a" },
    { items: [], scope: "scope-a" },
    { items: [], scope: "scope-a" }
  ]);
});

test("search history DELETE forwards a string keyword and defaults non-strings to empty", timeout, async () => {
  const seen: Array<{ keyword: string; scope: string }> = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    removeSearchHistory: async (keyword, scope) => {
      seen.push({ keyword, scope });
      return keyword ? [keyword] : [];
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const keywordResponse = await request("/api/history/search?keyword=hello%20world", {
      method: "DELETE",
      headers: scopeHeader
    });
    assert.equal(keywordResponse.status, 200);
    assert.deepEqual(keywordResponse.body, { items: ["hello world"] });

    for (const path of ["/api/history/search", "/api/history/search?keyword=one&keyword=two"]) {
      const response = await request(path, { method: "DELETE", headers: scopeHeader });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { items: [] });
    }
  });

  assert.deepEqual(seen, [
    { keyword: "hello world", scope: "scope-a" },
    { keyword: "", scope: "scope-a" },
    { keyword: "", scope: "scope-a" }
  ]);
});

test("play history GET passes the server scope and wraps items", timeout, async () => {
  const seenScopes: string[] = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    getPlayHistory: async (scope) => {
      seenScopes.push(scope);
      return [song];
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/history/play", { headers: scopeHeader });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { items: [song] });
  });

  assert.deepEqual(seenScopes, ["scope-a"]);
});

test("play history PUT preserves complete songs and defaults non-arrays to empty", timeout, async () => {
  const seen: Array<{ items: Song[]; scope: string }> = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    savePlayHistory: async (items, scope) => {
      seen.push({ items, scope });
      return items;
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ requestJson }) => {
    const songResponse = await requestJson("PUT", "/api/history/play", { items: [song] }, scopeHeader);
    assert.equal(songResponse.status, 200);
    assert.deepEqual(songResponse.body, { items: [song] });

    for (const body of [{ items: song }, {}, { items: null }]) {
      const response = await requestJson("PUT", "/api/history/play", body, scopeHeader);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { items: [] });
    }
  });

  assert.deepEqual(seen, [
    { items: [song], scope: "scope-a" },
    { items: [], scope: "scope-a" },
    { items: [], scope: "scope-a" },
    { items: [], scope: "scope-a" }
  ]);
});

test("player state GET returns the dependency result without a wrapper", timeout, async () => {
  const seenScopes: string[] = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    getPlayerState: async (scope) => {
      seenScopes.push(scope);
      return playerState;
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/player-state", { headers: scopeHeader });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, playerState);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body, "state"), false);
  });

  assert.deepEqual(seenScopes, ["scope-a"]);
});

test("player state PUT forwards the body and returns the normalized dependency result directly", timeout, async () => {
  const normalizedState: PersistedPlayerState = {
    ...playerState,
    playbackSeconds: 0,
    volume: 100,
    playbackMode: "sequential"
  };
  const seen: Array<{ state: PersistedPlayerState; scope: string }> = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => "scope-a",
    savePlayerState: async (state, scope) => {
      seen.push({ state, scope });
      return normalizedState;
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("PUT", "/api/player-state", playerState, scopeHeader);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, normalizedState);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body, "state"), false);
  });

  assert.deepEqual(seen, [{ state: playerState, scope: "scope-a" }]);
});

test("account scope changes reject stale headers without reading the new account", timeout, async () => {
  let currentScope = "scope-a";
  let scopeCalls = 0;
  const readScopes: string[] = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => {
      scopeCalls += 1;
      return currentScope;
    },
    getSearchHistory: async (scope) => {
      readScopes.push(scope);
      return [`item-for-${scope}`];
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ request }) => {
    const first = await request("/api/history/search", { headers: { "x-data-scope-id": "scope-a" } });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { items: ["item-for-scope-a"] });

    currentScope = "scope-b";
    const stale = await request("/api/history/search", { headers: { "x-data-scope-id": "scope-a" } });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { message: "账号数据作用域已变化，请重试。" });

    const refreshed = await request("/api/history/search", { headers: { "x-data-scope-id": "scope-b" } });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body, { items: ["item-for-scope-b"] });
  });

  assert.equal(scopeCalls, 3);
  assert.deepEqual(readScopes, ["scope-a", "scope-b"]);
});

test("an in-flight request keeps its validated scope while a stale follow-up cannot write the new account", timeout, async () => {
  let currentScope = "scope-a";
  const firstSaveStarted = createDeferred();
  const releaseFirstSave = createDeferred();
  const savedScopes: string[] = [];
  const dependencies = createDependencies({
    getDataScopeId: async () => currentScope,
    savePlayerState: async (state, scope) => {
      savedScopes.push(scope);
      if (savedScopes.length === 1) {
        firstSaveStarted.resolve();
        await releaseFirstSave.promise;
      }
      return state;
    }
  });

  await withTestRouter([createUserStateRouter(dependencies)], async ({ requestJson }) => {
    const firstRequest = requestJson("PUT", "/api/player-state", playerState, {
      "x-data-scope-id": "scope-a"
    });
    await firstSaveStarted.promise;

    currentScope = "scope-b";
    const staleRequest = await requestJson("PUT", "/api/player-state", playerState, {
      "x-data-scope-id": "scope-a"
    });
    assert.equal(staleRequest.status, 409);
    assert.deepEqual(staleRequest.body, { message: "账号数据作用域已变化，请重试。" });

    releaseFirstSave.resolve();
    const firstResponse = await firstRequest;
    assert.equal(firstResponse.status, 200);

    const refreshedRequest = await requestJson("PUT", "/api/player-state", playerState, {
      "x-data-scope-id": "scope-b"
    });
    assert.equal(refreshedRequest.status, 200);
  });

  assert.deepEqual(savedScopes, ["scope-a", "scope-b"]);
});

test("user state router passes unrelated paths and unsupported methods to downstream routes", timeout, async () => {
  await withTestRouter([createUserStateRouter(createDependencies())], async ({ request }) => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/api/unknown", undefined],
      ["/api/account", undefined],
      ["/api/tasks", undefined],
      ["/api/history/other", undefined],
      ["/api/history/search", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["/api/history/play", { method: "DELETE" }],
      ["/api/player-state", { method: "DELETE" }]
    ];

    for (const [path, init] of cases) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
