import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { PlaylistTransferRunJob } from "../playlist-transfer/playlist-transfer-job.js";
import type { CreatePlaylistTransferDeps, CreatePlaylistTransferInput } from "../playlist-transfer/service.js";
import type { PlaylistTransferJob } from "../playlist-transfer/types.js";
import {
  createPlaylistTransferJobRouter,
  type PlaylistTransferJobRouterDependencies
} from "./playlist-transfer-job-router.js";
import { withTestRouter } from "./router-test-http.js";
import { createBackgroundJobOwnerResolver } from "../background-job-owner.js";
import { getRequiredClientSessionId } from "../request-context.js";

const timeout = { timeout: 5_000 };

const neteaseJob: PlaylistTransferJob = {
  id: "job-netease",
  ownerKey: "server-owner",
  sourceProvider: "qq",
  targetProvider: "netease",
  playlistName: "源歌单",
  tracks: [],
  summary: {
    total: 7,
    matched: 5,
    manualReview: 0,
    notFound: 2,
    unavailable: 0,
    duplicate: 0,
    skipped: 0
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

const qqJob: PlaylistTransferJob = {
  ...neteaseJob,
  id: "job-qq",
  targetProvider: "qq"
};

const { ownerKey: _neteaseOwnerKey, ...publicNeteaseJob } = neteaseJob;

const runJob: PlaylistTransferRunJob = {
  id: "run-1",
  status: "queued",
  input: {
    sourceProvider: "qq",
    targetProvider: "netease",
    playlistId: "source-list"
  },
  progress: {
    phase: "queued",
    processed: 0,
    total: 0,
    matched: 0,
    manualReview: 0,
    notFound: 0,
    unavailable: 0,
    duplicate: 0,
    skipped: 0
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected playlist transfer dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<PlaylistTransferJobRouterDependencies> = {}
): PlaylistTransferJobRouterDependencies {
  return {
    getCurrentUserKey: async () => unexpectedDependency("getCurrentUserKey"),
    listPlaylistTransferJobs: async () => unexpectedDependency("listPlaylistTransferJobs"),
    createPlaylistTransferJob: async () => unexpectedDependency("createPlaylistTransferJob"),
    startPlaylistTransferRunJob: () => unexpectedDependency("startPlaylistTransferRunJob"),
    loadSourceTracks: async () => unexpectedDependency("loadSourceTracks"),
    searchTargetTracks: async () => unexpectedDependency("searchTargetTracks"),
    checkAvailability: async () => unexpectedDependency("checkAvailability"),
    saveJob: async () => unexpectedDependency("saveJob"),
    getPlaylistTransferRunJob: () => unexpectedDependency("getPlaylistTransferRunJob"),
    getPlaylistTransferJob: async () => unexpectedDependency("getPlaylistTransferJob"),
    formatTransferExport: () => unexpectedDependency("formatTransferExport"),
    getNeteaseImportTrackIds: () => unexpectedDependency("getNeteaseImportTrackIds"),
    addNeteaseTrackIdsToExistingPlaylist: async () => unexpectedDependency("addNeteaseTrackIdsToExistingPlaylist"),
    createNeteasePlaylistFromTrackIds: async () => unexpectedDependency("createNeteasePlaylistFromTrackIds"),
    getQqImportTrackMids: () => unexpectedDependency("getQqImportTrackMids"),
    createQqPlaylistFromTrackMids: async () => unexpectedDependency("createQqPlaylistFromTrackMids"),
    ...overrides
  };
}

type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{
      handle: (request: Request, response: Response, next: NextFunction) => unknown;
    }>;
  };
};

function getRouteHandler(router: Router, method: string, path: string) {
  const { stack } = router as unknown as { stack: RouteLayer[] };
  const layer = stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer?.route, `Expected ${method.toUpperCase()} ${path} route`);
  return layer.route.stack[0].handle;
}

test("job list uses the current owner and returns only the jobs envelope", timeout, async () => {
  const owners: string[] = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    listPlaylistTransferJobs: async (ownerKey) => {
      owners.push(ownerKey);
      return [neteaseJob];
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/playlist-transfer/jobs?ownerKey=attacker&dataScopeId=account%3Anetease%3Aattacker", {
      headers: {
        "x-owner-key": "header-attacker",
        "x-data-scope-id": "account:qqmusic:attacker"
      }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { jobs: [publicNeteaseJob] });
  });

  assert.deepEqual(owners, ["server-owner"]);
});

