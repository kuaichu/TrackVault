import assert from "node:assert/strict";
import test from "node:test";
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { PlaylistCompareJob } from "../playlist-transfer/playlist-compare-job.js";
import type {
  PlaylistCompareExportOptions,
  PlaylistCompareRequest,
  PlaylistCompareResult,
  PlaylistCompareStatus,
  PlaylistCompareSide
} from "../playlist-transfer/playlist-compare.js";
import type { TransferExportFormat, TransferExportResult, TransferTrack } from "../playlist-transfer/types.js";
import { getClientSessionId } from "../request-context.js";
import { getRequiredClientSessionId } from "../request-context.js";
import { createBackgroundJobOwnerResolver } from "../background-job-owner.js";
import {
  createPlaylistCompareRouter,
  type PlaylistCompareRouterDependencies
} from "./playlist-compare-router.js";
import { withTestRouter } from "./router-test-http.js";
import { assertPublicDtoSafe } from "../playlist-transfer/assert-public-dto-safe.js";
import { formatPlaylistCompareExport } from "../playlist-transfer/playlist-compare.js";

const timeout = { timeout: 5_000 };

const leftTrack: TransferTrack = {
  source: "netease",
  sourceTrackId: "netease-1",
  title: "左侧歌曲",
  artists: ["左侧歌手"]
};

const rightTrack: TransferTrack = {
  source: "qq",
  sourceTrackId: "qq-1",
  title: "右侧歌曲",
  artists: ["右侧歌手"]
};

const compareResult: PlaylistCompareResult = {
  left: {
    provider: "netease",
    playlistId: "left-list",
    playlistName: "左侧歌单",
    total: 2
  },
  right: {
    provider: "qq",
    playlistId: "right-list",
    playlistName: "右侧歌单",
    total: 1
  },
  items: [
    { status: "exact", leftTrack, rightTrack, score: 1, reasons: ["完全一致"] },
    { status: "left_only", leftTrack, score: 0, reasons: ["仅左侧歌单存在"] },
    { status: "right_only", rightTrack, score: 0, reasons: ["仅右侧歌单存在"] }
  ],
  summary: {
    totalLeft: 2,
    totalRight: 1,
    exact: 1,
    sameTitleDifferentArtist: 0,
    similarTitle: 0,
    leftOnly: 1,
    rightOnly: 1
  },
  createdAt: "2026-07-26T00:00:00.000Z"
};

