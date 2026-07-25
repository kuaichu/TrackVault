import assert from "node:assert/strict";
import test from "node:test";
import type { SongComment, SongCommentRepliesPage, SongCommentsPage } from "../types.js";
import {
  createCommentRouter,
  getErrorMessage,
  type CommentRouterDependencies
} from "./comment-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const comment: SongComment = {
  id: "comment-1",
  userId: "user-1",
  nickname: "Listener",
  content: "Comment",
  timeText: "刚刚",
  liked: false,
  likedCount: 3,
  replyCount: 1
};

function commentsPage(songId: string): SongCommentsPage {
  return {
    songId,
    total: 1,
    page: 1,
    limit: 20,
    hasMore: false,
    hotComments: [],
    comments: [comment]
  };
}

function repliesPage(songId: string, parentCommentId: string): SongCommentRepliesPage {
  return {
    songId,
    parentCommentId,
    replies: [comment],
    total: 1,
    hasMore: false
  };
}

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected comment dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<CommentRouterDependencies> = {}
): CommentRouterDependencies {
  return {
    getSongComments: async () => unexpectedDependency("getSongComments"),
    getQqSongComments: async () => unexpectedDependency("getQqSongComments"),
    getSongCommentReplies: async () => unexpectedDependency("getSongCommentReplies"),
    getQqSongCommentReplies: async () => unexpectedDependency("getQqSongCommentReplies"),
    setSongCommentLiked: async () => unexpectedDependency("setSongCommentLiked"),
    setQqSongCommentLiked: async () => unexpectedDependency("setQqSongCommentLiked"),
    replyToSongComment: async () => unexpectedDependency("replyToSongComment"),
    ...overrides
  };
}

test("comment list sends the local song id and numeric pagination to Netease unchanged", timeout, async () => {
  const calls: Array<[string, number | undefined, number | undefined]> = [];
  const result = commentsPage("song-1");
  const dependencies = createDependencies({
    getSongComments: async (songId, page, limit) => {
      calls.push([songId, page, limit]);
      return result;
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/comments/songs/song-1?page=2&limit=30");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);
  });

  assert.deepEqual(calls, [["song-1", 2, 30]]);
});

test("comment list selects QQ exactly, preserves provider id rules, and overwrites response songId", timeout, async () => {
  const calls: Array<[string, number | undefined, number | undefined]> = [];
  const dependencies = createDependencies({
    getQqSongComments: async (songId, page, limit) => {
      calls.push([songId, page, limit]);
      return commentsPage(`provider:${songId}`);
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    const explicit = await request("/api/comments/songs/local-1?source=qqmusic&providerSongId=qq-1&page=3&limit=40");
    assert.equal(explicit.status, 200);
    assert.deepEqual(explicit.body, { ...commentsPage("provider:qq-1"), songId: "local-1" });

    const fallback = await request("/api/comments/songs/local-2?source=qqmusic");
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, { ...commentsPage("provider:local-2"), songId: "local-2" });

    const empty = await request("/api/comments/songs/local-3?source=qqmusic&providerSongId=&page=&limit=");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { ...commentsPage("provider:"), songId: "local-3" });
  });

  assert.deepEqual(calls[0], ["qq-1", 3, 40]);
  assert.equal(calls[1][0], "local-2");
  assert.ok(Number.isNaN(calls[1][1]));
  assert.ok(Number.isNaN(calls[1][2]));
  assert.deepEqual(calls[2], ["", 0, 0]);
});