test("sync creation overwrites owner, preserves payload, and returns a bare job with 201", timeout, async () => {
  const inputs: CreatePlaylistTransferInput[] = [];
  const dependencyArguments: CreatePlaylistTransferDeps[] = [];
  const loadSourceTracks: NonNullable<CreatePlaylistTransferDeps["loadSourceTracks"]> = async () => [];
  const searchTargetTracks: CreatePlaylistTransferDeps["searchTargetTracks"] = async () => [];
  const checkAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]> = async () => null;
  const saveJob: CreatePlaylistTransferDeps["saveJob"] = async (job) => job;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    createPlaylistTransferJob: async (input, createDependencies) => {
      inputs.push(input);
      dependencyArguments.push(createDependencies);
      return neteaseJob;
    },
    loadSourceTracks,
    searchTargetTracks,
    checkAvailability,
    saveJob
  });
  const payload = {
    sourceProvider: "qq",
    targetProvider: "netease",
    playlistName: "  原样名称  ",
    playlistId: "source-list",
    sourceTrackIds: ["source-1"],
    text: "raw text",
    checkAvailability: true,
    ownerKey: "attacker",
    dataScopeId: "account:netease:attacker"
  };

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs", payload);
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, publicNeteaseJob);
    assert.equal(Object.prototype.hasOwnProperty.call(response.body, "job"), false);
  });

  assert.deepEqual(inputs, [{ ...payload, ownerKey: "server-owner" }]);
  assert.equal(dependencyArguments.length, 1);
  assert.deepEqual(dependencyArguments[0], {
    loadSourceTracks,
    searchTargetTracks,
    checkAvailability,
    saveJob
  });
  assert.equal(dependencyArguments[0].loadSourceTracks, loadSourceTracks);
  assert.equal(dependencyArguments[0].searchTargetTracks, searchTargetTracks);
  assert.equal(dependencyArguments[0].checkAvailability, checkAvailability);
  assert.equal(dependencyArguments[0].saveJob, saveJob);
});

test("sync creation keeps Error and non-Error failures at 400", timeout, async () => {
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    createPlaylistTransferJob: async (input) => {
      throw input.playlistName === "error" ? new Error("creation failed") : "creation failed";
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const known = await requestJson("POST", "/api/playlist-transfer/jobs", {
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistName: "error"
    });
    assert.equal(known.status, 400);
    assert.deepEqual(known.body, { message: "creation failed" });

    const fallback = await requestJson("POST", "/api/playlist-transfer/jobs", {
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistName: "non-error"
    });
    assert.equal(fallback.status, 400);
    assert.deepEqual(fallback.body, { message: "创建歌单互转任务失败" });
  });
});

test("sync creation reports current-owner failures as a clear 4xx", timeout, async () => {
  let createCalls = 0;
  const router = createPlaylistTransferJobRouter(createDependencies({
    getCurrentUserKey: async () => {
      throw new Error("owner lookup failed");
    },
    createPlaylistTransferJob: async () => {
      createCalls += 1;
      return neteaseJob;
    }
  }));
  await withTestRouter([router], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs", {
      sourceProvider: "qq",
      targetProvider: "netease"
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "无法确认后台任务所属身份。" });
  });
  assert.equal(createCalls, 0);
});

test("protected transfer endpoints reject missing, default, and malformed client SIDs", timeout, async () => {
  const getCurrentUserKey = createBackgroundJobOwnerResolver({
    getClientSessionId: getRequiredClientSessionId,
    readStoredSession: async () => ({ loggedIn: false, profile: null }),
    getQqMusicCookie: async () => ""
  });
  const router = createPlaylistTransferJobRouter(createDependencies({
    getCurrentUserKey,
    listPlaylistTransferJobs: async () => []
  }));

  await withTestRouter([router], async ({ request }) => {
    const responses = await Promise.all([
      request("/api/playlist-transfer/jobs"),
      request("/api/playlist-transfer/jobs", { headers: { "x-client-session-id": "default" } }),
      request("/api/playlist-transfer/jobs", { headers: { "x-client-session-id": "bad!sid" } })
    ]);
    for (const response of responses) {
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: "缺少或无效的客户端会话标识。" });
    }
  });
});

