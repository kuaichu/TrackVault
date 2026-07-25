import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RequestHandler, Response as ExpressResponse } from "express";
import { MediaAccessError } from "../media-security.js";
import { getClientSessionId } from "../request-context.js";
import type { DownloadTask, Song } from "../types.js";
import { createDownloadTaskRouter, type DownloadTaskRouterDependencies } from "./download-task-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const song: Song = {
  id: "qq-song-1",
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

const task: DownloadTask = {
  id: "task-1",
  songId: song.id,
  title: song.title,
  artist: song.artist,
  quality: "无损",
  requestedLevel: "lossless",
  retryCount: 0,
  retryLimit: 2,
  progress: 100,
  status: "done",
  metadataStatus: "skipped-size-limit",
  warning: "文件过大，已跳过标签写入",
  memoryLimitBytes: 1024,
  createdAt: "2026-07-26T00:00:00.000Z"
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected download task dependency call: ${name}`);
}

function createDependencies(overrides: Partial<DownloadTaskRouterDependencies> = {}): DownloadTaskRouterDependencies {
  return {
    getAllTasks: async () => unexpectedDependency("getAllTasks"),
    getTaskFileForDownload: async () => unexpectedDependency("getTaskFileForDownload"),
    assertDownloadAccess: async () => unexpectedDependency("assertDownloadAccess"),
    createTask: async () => unexpectedDependency("createTask"),
    isMediaAccessError: (error): error is MediaAccessError => error instanceof MediaAccessError,
    ...overrides
  };
}

test("task list returns the unwrapped dependency result once without owner arguments", timeout, async () => {
  const tasks = [task];
  let calls = 0;
  let argumentCount = -1;
  const dependencies = createDependencies({
    getAllTasks: async (...args: never[]) => {
      calls += 1;
      argumentCount = args.length;
      return tasks;
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/tasks?owner=someone-else&userKey=forged");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, tasks);
    assert.ok(Array.isArray(response.body));
  });

  assert.equal(calls, 1);
  assert.equal(argumentCount, 0);
});

test("task list preserves an empty array and the request SID context", timeout, async () => {
  const seenSessionIds: string[] = [];
  const dependencies = createDependencies({
    getAllTasks: async () => {
      seenSessionIds.push(getClientSessionId());
      return [];
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/tasks?sid=query-sid", {
      headers: { "x-client-session-id": "header-sid" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);
  });

  assert.deepEqual(seenSessionIds, ["header-sid"]);
});

test("task file passes the task id through and preserves the private 404", timeout, async () => {
  const taskIds: string[] = [];
  const dependencies = createDependencies({
    getTaskFileForDownload: async (taskId) => {
      taskIds.push(taskId);
      return null;
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/tasks/unknown%20task/file");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "下载文件不存在或无权访问" });
  });

  assert.deepEqual(taskIds, ["unknown task"]);
});

test("task file streams bytes with Express Content-Disposition without exposing its path", timeout, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "trackvault-download-router-"));
  const filePath = path.join(directory, "private-source.bin");
  const fileBytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  const filename = "测试文件.mp3";

  try {
    await writeFile(filePath, fileBytes);
    const dependencies = createDependencies({
      getTaskFileForDownload: async () => ({ task, filePath, filename })
    });
    await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ requestRaw }) => {
      const response = await requestRaw("/api/tasks/task-1/file");
      const contentDisposition = response.headers.get("content-disposition") ?? "";
      assert.equal(response.status, 200);
      assert.match(contentDisposition, /^attachment;/);
      assert.ok(contentDisposition.includes(encodeURIComponent(filename)));
      assert.ok(!contentDisposition.includes(filePath));
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fileBytes);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task file maps a pre-header filesystem failure to the existing 500 response", timeout, async () => {
  const missingPath = path.join(tmpdir(), `trackvault-missing-${process.pid}-${Date.now()}.mp3`);
  const dependencies = createDependencies({
    getTaskFileForDownload: async () => ({ task, filePath: missingPath, filename: "missing.mp3" })
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/tasks/task-1/file");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { message: "读取下载文件失败" });
  });
});

test("task file does not append JSON after a download failure with sent headers", timeout, async () => {
  const forceLateFailure: RequestHandler = (_request, response, next) => {
    response.download = ((_filePath: string, _filename?: string, callback?: (error: Error) => void) => {
      response.write("partial-file");
      callback?.(new Error("late stream failure"));
      response.end();
      return response;
    }) as ExpressResponse["download"];
    next();
  };
  const dependencies = createDependencies({
    getTaskFileForDownload: async () => ({ task, filePath: "unused", filename: "unused.mp3" })
  });

  await withTestRouter([forceLateFailure, createDownloadTaskRouter(dependencies)], async ({ requestRaw }) => {
    const response = await requestRaw("/api/tasks/task-1/file");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "partial-file");
  });
});

test("download validation rejects each missing required field before dependencies run", timeout, async () => {
  let accessCalls = 0;
  let createCalls = 0;
  const dependencies = createDependencies({
    assertDownloadAccess: async () => { accessCalls += 1; },
    createTask: async () => { createCalls += 1; return task; }
  });
  const invalidRequests = [
    { body: {}, message: "缺少歌曲信息" },
    { body: { song: { ...song, id: "" }, level: "lossless" }, message: "缺少歌曲信息" },
    { body: { song: { ...song, title: "" }, level: "lossless" }, message: "缺少歌曲信息" },
    { body: { song: { ...song, artist: "" }, level: "lossless" }, message: "缺少歌曲信息" },
    { body: { song }, message: "缺少下载音质" }
  ];

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ requestJson }) => {
    for (const item of invalidRequests) {
      const response = await requestJson("POST", "/api/download", item.body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: item.message });
    }
  });

  assert.equal(accessCalls, 0);
  assert.equal(createCalls, 0);
});

test("download preserves the full QQ song, cookie, call order and task fields", timeout, async () => {
  const calls: string[] = [];
  let accessSong: Song | undefined;
  let createdSong: Song | undefined;
  const dependencies = createDependencies({
    assertDownloadAccess: async (receivedSong, level, cookie) => {
      calls.push("assertDownloadAccess");
      accessSong = receivedSong;
      assert.equal(level, "lossless");
      assert.equal(cookie, "personal-cookie");
    },
    createTask: async (receivedSong, level) => {
      calls.push("createTask");
      createdSong = receivedSong;
      assert.equal(level, "lossless");
      return task;
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      "/api/download",
      { song, level: "lossless" },
      { "x-user-cookie": "personal-cookie" }
    );
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, task);
  });

  assert.deepEqual(calls, ["assertDownloadAccess", "createTask"]);
  assert.deepEqual(accessSong, song);
  assert.strictEqual(createdSong, accessSong);
  assert.equal(createdSong?.source, "qqmusic");
});

test("download access failures preserve MediaAccessError statuses and never create tasks", timeout, async () => {
  let createCalls = 0;
  let classifierCalls = 0;
  let status = 401;
  const dependencies = createDependencies({
    assertDownloadAccess: async () => { throw new MediaAccessError(status, `denied-${status}`); },
    createTask: async () => { createCalls += 1; return task; },
    isMediaAccessError: (error): error is MediaAccessError => {
      classifierCalls += 1;
      return error instanceof MediaAccessError;
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ requestJson }) => {
    for (const expectedStatus of [401, 403, 418]) {
      status = expectedStatus;
      const response = await requestJson("POST", "/api/download", { song, level: "lossless" });
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(response.body, { message: `denied-${expectedStatus}` });
    }
  });

  assert.equal(createCalls, 0);
  assert.equal(classifierCalls, 3);
});

test("download maps access and createTask failures to the existing 502 messages", timeout, async () => {
  let accessFailure: unknown = new Error("access failed");
  let createFailure: unknown;
  const dependencies = createDependencies({
    assertDownloadAccess: async () => {
      if (accessFailure !== undefined) throw accessFailure;
    },
    createTask: async () => {
      if (createFailure !== undefined) throw createFailure;
      return task;
    }
  });

  await withTestRouter([createDownloadTaskRouter(dependencies)], async ({ requestJson }) => {
    const first = await requestJson("POST", "/api/download", { song, level: "lossless" });
    assert.equal(first.status, 502);
    assert.deepEqual(first.body, { message: "access failed" });

    accessFailure = undefined;
    createFailure = new Error("queue failed");
    const second = await requestJson("POST", "/api/download", { song, level: "lossless" });
    assert.equal(second.status, 502);
    assert.deepEqual(second.body, { message: "queue failed" });

    createFailure = "unknown failure";
    const third = await requestJson("POST", "/api/download", { song, level: "lossless" });
    assert.equal(third.status, 502);
    assert.deepEqual(third.body, { message: "加入下载队列失败" });
  });
});

test("download task router passes unrelated and neighboring routes to the fallback", timeout, async () => {
  await withTestRouter([createDownloadTaskRouter(createDependencies())], async ({ request }) => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/api/unknown", undefined],
      ["/api/download/direct", undefined],
      ["/api/download/proxy", undefined],
      ["/api/stream", undefined],
      ["/api/player-state", undefined],
      ["/api/player-state", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }],
      ["/api/download", undefined],
      ["/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ["/api/tasks/task-1/file", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]
    ];
    for (const [route, init] of cases) {
      const response = await request(route, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