test("comment list treats non-string source as non-QQ and providerSongId as irrelevant", timeout, async () => {
  const calls: Array<[string, number | undefined, number | undefined]> = [];
  const dependencies = createDependencies({
    getSongComments: async (songId, page, limit) => {
      calls.push([songId, page, limit]);
      return commentsPage(songId);
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    const response = await request(
      "/api/comments/songs/local?source=qqmusic&source=netease&providerSongId=a&providerSongId=b&page=4&limit=5"
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, commentsPage("local"));
  });

  assert.deepEqual(calls, [["local", 4, 5]]);
});

test("comment list errors remain 502 with Error and non-Error messages", timeout, async () => {
  const dependencies = createDependencies({
    getSongComments: async (songId) => {
      if (songId === "error") {
        throw new Error("provider comments failed");
      }
      throw "non-error comments failure";
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    assert.deepEqual(await request("/api/comments/songs/error"), {
      status: 502,
      body: { message: "provider comments failed" }
    });
    assert.deepEqual(await request("/api/comments/songs/value"), {
      status: 502,
      body: { message: "获取评论失败" }
    });
  });
});

test("reply list sends local ids and numeric cursor values to Netease unchanged", timeout, async () => {
  const calls: Array<[string, string, number | undefined, number | undefined]> = [];
  const result = repliesPage("song-1", "parent-1");
  const dependencies = createDependencies({
    getSongCommentReplies: async (songId, commentId, time, limit) => {
      calls.push([songId, commentId, time, limit]);
      return result;
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/comments/songs/song-1/parent-1/replies?time=123&limit=9");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);
  });

  assert.deepEqual(calls, [["song-1", "parent-1", 123, 9]]);
});

test("reply list QQ dispatch uses providerSongId rules and never forwards time or limit", timeout, async () => {
  const calls: Array<[string, string]> = [];
  const dependencies = createDependencies({
    getQqSongCommentReplies: async (songId, commentId) => {
      calls.push([songId, commentId]);
      return repliesPage(songId, commentId);
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    const explicit = await request(
      "/api/comments/songs/local-1/parent-1/replies?source=qqmusic&providerSongId=qq-1&time=123&limit=9"
    );
    assert.deepEqual(explicit, {
      status: 200,
      body: repliesPage("qq-1", "parent-1")
    });

    const fallback = await request("/api/comments/songs/local-2/parent-2/replies?source=qqmusic");
    assert.deepEqual(fallback.body, repliesPage("local-2", "parent-2"));

    const empty = await request(
      "/api/comments/songs/local-3/parent-3/replies?source=qqmusic&providerSongId=&time=&limit="
    );
    assert.deepEqual(empty.body, repliesPage("", "parent-3"));
  });

  assert.deepEqual(calls, [
    ["qq-1", "parent-1"],
    ["local-2", "parent-2"],
    ["", "parent-3"]
  ]);
});

test("reply list errors remain 502 with Error and non-Error messages", timeout, async () => {
  const dependencies = createDependencies({
    getSongCommentReplies: async (songId) => {
      if (songId === "error") {
        throw new Error("provider replies failed");
      }
      throw { reason: "non-error replies failure" };
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ request }) => {
    assert.deepEqual(await request("/api/comments/songs/error/parent/replies"), {
      status: 502,
      body: { message: "provider replies failed" }
    });
    assert.deepEqual(await request("/api/comments/songs/value/parent/replies"), {
      status: 502,
      body: { message: "获取评论回复失败" }
    });
  });
});

test("comment like preserves Boolean conversion and provider argument differences", timeout, async () => {
  const neteaseCalls: Array<[string, string, boolean]> = [];
  const qqCalls: Array<[string, boolean]> = [];
  const dependencies = createDependencies({
    setSongCommentLiked: async (songId, commentId, liked) => {
      neteaseCalls.push([songId, commentId, liked]);
      return { liked };
    },
    setQqSongCommentLiked: async (commentId, liked) => {
      qqCalls.push([commentId, liked]);
      return { liked };
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ requestJson }) => {
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/song-1/comment-1/like", { liked: true }),
      { status: 200, body: { liked: true } }
    );
    await requestJson("POST", "/api/comments/songs/song-1/comment-2/like", { liked: false });
    await requestJson("POST", "/api/comments/songs/song-1/comment-3/like", { liked: 1 });
    await requestJson("POST", "/api/comments/songs/song-1/comment-4/like", { liked: 0 });
    assert.deepEqual(
      await requestJson(
        "POST",
        "/api/comments/songs/song-1/comment-5/like?source=qqmusic&providerSongId=ignored",
        { liked: "false" }
      ),
      { status: 200, body: { liked: true } }
    );
    await requestJson("POST", "/api/comments/songs/song-1/comment-6/like?source=qqmusic", { liked: "" });
    await requestJson("POST", "/api/comments/songs/song-1/comment-7/like", {});
  });

  assert.deepEqual(neteaseCalls, [
    ["song-1", "comment-1", true],
    ["song-1", "comment-2", false],
    ["song-1", "comment-3", true],
    ["song-1", "comment-4", false],
    ["song-1", "comment-7", false]
  ]);
  assert.deepEqual(qqCalls, [
    ["comment-5", true],
    ["comment-6", false]
  ]);
});

test("getErrorMessage preserves message priority, trimming, and code fallbacks", timeout, () => {
  assert.equal(getErrorMessage(new Error(" ordinary "), "fallback"), " ordinary ");
  assert.equal(getErrorMessage(new Error("   "), "fallback"), "fallback");
  assert.equal(
    getErrorMessage({ body: { message: " body message ", msg: "body msg" }, message: "message", msg: "msg" }, "fallback"),
    "body message"
  );
  assert.equal(getErrorMessage({ body: { message: "  ", msg: " body msg " }, message: "message" }, "fallback"), "body msg");
  assert.equal(getErrorMessage({ body: { message: " ", msg: " " }, message: " message ", msg: "msg" }, "fallback"), "message");
  assert.equal(getErrorMessage({ message: " ", msg: " msg " }, "fallback"), "msg");
  assert.equal(getErrorMessage({ body: { code: 403 }, status: 500 }, "fallback"), "fallback：403");
  assert.equal(getErrorMessage({ status: "E_AUTH" }, "fallback"), "fallback：E_AUTH");
  assert.equal(getErrorMessage({ body: { code: 0 } }, "fallback"), "fallback：0");
  assert.equal(getErrorMessage({ body: { code: "" } }, "fallback"), "fallback：");
  assert.equal(getErrorMessage(null, "fallback"), "fallback");
  assert.equal(getErrorMessage("failure", "fallback"), "fallback");
  assert.equal(getErrorMessage(7, "fallback"), "fallback");
  assert.equal(
    getErrorMessage({ body: { message: " ", msg: " " }, message: " ", msg: " " }, "fallback"),
    "fallback"
  );

  const blankErrorWithBody = Object.assign(new Error("  "), {
    body: { message: " nested message " }
  });
  assert.equal(getErrorMessage(blankErrorWithBody, "fallback"), "nested message");
});

test("comment like errors remain 401 and use detailed or liked-specific fallback messages", timeout, async () => {
  const dependencies = createDependencies({
    setSongCommentLiked: async (_songId, _commentId, liked) => {
      if (liked) {
        throw { body: { message: " 详细错误 " } };
      }
      throw null;
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ requestJson }) => {
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/song/comment/like", { liked: true }),
      { status: 401, body: { message: "详细错误" } }
    );
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/song/comment/like", { liked: false }),
      { status: 401, body: { message: "取消点赞失败" } }
    );
  });
});

test("QQ comment reply stays a fixed 501 and never calls the reply provider", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    replyToSongComment: async () => {
      calls += 1;
      return { comment };
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      "/api/comments/songs/song/comment/replies?source=qqmusic",
      { content: "reply" }
    );
    assert.deepEqual(response, {
      status: 501,
      body: { message: "QQ 音乐评论回复暂未接入。" }
    });
  });

  assert.equal(calls, 0);
});