test("progress start overwrites owner and returns the synchronously created job with 202", timeout, async () => {
  const inputs: CreatePlaylistTransferInput[] = [];
  const dependencyArguments: CreatePlaylistTransferDeps[] = [];
  const loadSourceTracks: NonNullable<CreatePlaylistTransferDeps["loadSourceTracks"]> = async () => [];
  const searchTargetTracks: CreatePlaylistTransferDeps["searchTargetTracks"] = async () => [];
  const checkAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]> = async () => null;
  const saveJob: CreatePlaylistTransferDeps["saveJob"] = async (job) => job;
  let returnedSynchronously = false;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    startPlaylistTransferRunJob: (input, createDependencies) => {
      inputs.push(input);
      dependencyArguments.push(createDependencies);
      returnedSynchronously = true;
      return runJob;
    },
    loadSourceTracks,
    searchTargetTracks,
    checkAvailability,
    saveJob
  });
  const payload = {
    sourceProvider: "qq",
    targetProvider: "netease",
    playlistId: "source-list",
    sourceTrackIds: ["source-1"],
    ownerKey: "attacker"
  };

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs/progress", payload);
    assert.equal(returnedSynchronously, true);
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { job: runJob });
  });

  assert.deepEqual(inputs, [{ ...payload, ownerKey: "server-owner" }]);
  assert.equal(dependencyArguments.length, 1);
  assert.deepEqual(dependencyArguments[0], {
    loadSourceTracks,
    searchTargetTracks,
    checkAvailability,
    saveJob
  });
  assert.equal(dependencyArguments[0].loadSourceTracks, loadSourceTracks);
  assert.equal(dependencyArguments[0].searchTargetTracks, searchTargetTracks);
  assert.equal(dependencyArguments[0].checkAvailability, checkAvailability);
  assert.equal(dependencyArguments[0].saveJob, saveJob);
});

test("progress start does not convert a synchronous start failure", timeout, async () => {
  const router = createPlaylistTransferJobRouter(createDependencies({
    getCurrentUserKey: async () => "server-owner",
    startPlaylistTransferRunJob: () => {
      throw new Error("start failed");
    }
  }));
  const handler = getRouteHandler(router, "post", "/api/playlist-transfer/jobs/progress");

  await assert.rejects(
    Promise.resolve(handler({ body: {} } as Request, {} as Response, () => undefined)),
    /start failed/
  );
});

test("progress reads pass server owner and id while hiding foreign and missing jobs behind the same 404", timeout, async () => {
  const lookups: Array<[string, string]> = [];
  let ownerCalls = 0;
  let currentOwner = "server-owner";
  const dependencies = createDependencies({
    getCurrentUserKey: async () => {
      ownerCalls += 1;
      return currentOwner;
    },
    getPlaylistTransferRunJob: (ownerKey, id) => {
      lookups.push([ownerKey, id]);
      return ownerKey === "server-owner" && id === "run-1" ? runJob : null;
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ request }) => {
    const found = await request("/api/playlist-transfer/jobs/progress/run-1?ownerKey=attacker");
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, { job: runJob });

    currentOwner = "other-owner";
    const foreign = await request("/api/playlist-transfer/jobs/progress/run-1");
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { message: "歌单互转进度任务不存在" });

    currentOwner = "server-owner";
    const missing = await request("/api/playlist-transfer/jobs/progress/missing");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: "歌单互转进度任务不存在" });
  });

  assert.deepEqual(lookups, [
    ["server-owner", "run-1"],
    ["other-owner", "run-1"],
    ["server-owner", "missing"]
  ]);
  assert.equal(ownerCalls, 3);
});

test("progress reads report identity resolution failures as a clear 4xx", timeout, async () => {
  let lookups = 0;
  const router = createPlaylistTransferJobRouter(createDependencies({
    getCurrentUserKey: async () => {
      throw new Error("owner lookup failed");
    },
    getPlaylistTransferRunJob: () => {
      lookups += 1;
      return runJob;
    }
  }));
  await withTestRouter([router], async ({ request }) => {
    const response = await request("/api/playlist-transfer/jobs/progress/run-1");
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "无法确认后台任务所属身份。" });
  });
  assert.equal(lookups, 0);
});

