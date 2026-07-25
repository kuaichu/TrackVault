import assert from "node:assert/strict";
import test from "node:test";
import type {
  UserEventsPage,
  UserFollowActionResult,
  UserProfile,
  UserSocialPage
} from "../types.js";
import {
  createUserProfileRouter,
  type UserProfileRouterDependencies
} from "./user-profile-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const user: UserProfile = {
  id: "user-1",
  nickname: "Listener",
  signature: "Hello",
  level: 7,
  listenSongs: 100,
  follows: 3,
  followeds: 4,
  eventCount: 5,
  playlistCount: 6,
  gender: "unknown",
  playlists: []
};

const socialPage: UserSocialPage = {
  userId: "user-1",
  kind: "follows",
  users: [],
  page: 1,
  limit: 30,
  hasMore: false
};

const eventsPage: UserEventsPage = {
  userId: "user-1",
  events: [],
  lasttime: 123,
  hasMore: false
};

const followResult: UserFollowActionResult = {
  userId: "user-1",
  followed: true
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected user profile dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<UserProfileRouterDependencies> = {}
): UserProfileRouterDependencies {
  return {
    getUserProfile: async () => unexpectedDependency("getUserProfile"),
    getUserSocialList: async () => unexpectedDependency("getUserSocialList"),
    getUserEvents: async () => unexpectedDependency("getUserEvents"),
    getUserMutualFollow: async () => unexpectedDependency("getUserMutualFollow"),
    setUserFollowed: async () => unexpectedDependency("setUserFollowed"),
    ...overrides
  };
}