const queuedJob: PlaylistCompareJob = {
  id: "compare-job",
  status: "queued",
  input: {
    leftProvider: "netease",
    leftPlaylistId: "left-list",
    leftPlaylistName: "左侧歌单",
    rightProvider: "qq",
    rightPlaylistId: "right-list",
    rightPlaylistName: "右侧歌单"
  },
  progress: {
    phase: "queued",
    processed: 0,
    total: 0,
    exact: 0,
    sameTitleDifferentArtist: 0,
    similarTitle: 0,
    leftOnly: 0,
    rightOnly: 0
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

const exportResult: TransferExportResult = {
  filename: "compare.md",
  contentType: "text/markdown; charset=utf-8",
  content: "# compare"
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected playlist compare dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<PlaylistCompareRouterDependencies> = {}
): PlaylistCompareRouterDependencies {
  return {
    getCurrentUserKey: async () => unexpectedDependency("getCurrentUserKey"),
    loadNeteasePlaylistTransferTracks: async () => unexpectedDependency("loadNeteasePlaylistTransferTracks"),
    loadQqPlaylistTransferTracks: async () => unexpectedDependency("loadQqPlaylistTransferTracks"),
    startPlaylistCompareJob: () => unexpectedDependency("startPlaylistCompareJob"),
    getPlaylistCompareJob: () => unexpectedDependency("getPlaylistCompareJob"),
    comparePlaylists: () => unexpectedDependency("comparePlaylists"),
    formatPlaylistCompareExport: () => unexpectedDependency("formatPlaylistCompareExport"),
    ...overrides
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function getPostHandler(router: Router, path: string): RequestHandler {
  const routeLayer = router.stack.find((layer) => layer.route?.path === path);
  const handler = routeLayer?.route?.stack[0]?.handle;
  assert.ok(handler, `Expected POST handler for ${path}`);
  return handler;
}

test("job start shares normalization, injects exact provider loading, and permits invalid providers", timeout, async () => {
  const ownerKeys: string[] = [];
  const inputs: PlaylistCompareRequest[] = [];
  let loadSideTracks: ((provider: string, playlistId: string) => Promise<TransferTrack[]>) | undefined;
  const providerCalls: Array<[string, string]> = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "trusted-owner",
    loadNeteasePlaylistTransferTracks: async (playlistId) => {
      providerCalls.push(["netease", playlistId]);
      return [leftTrack];
    },
    loadQqPlaylistTransferTracks: async (playlistId) => {
      providerCalls.push(["qq", playlistId]);
      return [rightTrack];
    },
    startPlaylistCompareJob: (ownerKey, input, jobDependencies) => {
      ownerKeys.push(ownerKey);
      inputs.push(input);
      loadSideTracks = jobDependencies.loadSideTracks;
      return queuedJob;
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftProvider: " netease ",
      leftPlaylistId: " left-list ",
      leftPlaylistName: " 左侧名称 ",
      rightProvider: " invalid-provider ",
      rightPlaylistId: " right-list ",
      rightPlaylistName: "   ",
      ownerKey: "forged-owner"
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { job: queuedJob });

    const fallbackResponse = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftProvider: 1,
      leftPlaylistId: "left-2",
      leftPlaylistName: null,
      rightProvider: null,
      rightPlaylistId: "right-2",
      rightPlaylistName: false
    });
    assert.equal(fallbackResponse.status, 202);
  });

  assert.deepEqual(inputs, [
    {
      leftProvider: "netease",
      leftPlaylistId: "left-list",
      leftPlaylistName: "左侧名称",
      rightProvider: "invalid-provider",
      rightPlaylistId: "right-list",
      rightPlaylistName: "右侧歌单 right-list"
    },
    {
      leftProvider: "",
      leftPlaylistId: "left-2",
      leftPlaylistName: "左侧歌单 left-2",
      rightProvider: "",
      rightPlaylistId: "right-2",
      rightPlaylistName: "右侧歌单 right-2"
    }
  ]);
  assert.deepEqual(ownerKeys, ["trusted-owner", "trusted-owner"]);

  assert.ok(loadSideTracks);
  assert.deepEqual(await loadSideTracks("netease", " netease-id "), [leftTrack]);
  assert.deepEqual(await loadSideTracks("qq", "qq:id"), [rightTrack]);
  await assert.rejects(loadSideTracks("Netease", "left-list"), {
    message: "歌单对比暂只支持网易云歌单和 QQ 音乐公开歌单。"
  });
  await assert.rejects(loadSideTracks("", "left-list"), {
    message: "歌单对比暂只支持网易云歌单和 QQ 音乐公开歌单。"
  });
  assert.deepEqual(providerCalls, [
    ["netease", " netease-id "],
    ["qq", "qq:id"]
  ]);
});

test("job start only rejects missing ids and leaves start errors to the next error boundary", timeout, async () => {
  let identityReads = 0;
  let starts = 0;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => {
      identityReads += 1;
      return "server-owner";
    },
    startPlaylistCompareJob: () => {
      starts += 1;
      throw new Error("start failed");
    }
  });
  const errorBoundary: ErrorRequestHandler = (error, _request, response, _next) => {
    response.status(599).json({ message: error instanceof Error ? error.message : "unknown" });
  };

  await withTestRouter([
    createPlaylistCompareRouter(dependencies),
    errorBoundary as unknown as RequestHandler
  ], async ({ requestJson }) => {
    const missingLeft = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftPlaylistId: 123,
      rightPlaylistId: "right-list"
    });
    assert.equal(missingLeft.status, 400);
    assert.deepEqual(missingLeft.body, { message: "请填写左右两个歌单 ID。" });

    const missingRight = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftPlaylistId: "left-list",
      rightPlaylistId: "   "
    });
    assert.equal(missingRight.status, 400);
    assert.deepEqual(missingRight.body, { message: "请填写左右两个歌单 ID。" });

    const thrown = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftPlaylistId: "left-list",
      rightPlaylistId: "right-list"
    });
    assert.equal(thrown.status, 599);
    assert.deepEqual(thrown.body, { message: "start failed" });
  });

  assert.equal(starts, 1);
  assert.equal(identityReads, 1);
});