test("persisted reads pass owner and id, return bare jobs, and use the fixed 404", timeout, async () => {
  const lookups: Array<[string, string]> = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      lookups.push([ownerKey, id]);
      return id === neteaseJob.id ? neteaseJob : null;
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ request }) => {
    const found = await request(`/api/playlist-transfer/jobs/${neteaseJob.id}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, publicNeteaseJob);
    assert.equal(Object.prototype.hasOwnProperty.call(found.body, "job"), false);

    const missing = await request("/api/playlist-transfer/jobs/missing");
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: "歌单互转任务不存在" });
  });

  assert.deepEqual(lookups, [
    ["server-owner", neteaseJob.id],
    ["server-owner", "missing"]
  ]);
});

test("export owner-filters and preserves default, string, and non-string format semantics", timeout, async () => {
  const lookups: Array<[string, string]> = [];
  const formats: string[] = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      lookups.push([ownerKey, id]);
      return neteaseJob;
    },
    formatTransferExport: (job, format) => {
      assert.equal(job, neteaseJob);
      formats.push(format);
      return {
        filename: `${format}.txt`,
        contentType: "text/plain",
        content: `formatted:${format}`
      };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const cases: Array<[unknown, string]> = [
      [{}, "markdown"],
      [{ format: "  json  " }, "  json  "],
      [{ format: 123 }, "markdown"]
    ];
    for (const [body, expectedFormat] of cases) {
      const response = await requestJson("POST", `/api/playlist-transfer/jobs/${neteaseJob.id}/export`, body);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        filename: `${expectedFormat}.txt`,
        contentType: "text/plain",
        content: `formatted:${expectedFormat}`
      });
    }
  });

  assert.deepEqual(formats, ["markdown", "  json  ", "markdown"]);
  assert.deepEqual(lookups, Array.from({ length: 3 }, () => ["server-owner", neteaseJob.id]));
});

test("export returns fixed 404 without calling the formatter for inaccessible jobs", timeout, async () => {
  let formatterCalls = 0;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      assert.deepEqual([ownerKey, id], ["server-owner", "missing"]);
      return null;
    },
    formatTransferExport: () => {
      formatterCalls += 1;
      return { filename: "unexpected", contentType: "text/plain", content: "unexpected" };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs/missing/export", { format: "json" });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "歌单互转任务不存在" });
  });
  assert.equal(formatterCalls, 0);
});

test("Netease import returns fixed 404 with zero id or playlist writes for a missing job", timeout, async () => {
  const calls = { ids: 0, add: 0, create: 0 };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      assert.deepEqual([ownerKey, id], ["server-owner", "missing"]);
      return null;
    },
    getNeteaseImportTrackIds: () => {
      calls.ids += 1;
      return [];
    },
    addNeteaseTrackIdsToExistingPlaylist: async () => {
      calls.add += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    },
    createNeteasePlaylistFromTrackIds: async () => {
      calls.create += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs/missing/import/netease", {});
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "歌单互转任务不存在" });
  });
  assert.deepEqual(calls, { ids: 0, add: 0, create: 0 });
});

test("Netease import rejects a wrong target without reading ids or writing playlists", timeout, async () => {
  const calls = { ids: 0, add: 0, create: 0 };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      assert.deepEqual([ownerKey, id], ["server-owner", qqJob.id]);
      return qqJob;
    },
    getNeteaseImportTrackIds: () => {
      calls.ids += 1;
      return [];
    },
    addNeteaseTrackIdsToExistingPlaylist: async () => {
      calls.add += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    },
    createNeteasePlaylistFromTrackIds: async () => {
      calls.create += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", `/api/playlist-transfer/jobs/${qqJob.id}/import/netease`, {});
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "只有目标为网易云的互转任务才能直接导入网易云歌单。" });
  });
  assert.deepEqual(calls, { ids: 0, add: 0, create: 0 });
});

test("Netease existing-playlist import trims name and id, passes ids, and computes skippedCount", timeout, async () => {
  const trackIds = ["netease-1", "netease-2"];
  const addCalls: Array<[string, string[]]> = [];
  let createCalls = 0;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async () => neteaseJob,
    getNeteaseImportTrackIds: (job) => {
      assert.equal(job, neteaseJob);
      return trackIds;
    },
    addNeteaseTrackIdsToExistingPlaylist: async (playlistId, ids) => {
      addCalls.push([playlistId, ids]);
      return {
        playlistId,
        playlistName: "已有歌单",
        playlistUrl: "https://example.invalid/playlist",
        addedCount: 3
      };
    },
    createNeteasePlaylistFromTrackIds: async () => {
      createCalls += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${neteaseJob.id}/import/netease`,
      { name: "  已有名称  ", playlistId: "  existing-1  " }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      playlistId: "existing-1",
      playlistName: "已有歌单",
      playlistUrl: "https://example.invalid/playlist",
      addedCount: 3,
      skippedCount: 4
    });
  });

  assert.deepEqual(addCalls, [["existing-1", trackIds]]);
  assert.equal(createCalls, 0);
});