test("user profile preserves the decoded id and wraps the successful result", timeout, async () => {
  const ids: string[] = [];
  const dependencies = createDependencies({
    getUserProfile: async (userId) => {
      ids.push(userId);
      return user;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/users/%20user-1%20");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { user });
  });

  assert.deepEqual(ids, [" user-1 "]);
});

test("user profile keeps Error and non-Error failures at 502", timeout, async () => {
  const dependencies = createDependencies({
    getUserProfile: async (userId) => {
      throw userId === "known" ? new Error("profile failed") : "profile failed";
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/users/known");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "profile failed" });

    const fallback = await request("/api/users/unknown");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取用户信息失败" });
  });
});

test("social selects followeds exactly and falls back every other kind to follows", timeout, async () => {
  const calls: Array<[string, string, number, number]> = [];
  const dependencies = createDependencies({
    getUserSocialList: async (userId, kind, page, limit) => {
      calls.push([userId, kind, page, limit]);
      return socialPage;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    for (const query of [
      "kind=followeds",
      "kind=follows",
      "kind=invalid",
      "",
      "kind=",
      "kind=followeds&kind=follows"
    ]) {
      const suffix = query ? `?${query}&page=2&limit=30` : "?page=2&limit=30";
      const response = await request(`/api/users/%20user-1%20/social${suffix}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, socialPage);
    }
  });

  assert.deepEqual(calls, [
    [" user-1 ", "followeds", 2, 30],
    [" user-1 ", "follows", 2, 30],
    [" user-1 ", "follows", 2, 30],
    [" user-1 ", "follows", 2, 30],
    [" user-1 ", "follows", 2, 30],
    [" user-1 ", "follows", 2, 30]
  ]);
});

test("social passes raw JavaScript Number conversions to the provider", timeout, async () => {
  const calls: Array<[number, number]> = [];
  const dependencies = createDependencies({
    getUserSocialList: async (_userId, _kind, page, limit) => {
      calls.push([page, limit]);
      return socialPage;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    for (const query of ["page=2.5&limit=40", "", "page=&limit=", "page=nope&limit=invalid"]) {
      const response = await request(`/api/users/user-1/social${query ? `?${query}` : ""}`);
      assert.equal(response.status, 200);
    }
  });

  assert.deepEqual(calls[0], [2.5, 40]);
  assert.ok(Number.isNaN(calls[1][0]));
  assert.ok(Number.isNaN(calls[1][1]));
  assert.deepEqual(calls[2], [0, 0]);
  assert.ok(Number.isNaN(calls[3][0]));
  assert.ok(Number.isNaN(calls[3][1]));
});

test("social keeps Error and non-Error failures at 502", timeout, async () => {
  const dependencies = createDependencies({
    getUserSocialList: async (userId) => {
      throw userId === "known" ? new Error("social failed") : "social failed";
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/users/known/social");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "social failed" });

    const fallback = await request("/api/users/unknown/social");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取好友列表失败" });
  });
});

test("events preserves id, returns the provider result directly, and passes Number conversions", timeout, async () => {
  const calls: Array<[string, number, number]> = [];
  const dependencies = createDependencies({
    getUserEvents: async (userId, lasttime, limit) => {
      calls.push([userId, lasttime, limit]);
      return eventsPage;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    for (const query of ["lasttime=123.5&limit=10", "", "lasttime=&limit=", "lasttime=nope&limit=invalid"]) {
      const response = await request(`/api/users/%20user-1%20/events${query ? `?${query}` : ""}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, eventsPage);
    }
  });

  assert.deepEqual(calls[0], [" user-1 ", 123.5, 10]);
  assert.equal(calls[1][0], " user-1 ");
  assert.ok(Number.isNaN(calls[1][1]));
  assert.ok(Number.isNaN(calls[1][2]));
  assert.deepEqual(calls[2], [" user-1 ", 0, 0]);
  assert.equal(calls[3][0], " user-1 ");
  assert.ok(Number.isNaN(calls[3][1]));
  assert.ok(Number.isNaN(calls[3][2]));
});

test("events keeps Error and non-Error failures at 502", timeout, async () => {
  const dependencies = createDependencies({
    getUserEvents: async (userId) => {
      throw userId === "known" ? new Error("events failed") : "events failed";
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/users/known/events");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "events failed" });

    const fallback = await request("/api/users/unknown/events");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取用户动态失败" });
  });
});

test("mutual follow preserves id and returns the provider result directly", timeout, async () => {
  const ids: string[] = [];
  const result = { userId: "user-1", mutual: true };
  const dependencies = createDependencies({
    getUserMutualFollow: async (userId) => {
      ids.push(userId);
      return result;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/users/%20user-1%20/mutual-follow");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);
  });

  assert.deepEqual(ids, [" user-1 "]);
});

test("mutual follow keeps Error and non-Error failures at 401", timeout, async () => {
  const dependencies = createDependencies({
    getUserMutualFollow: async (userId) => {
      throw userId === "known" ? new Error("mutual failed") : "mutual failed";
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/users/known/mutual-follow");
    assert.equal(known.status, 401);
    assert.deepEqual(known.body, { message: "mutual failed" });

    const fallback = await request("/api/users/unknown/mutual-follow");
    assert.equal(fallback.status, 401);
    assert.deepEqual(fallback.body, { message: "获取互关状态失败" });
  });
});

test("follow preserves id, uses Boolean conversion, and returns the provider result directly", timeout, async () => {
  const calls: Array<[string, boolean]> = [];
  const dependencies = createDependencies({
    setUserFollowed: async (userId, followed) => {
      calls.push([userId, followed]);
      return followResult;
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ requestJson }) => {
    for (const followed of [true, false, 1, 0, "false", ""]) {
      const response = await requestJson("POST", "/api/users/%20user-1%20/follow", { followed });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, followResult);
    }

    const missing = await requestJson("POST", "/api/users/%20user-1%20/follow", {});
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, followResult);
  });

  assert.deepEqual(calls, [
    [" user-1 ", true],
    [" user-1 ", false],
    [" user-1 ", true],
    [" user-1 ", false],
    [" user-1 ", true],
    [" user-1 ", false],
    [" user-1 ", false]
  ]);
});

test("follow keeps Error and non-Error failures at 401", timeout, async () => {
  const dependencies = createDependencies({
    setUserFollowed: async (userId) => {
      throw userId === "known" ? new Error("follow failed") : "follow failed";
    }
  });

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ requestJson }) => {
    const known = await requestJson("POST", "/api/users/known/follow", { followed: true });
    assert.equal(known.status, 401);
    assert.deepEqual(known.body, { message: "follow failed" });

    const fallback = await requestJson("POST", "/api/users/unknown/follow", { followed: false });
    assert.equal(fallback.status, 401);
    assert.deepEqual(fallback.body, { message: "关注操作失败" });
  });
});

test("unknown, deeper, artist, album, and wrong-method paths fall through", timeout, async () => {
  const dependencies = createDependencies();

  await withTestRouter([createUserProfileRouter(dependencies)], async ({ request }) => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/users/user-1/unknown", undefined],
      ["/api/users/user-1/social/deeper", undefined],
      ["/api/artists/artist-1", undefined],
      ["/api/albums/album-1", undefined],
      ["/api/users/user-1", { method: "POST" }],
      ["/api/users/user-1/follow", undefined]
    ];

    for (const [path, init] of requests) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