test("job lookup scopes ids to request identity and conceals cross-owner jobs as missing", timeout, async () => {
  const lookups: Array<[string, string]> = [];
  const resolveOwner = createBackgroundJobOwnerResolver({
    getClientSessionId: getRequiredClientSessionId,
    getCredentials: async () => ({ neteaseCookie: "", qqMusicCookie: "unverified-cookie" }),
    readVerifiedIdentityState: async () => ({
      session: { loggedIn: false, profile: null },
      qqMusicUin: null
    })
  });
  const dependencies = createDependencies({
    getCurrentUserKey: resolveOwner,
    getPlaylistCompareJob: (ownerKey, id) => {
      lookups.push([ownerKey, id]);
      return ownerKey === "guest:owner-a" && id === queuedJob.id ? queuedJob : null;
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ request }) => {
    const found = await request(
      `/api/playlist-transfer/compare/jobs/${queuedJob.id}?ownerKey=attacker&dataScopeId=account%3Aqqmusic%3A99999&uin=99999&profile=victim&provider=qqmusic`,
      {
        headers: {
          "x-client-session-id": "owner-a",
          "x-owner-key": "header-attacker",
          "x-data-scope-id": "account:netease:header-attacker",
          "x-qq-uin": "88888"
        }
      }
    );
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, { job: queuedJob });

    const concealed = await request(`/api/playlist-transfer/compare/jobs/${queuedJob.id}`, {
      headers: { "x-client-session-id": "owner-b" }
    });
    assert.equal(concealed.status, 404);
    assert.deepEqual(concealed.body, { message: "歌单对比进度任务不存在" });

    const foundAfterIdentitySwitch = await request(`/api/playlist-transfer/compare/jobs/${queuedJob.id}?sid=owner-a`);
    assert.equal(foundAfterIdentitySwitch.status, 200);
    assert.deepEqual(foundAfterIdentitySwitch.body, { job: queuedJob });

    const missing = await request("/api/playlist-transfer/compare/jobs/missing", {
      headers: { "x-client-session-id": "owner-a" }
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { message: "歌单对比进度任务不存在" });
  });

  assert.deepEqual(lookups, [
    ["guest:owner-a", queuedJob.id],
    ["guest:owner-b", queuedJob.id],
    ["guest:owner-a", queuedJob.id],
    ["guest:owner-a", "missing"]
  ]);
});

test("compare progress polling returns a clear 4xx when owner identity cannot be resolved", timeout, async () => {
  let lookups = 0;
  const dependencies = createDependencies({
    getCurrentUserKey: async () => {
      throw new Error("owner lookup failed");
    },
    getPlaylistCompareJob: () => {
      lookups += 1;
      return queuedJob;
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ request }) => {
    const response = await request(`/api/playlist-transfer/compare/jobs/${queuedJob.id}`);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "无法确认后台任务所属身份。" });
  });
  assert.equal(lookups, 0);
});