test("Netease new-playlist import uses the trimmed or default name for empty playlist ids", timeout, async () => {
  const creates: Array<[string, string[]]> = [];
  const trackIds = ["netease-1"];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async () => neteaseJob,
    getNeteaseImportTrackIds: () => trackIds,
    addNeteaseTrackIdsToExistingPlaylist: async () => unexpectedDependency("addNeteaseTrackIdsToExistingPlaylist"),
    createNeteasePlaylistFromTrackIds: async (name, ids) => {
      creates.push([name, ids]);
      return { playlistId: `created-${creates.length}`, playlistName: name, addedCount: 1 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const trimmed = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${neteaseJob.id}/import/netease`,
      { name: "  新名称  ", playlistId: "   " }
    );
    assert.equal(trimmed.status, 200);
    assert.deepEqual(trimmed.body, {
      playlistId: "created-1",
      playlistName: "新名称",
      addedCount: 1,
      skippedCount: 6
    });

    const fallback = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${neteaseJob.id}/import/netease`,
      { name: "   ", playlistId: 99 }
    );
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, {
      playlistId: "created-2",
      playlistName: "源歌单 转换结果",
      addedCount: 1,
      skippedCount: 6
    });
  });

  assert.deepEqual(creates, [
    ["新名称", trackIds],
    ["源歌单 转换结果", trackIds]
  ]);
});

test("Netease import converts id extraction and provider Error/non-Error failures to 400", timeout, async () => {
  const cases: Array<{
    name: string;
    playlistId: string;
    idsFailure?: unknown;
    addFailure?: unknown;
    createFailure?: unknown;
    expected: string;
  }> = [
    { name: "ids", playlistId: "", idsFailure: new Error("ids failed"), expected: "ids failed" },
    { name: "add", playlistId: "existing", addFailure: new Error("add failed"), expected: "add failed" },
    { name: "create", playlistId: "", createFailure: "create failed", expected: "导入网易云歌单失败" }
  ];

  for (const errorCase of cases) {
    const dependencies = createDependencies({
      getCurrentUserKey: async () => "server-owner",
      getPlaylistTransferJob: async () => neteaseJob,
      getNeteaseImportTrackIds: () => {
        if (errorCase.idsFailure !== undefined) throw errorCase.idsFailure;
        return ["netease-1"];
      },
      addNeteaseTrackIdsToExistingPlaylist: async () => {
        throw errorCase.addFailure;
      },
      createNeteasePlaylistFromTrackIds: async () => {
        throw errorCase.createFailure;
      }
    });
    await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
      const response = await requestJson(
        "POST",
        `/api/playlist-transfer/jobs/${neteaseJob.id}/import/netease`,
        { name: errorCase.name, playlistId: errorCase.playlistId }
      );
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: errorCase.expected });
    });
  }
});

test("QQ import returns fixed 404 with zero id or playlist writes for a missing job", timeout, async () => {
  const calls = { mids: 0, create: 0 };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      assert.deepEqual([ownerKey, id], ["server-owner", "missing"]);
      return null;
    },
    getQqImportTrackMids: () => {
      calls.mids += 1;
      return [];
    },
    createQqPlaylistFromTrackMids: async () => {
      calls.create += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/jobs/missing/import/qq", {});
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "歌单互转任务不存在" });
  });
  assert.deepEqual(calls, { mids: 0, create: 0 });
});