test("non-QQ comment reply passes content unchanged and maps non-string content to empty", timeout, async () => {
  const calls: Array<[string, string, string]> = [];
  const dependencies = createDependencies({
    replyToSongComment: async (songId, commentId, content) => {
      calls.push([songId, commentId, content]);
      return { comment };
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ requestJson }) => {
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/song-1/comment-1/replies", { content: "  reply  " }),
      { status: 200, body: { comment } }
    );
    await requestJson("POST", "/api/comments/songs/song-2/comment-2/replies?source=other", { content: 123 });
  });

  assert.deepEqual(calls, [
    ["song-1", "comment-1", "  reply  "],
    ["song-2", "comment-2", ""]
  ]);
});

test("comment reply errors remain 401 and keep the simple Error check", timeout, async () => {
  const dependencies = createDependencies({
    replyToSongComment: async (songId) => {
      if (songId === "error") {
        throw new Error("reply provider failed");
      }
      throw { body: { message: "must be ignored" } };
    }
  });

  await withTestRouter([createCommentRouter(dependencies)], async ({ requestJson }) => {
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/error/comment/replies", { content: "reply" }),
      { status: 401, body: { message: "reply provider failed" } }
    );
    assert.deepEqual(
      await requestJson("POST", "/api/comments/songs/value/comment/replies", { content: "reply" }),
      { status: 401, body: { message: "回复评论失败" } }
    );
  });
});

test("unknown, excluded, and wrong-method paths continue to downstream handlers", timeout, async () => {
  const router = createCommentRouter(createDependencies());

  await withTestRouter([router], async ({ request }) => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/api/comments/unknown", undefined],
      ["/api/likes/song-1", undefined],
      ["/api/users/user-1", undefined],
      ["/api/artists/artist-1", undefined],
      ["/api/albums/album-1", undefined],
      ["/api/comments/songs/song-1", { method: "POST" }],
      ["/api/comments/songs/song-1/comment-1/like", { method: "GET" }],
      ["/api/comments/songs/song-1/comment-1/replies", { method: "PUT" }]
    ];

    for (const [path, init] of cases) {
      assert.deepEqual(await request(path, init), {
        status: 404,
        body: { message: "test fallback" }
      });
    }
  });
});