test("sync compare starts both provider loads in parallel and forwards complete normalized sides", timeout, async () => {
  const leftDeferred = createDeferred<TransferTrack[]>();
  const rightDeferred = createDeferred<TransferTrack[]>();
  const bothStarted = createDeferred<void>();
  const providerCalls: Array<[string, string]> = [];
  let compareInput: { left: PlaylistCompareSide; right: PlaylistCompareSide } | undefined;
  const markStarted = () => {
    if (providerCalls.length === 2) bothStarted.resolve();
  };
  const dependencies = createDependencies({
    loadNeteasePlaylistTransferTracks: async (playlistId) => {
      providerCalls.push(["netease", playlistId]);
      markStarted();
      return leftDeferred.promise;
    },
    loadQqPlaylistTransferTracks: async (playlistId) => {
      providerCalls.push(["qq", playlistId]);
      markStarted();
      return rightDeferred.promise;
    },
    comparePlaylists: (input) => {
      compareInput = input;
      return compareResult;
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ requestJson }) => {
    const responsePromise = requestJson("POST", "/api/playlist-transfer/compare", {
      leftProvider: " netease ",
      leftPlaylistId: " left-list ",
      leftPlaylistName: "  ",
      rightProvider: " qq ",
      rightPlaylistId: " right-list ",
      rightPlaylistName: " 右侧名称 "
    });

    await bothStarted.promise;
    assert.deepEqual(providerCalls, [
      ["netease", "left-list"],
      ["qq", "right-list"]
    ]);
    leftDeferred.resolve([leftTrack]);
    rightDeferred.resolve([rightTrack]);

    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, compareResult);
  });

  assert.deepEqual(compareInput, {
    left: {
      provider: "netease",
      playlistId: "left-list",
      playlistName: "左侧歌单 left-list",
      tracks: [leftTrack]
    },
    right: {
      provider: "qq",
      playlistId: "right-list",
      playlistName: "右侧名称",
      tracks: [rightTrack]
    }
  });
});

test("sync compare preserves missing-id and Error/non-Error 400 responses", timeout, async () => {
  let qqLoads = 0;
  const invalidProviderDependencies = createDependencies({
    loadQqPlaylistTransferTracks: async () => {
      qqLoads += 1;
      return [rightTrack];
    }
  });

  await withTestRouter([createPlaylistCompareRouter(invalidProviderDependencies)], async ({ requestJson }) => {
    const missing = await requestJson("POST", "/api/playlist-transfer/compare", {
      leftPlaylistId: "left-list",
      rightPlaylistId: false
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { message: "请填写左右两个歌单 ID。" });

    const invalidProvider = await requestJson("POST", "/api/playlist-transfer/compare", {
      leftProvider: "NETEASE",
      leftPlaylistId: "left-list",
      rightProvider: "qq",
      rightPlaylistId: "right-list"
    });
    assert.equal(invalidProvider.status, 400);
    assert.deepEqual(invalidProvider.body, {
      message: "歌单对比暂只支持网易云歌单和 QQ 音乐公开歌单。"
    });
  });
  assert.equal(qqLoads, 1);

  const nonErrorDependencies = createDependencies({
    loadNeteasePlaylistTransferTracks: async () => {
      throw "load failed";
    },
    loadQqPlaylistTransferTracks: async () => []
  });
  await withTestRouter([createPlaylistCompareRouter(nonErrorDependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/playlist-transfer/compare", {
      leftProvider: "netease",
      leftPlaylistId: "left-list",
      rightProvider: "qq",
      rightPlaylistId: "right-list"
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "歌单对比失败" });
  });
});

test("export validates result before formatting and defaults format and statuses", timeout, async () => {
  const calls: Array<{
    result: PlaylistCompareResult;
    format: TransferExportFormat;
    statuses: PlaylistCompareStatus[];
    options: PlaylistCompareExportOptions;
  }> = [];
  const dependencies = createDependencies({
    formatPlaylistCompareExport: (result, format, statuses, options) => {
      assert.ok(options);
      calls.push({ result, format, statuses, options });
      return exportResult;
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ requestJson }) => {
    for (const result of [undefined, {}, { left: {}, right: {}, items: null }]) {
      const invalid = await requestJson("POST", "/api/playlist-transfer/compare/export", {
        result,
        statuses: ["exact"]
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.body, { message: "缺少有效的歌单对比结果。" });
    }

    const defaults = await requestJson("POST", "/api/playlist-transfer/compare/export", {
      result: compareResult,
      format: null,
      statuses: "exact",
      preferredProvider: "netease"
    });
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.body, exportResult);

    const rawValues = await requestJson("POST", "/api/playlist-transfer/compare/export", {
      result: compareResult,
      format: " JSON ",
      statuses: ["right_only", " exact ", "Exact", "invalid", "exact", "right_only", 1],
      itemIndexes: [2, "1", 2, -1, 1.5, 1, 3],
      preferredProvider: "QQ"
    });
    assert.equal(rawValues.status, 200);
    assert.deepEqual(rawValues.body, exportResult);

    const emptyArrays = await requestJson("POST", "/api/playlist-transfer/compare/export", {
      result: compareResult,
      statuses: [],
      itemIndexes: [],
      preferredProvider: "qq"
    });
    assert.equal(emptyArrays.status, 200);
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    result: compareResult,
    format: "markdown",
    statuses: ["exact", "same_title_different_artist", "similar_title", "left_only", "right_only"],
    options: { itemIndexes: undefined, preferredProvider: "netease" }
  });
  assert.deepEqual(calls[1], {
    result: compareResult,
    format: " JSON ",
    statuses: ["right_only", "exact", "right_only"],
    options: { itemIndexes: [2, 1], preferredProvider: undefined }
  });
  assert.deepEqual(calls[2], {
    result: compareResult,
    format: "markdown",
    statuses: [],
    options: { itemIndexes: [], preferredProvider: "qq" }
  });
});