test("QQ import rejects a wrong target with zero id or playlist writes", timeout, async () => {
  const calls = { mids: 0, create: 0 };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async (ownerKey, id) => {
      assert.deepEqual([ownerKey, id], ["server-owner", neteaseJob.id]);
      return neteaseJob;
    },
    getQqImportTrackMids: () => {
      calls.mids += 1;
      return [];
    },
    createQqPlaylistFromTrackMids: async () => {
      calls.create += 1;
      return { playlistId: "unexpected", playlistName: "unexpected", addedCount: 0 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", `/api/playlist-transfer/jobs/${neteaseJob.id}/import/qq`, {});
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "只有目标为 QQ 音乐的互转任务才能直接导入 QQ 歌单。" });
  });
  assert.deepEqual(calls, { mids: 0, create: 0 });
});

test("QQ import trims names, passes mids, always creates, ignores playlistId, and computes skippedCount", timeout, async () => {
  const trackMids = ["qq-1", "qq-2"];
  const creates: Array<[string, string[]]> = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async () => qqJob,
    getQqImportTrackMids: (job) => {
      assert.equal(job, qqJob);
      return trackMids;
    },
    createQqPlaylistFromTrackMids: async (name, mids) => {
      creates.push([name, mids]);
      return { playlistId: `qq-created-${creates.length}`, playlistName: name, addedCount: 2 };
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const trimmed = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${qqJob.id}/import/qq`,
      { name: "  QQ 新名称  ", playlistId: "must-be-ignored" }
    );
    assert.equal(trimmed.status, 200);
    assert.deepEqual(trimmed.body, {
      playlistId: "qq-created-1",
      playlistName: "QQ 新名称",
      addedCount: 2,
      skippedCount: 5
    });

    const fallback = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${qqJob.id}/import/qq`,
      { name: "   ", playlistId: "also-ignored" }
    );
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body, {
      playlistId: "qq-created-2",
      playlistName: "源歌单 转换结果",
      addedCount: 2,
      skippedCount: 5
    });
  });

  assert.deepEqual(creates, [
    ["QQ 新名称", trackMids],
    ["源歌单 转换结果", trackMids]
  ]);
});

test("QQ provider Error and non-Error failures remain 400", timeout, async () => {
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferJob: async () => qqJob,
    getQqImportTrackMids: () => ["qq-1"],
    createQqPlaylistFromTrackMids: async (name) => {
      throw name === "error" ? new Error("QQ create failed") : "QQ create failed";
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ requestJson }) => {
    const known = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${qqJob.id}/import/qq`,
      { name: "error" }
    );
    assert.equal(known.status, 400);
    assert.deepEqual(known.body, { message: "QQ create failed" });

    const fallback = await requestJson(
      "POST",
      `/api/playlist-transfer/jobs/${qqJob.id}/import/qq`,
      { name: "non-error" }
    );
    assert.equal(fallback.status, 400);
    assert.deepEqual(fallback.body, { message: "导入 QQ 音乐歌单失败" });
  });
});

test("route boundaries distinguish progress and persisted ids and pass audit, compare, and unknown paths onward", timeout, async () => {
  const calls = { progress: [] as string[], persisted: [] as string[] };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "server-owner",
    getPlaylistTransferRunJob: (ownerKey, id) => {
      assert.equal(ownerKey, "server-owner");
      calls.progress.push(id);
      return runJob;
    },
    getPlaylistTransferJob: async (_ownerKey, id) => {
      calls.persisted.push(id);
      return neteaseJob;
    }
  });

  await withTestRouter([createPlaylistTransferJobRouter(dependencies)], async ({ request, requestJson }) => {
    const progress = await request("/api/playlist-transfer/jobs/progress/progress-7");
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.body, { job: runJob });

    const persisted = await request("/api/playlist-transfer/jobs/persisted-7");
    assert.equal(persisted.status, 200);
    assert.deepEqual(persisted.body, publicNeteaseJob);

    const passthroughRequests = [
      await requestJson("POST", "/api/playlist-transfer/netease-import-audit", {}),
      await requestJson("POST", "/api/playlist-transfer/compare", {}),
      await request("/api/playlist-transfer/jobs/persisted-7/unknown")
    ];
    for (const response of passthroughRequests) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });

  assert.deepEqual(calls, {
    progress: ["progress-7"],
    persisted: ["persisted-7"]
  });
});