test("export filters NaN and Infinity and leaves formatter rejection unconverted", timeout, async () => {
  const calls: PlaylistCompareExportOptions[] = [];
  const dependencies = createDependencies({
    formatPlaylistCompareExport: (_result, _format, _statuses, options) => {
      assert.ok(options);
      calls.push(options);
      if (calls.length === 2) {
        throw new Error("formatter failed");
      }
      return exportResult;
    }
  });
  const handler = getPostHandler(createPlaylistCompareRouter(dependencies), "/api/playlist-transfer/compare/export");
  const payloads: unknown[] = [];
  const response = {
    json: (payload: unknown) => {
      payloads.push(payload);
      return response;
    }
  } as unknown as Response;
  const next = (() => assert.fail("The export handler must not call next")) as NextFunction;

  await Promise.resolve(handler({
    body: {
      result: compareResult,
      itemIndexes: [0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 2],
      preferredProvider: ""
    }
  } as Request, response, next));
  assert.deepEqual(payloads, [exportResult]);
  assert.deepEqual(calls[0], { itemIndexes: [0, 2], preferredProvider: undefined });

  await assert.rejects(Promise.resolve(handler({
    body: { result: compareResult, preferredProvider: 123 }
  } as Request, response, next)), {
    message: "formatter failed"
  });
  assert.deepEqual(calls[1], { itemIndexes: undefined, preferredProvider: undefined });
  assert.equal(payloads.length, 1);
});

test("compare sync and job HTTP responses deeply sanitize dependency results", timeout, async () => {
  const secret = "compare-http-secret-sentinel";
  const privateResult: PlaylistCompareResult & { ownerKey: string } = {
    ...compareResult,
    left: Object.assign({ ...compareResult.left }, { clientSessionId: secret }),
    right: Object.assign({ ...compareResult.right }, { SID: secret }),
    items: compareResult.items.map((item) => ({
      ...item,
      leftTrack: item.leftTrack
        ? Object.assign({ ...item.leftTrack, artists: [...item.leftTrack.artists] }, { raw: { credentialDigest: secret } })
        : undefined,
      rightTrack: item.rightTrack
        ? Object.assign({ ...item.rightTrack, artists: [...item.rightTrack.artists] }, { token: secret })
        : undefined,
      reasons: [...item.reasons],
      cancelRequested: true
    })),
    summary: Object.assign({ ...compareResult.summary }, { generation: secret }),
    ownerKey: secret
  };
  const privateJob: PlaylistCompareJob & { ownerKey: string; guard: string } = {
    ...queuedJob,
    input: Object.assign({ ...queuedJob.input }, { credentialFingerprint: secret }),
    progress: Object.assign({ ...queuedJob.progress }, { clientSessionId: secret }),
    result: privateResult,
    ownerKey: secret,
    guard: secret
  };
  const dependencies = createDependencies({
    getCurrentUserKey: async () => "owner-private",
    loadNeteasePlaylistTransferTracks: async () => [leftTrack],
    loadQqPlaylistTransferTracks: async () => [rightTrack],
    comparePlaylists: () => privateResult,
    startPlaylistCompareJob: () => privateJob,
    getPlaylistCompareJob: () => privateJob
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ request, requestJson }) => {
    const sync = await requestJson("POST", "/api/playlist-transfer/compare", {
      leftProvider: "netease",
      leftPlaylistId: "left-list",
      rightProvider: "qq",
      rightPlaylistId: "right-list"
    });
    const started = await requestJson("POST", "/api/playlist-transfer/compare/jobs", {
      leftProvider: "netease",
      leftPlaylistId: "left-list",
      rightProvider: "qq",
      rightPlaylistId: "right-list"
    });
    const found = await request("/api/playlist-transfer/compare/jobs/private-job");

    assert.equal(sync.status, 200);
    assert.equal(started.status, 202);
    assert.equal(found.status, 200);
    assertPublicDtoSafe(sync.body, secret);
    assertPublicDtoSafe(started.body, secret);
    assertPublicDtoSafe(found.body, secret);
    assert.deepEqual((sync.body as PlaylistCompareResult).summary, compareResult.summary);
  });
});

test("compare export validates untrusted input, strips unknown fields, and never formats invalid structures", timeout, async () => {
  const secret = "compare-export-http-secret-sentinel";
  const forgedResult = {
    ...compareResult,
    ownerKey: secret,
    left: { ...compareResult.left, SID: secret },
    items: compareResult.items.map((item) => ({
      ...item,
      credentialDigest: secret,
      leftTrack: item.leftTrack ? { ...item.leftTrack, raw: { cookie: secret } } : undefined,
      rightTrack: item.rightTrack ? { ...item.rightTrack, clientSessionId: secret } : undefined
    })),
    summary: { ...compareResult.summary, guard: secret }
  };
  let formatterCalls = 0;
  const dependencies = createDependencies({
    formatPlaylistCompareExport: (result, format, statuses, options) => {
      formatterCalls += 1;
      assertPublicDtoSafe(result, secret);
      return formatPlaylistCompareExport(result, format, statuses, options);
    }
  });

  await withTestRouter([createPlaylistCompareRouter(dependencies)], async ({ requestJson }) => {
    const valid = await requestJson("POST", "/api/playlist-transfer/compare/export", {
      result: forgedResult,
      format: "json",
      statuses: ["exact", "left_only", "right_only"]
    });
    assert.equal(valid.status, 200);
    const exported = valid.body as TransferExportResult;
    assert.equal(exported.filename, "左侧歌单-vs-右侧歌单-compare.json");
    assert.equal(exported.contentType, "application/json; charset=utf-8");
    assertPublicDtoSafe(JSON.parse(exported.content) as unknown, secret);

    const invalidResults: unknown[] = [
      { ...forgedResult, items: null },
      { ...forgedResult, createdAt: 1 },
      { ...forgedResult, summary: { ...compareResult.summary, exact: "1" } },
      { ...forgedResult, items: [{ ...compareResult.items[0], score: Number.NaN }] },
      { ...forgedResult, items: [{ ...compareResult.items[0], reasons: "invalid" }] },
      { ...forgedResult, left: { ...compareResult.left, total: -1 } }
    ];
    for (const result of invalidResults) {
      const invalid = await requestJson("POST", "/api/playlist-transfer/compare/export", { result, format: "json" });
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.body, { message: "缺少有效的歌单对比结果。" });
    }
  });

  assert.equal(formatterCalls, 1);
});

test("unknown, unsupported, core job, and audit routes pass to later handlers", timeout, async () => {
  await withTestRouter([createPlaylistCompareRouter(createDependencies())], async ({ request, requestJson }) => {
    const responses = [
      await requestJson("POST", "/api/playlist-transfer/jobs", {}),
      await requestJson("POST", "/api/playlist-transfer/netease-import-audit", {}),
      await requestJson("POST", "/api/playlist-transfer/compare/unknown", {}),
      await request("/api/playlist-transfer/compare")
    ];

    for (const response of responses) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
