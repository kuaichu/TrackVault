import assert from "node:assert/strict";
import test from "node:test";
import type { NeteaseImportedPlaylistAudit } from "../playlist-transfer/netease-import-audit.js";
import type { NeteaseImportAuditJob } from "../playlist-transfer/netease-import-audit-job.js";
import type { MatchCandidate, TransferTrack } from "../playlist-transfer/types.js";
import {
  createNeteaseImportAuditRouter,
  type NeteaseImportAuditRouterDependencies
} from "./netease-import-audit-router.js";
import { createBackgroundJobOwnerResolver } from "../background-job-owner.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const audit: NeteaseImportedPlaylistAudit = {
  playlistId: "liked",
  playlistName: "我喜欢的音乐",
  scannedCount: 5,
  summary: {
    total: 5,
    playable: 2,
    suspect: 3,
    replaceable: 1,
    needsReview: 1,
    unusable: 1
  },
  playableTrackIds: ["1001", "1002"],
  playableTextPlaylist: "正常歌曲 - 歌手",
  items: [],
  textPlaylist: "替代歌曲 - 歌手",
  unusableText: "不可用歌曲 - 歌手",
  markdownReport: "# 审计"
};

const queuedJob: NeteaseImportAuditJob = {
  id: "audit-job",
  status: "queued",
  input: {
    playlistId: "liked",
    playlistName: "我喜欢的音乐",
    maxTracks: 300,
    candidateLimit: 5,
    checkAvailability: false
  },
  progress: {
    phase: "queued",
    scanned: 0,
    total: 0,
    suspect: 0,
    replaceable: 0,
    needsReview: 0,
    unusable: 0
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

const completedJob: NeteaseImportAuditJob = {
  ...queuedJob,
  status: "completed",
  progress: {
    phase: "completed",
    scanned: 5,
    total: 5,
    suspect: 3,
    replaceable: 1,
    needsReview: 1,
    unusable: 1
  },
  result: audit
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected netease import audit dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<NeteaseImportAuditRouterDependencies> = {}
): NeteaseImportAuditRouterDependencies {
  return {
    getCurrentUserKey: async () => "owner-a",
    loadNeteasePlaylistAuditEntries: async () => unexpectedDependency("loadNeteasePlaylistAuditEntries"),
    buildNeteaseImportedPlaylistAudit: async () => unexpectedDependency("buildNeteaseImportedPlaylistAudit"),
    searchNeteaseProviderTracksByTitle: async () => unexpectedDependency("searchNeteaseProviderTracksByTitle"),
    checkNeteaseProviderTrackAvailability: async () => unexpectedDependency("checkNeteaseProviderTrackAvailability"),
    startNeteaseImportAuditJob: () => unexpectedDependency("startNeteaseImportAuditJob"),
    getNeteaseImportAuditJob: () => unexpectedDependency("getNeteaseImportAuditJob"),
    cancelNeteaseImportAuditJob: () => unexpectedDependency("cancelNeteaseImportAuditJob"),
    formatNeteaseImportAuditJobExport: () => unexpectedDependency("formatNeteaseImportAuditJobExport"),
    createNeteasePlaylistFromTrackIds: async () => unexpectedDependency("createNeteasePlaylistFromTrackIds"),
    ...overrides
  };
}

test("sync audit keeps direct Number conversion, defaults, and availability semantics", timeout, async () => {
  const loads: Array<[string, number | undefined]> = [];
  const buildInputs: Array<Parameters<NeteaseImportAuditRouterDependencies["buildNeteaseImportedPlaylistAudit"]>[0]> = [];
  const entries = [{ track: { id: "source-1", name: "歌曲" } }];
  const dependencies = createDependencies({
    loadNeteasePlaylistAuditEntries: async (playlistId, maxTracks) => {
      loads.push([playlistId, maxTracks]);
      return entries;
    },
    buildNeteaseImportedPlaylistAudit: async (input) => {
      buildInputs.push(input);
      return audit;
    },
    searchNeteaseProviderTracksByTitle: async () => [],
    checkNeteaseProviderTrackAvailability: async () => null
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const disabled = await requestJson("POST", "/api/playlist-transfer/netease-import-audit", {
      playlistId: "  liked  ",
      playlistName: "  我的歌单  ",
      maxTracks: "",
      candidateLimit: "invalid",
      checkAvailability: false
    });
    assert.equal(disabled.status, 200);
    assert.deepEqual(disabled.body, audit);

    const defaults = await requestJson("POST", "/api/playlist-transfer/netease-import-audit", {
      playlistId: "liked-2",
      playlistName: "  "
    });
    assert.equal(defaults.status, 200);
  });

  assert.deepEqual(loads, [["liked", 0], ["liked-2", 300]]);
  assert.equal(buildInputs[0].playlistId, "liked");
  assert.equal(buildInputs[0].playlistName, "我的歌单");
  assert.ok(Number.isNaN(buildInputs[0].candidateLimit));
  assert.equal(buildInputs[0].searchCandidates, dependencies.searchNeteaseProviderTracksByTitle);
  assert.equal(buildInputs[0].checkCandidateAvailability, undefined);
  assert.equal(buildInputs[1].playlistName, "网易云歌单");
  assert.equal(buildInputs[1].candidateLimit, 5);
  assert.equal(
    buildInputs[1].checkCandidateAvailability,
    dependencies.checkNeteaseProviderTrackAvailability
  );
});

test("sync audit rejects missing ids and preserves Error and non-Error 502 responses", timeout, async () => {
  let loadCalls = 0;
  const dependencies = createDependencies({
    loadNeteasePlaylistAuditEntries: async (playlistId) => {
      loadCalls += 1;
      if (playlistId === "known-error") {
        throw new Error("audit failed");
      }
      throw "audit failed";
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const missing = await requestJson("POST", "/api/playlist-transfer/netease-import-audit", { playlistId: 17 });
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { message: "缺少网易云歌单 ID。" });

    const known = await requestJson("POST", "/api/playlist-transfer/netease-import-audit", { playlistId: "known-error" });
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "audit failed" });

    const fallback = await requestJson("POST", "/api/playlist-transfer/netease-import-audit", { playlistId: "non-error" });
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "网易云导入歌单清理失败" });
  });

  assert.equal(loadCalls, 2);
});

test("job start keeps normalization, 202, and the 12s/8s dependency fallbacks", timeout, async (context) => {
  type StartInput = Parameters<NeteaseImportAuditRouterDependencies["startNeteaseImportAuditJob"]>[1];
  type StartDependencies = Parameters<NeteaseImportAuditRouterDependencies["startNeteaseImportAuditJob"]>[2];
  const owners: string[] = [];
  const inputs: StartInput[] = [];
  const startDependencies: StartDependencies[] = [];
  const sourceTrack: TransferTrack = { source: "netease", title: "歌曲", artists: ["歌手"] };
  const candidate: MatchCandidate = {
    provider: "netease",
    targetTrackId: "candidate-1",
    title: "歌曲",
    artists: ["歌手"],
    confidenceScore: 1,
    reasons: []
  };
  const dependencies = createDependencies({
    loadNeteasePlaylistAuditEntries: async () => [],
    searchNeteaseProviderTracksByTitle: async () => [{
      provider: "netease",
      id: "candidate-1",
      title: "歌曲",
      artists: ["歌手"]
    }],
    checkNeteaseProviderTrackAvailability: async () => ({ status: "vip_only", reason: "需要 VIP" }),
    startNeteaseImportAuditJob: (ownerKey, input, jobDependencies) => {
      owners.push(ownerKey);
      inputs.push(input);
      startDependencies.push(jobDependencies);
      return queuedJob;
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const explicit = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs?ownerKey=query-attacker", {
      playlistId: "  liked  ",
      playlistName: "  后台歌单  ",
      maxTracks: 1200.9,
      candidateLimit: 0,
      checkAvailability: true,
      ownerKey: "body-attacker"
    });
    assert.equal(explicit.status, 202);
    assert.deepEqual(explicit.body, { job: queuedJob });

    const defaults = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs", {
      playlistId: "liked-2",
      maxTracks: "invalid",
      candidateLimit: -4,
      checkAvailability: "true"
    });
    assert.equal(defaults.status, 202);
  });

  assert.deepEqual(owners, ["owner-a", "owner-a"]);

  assert.deepEqual(inputs, [
    {
      playlistId: "liked",
      playlistName: "后台歌单",
      maxTracks: 1000,
      candidateLimit: 5,
      checkAvailability: true
    },
    {
      playlistId: "liked-2",
      playlistName: "网易云歌单",
      maxTracks: 300,
      candidateLimit: 1,
      checkAvailability: false
    }
  ]);
  assert.equal(startDependencies[0].loadEntries, dependencies.loadNeteasePlaylistAuditEntries);
  assert.deepEqual(await startDependencies[0].searchCandidates(sourceTrack), [{
    provider: "netease",
    id: "candidate-1",
    title: "歌曲",
    artists: ["歌手"]
  }]);
  assert.deepEqual(await startDependencies[0].checkCandidateAvailability?.(candidate), {
    status: "vip_only",
    reason: "需要 VIP"
  });

  dependencies.searchNeteaseProviderTracksByTitle = async () => new Promise(() => {});
  dependencies.checkNeteaseProviderTrackAvailability = async () => new Promise(() => {});
  context.mock.timers.enable({ apis: ["setTimeout"] });

  let searchSettled = false;
  const searchFallback = startDependencies[0].searchCandidates(sourceTrack).then((result) => {
    searchSettled = true;
    return result;
  });
  context.mock.timers.tick(11_999);
  await Promise.resolve();
  assert.equal(searchSettled, false);
  context.mock.timers.tick(1);
  assert.deepEqual(await searchFallback, []);

  let availabilitySettled = false;
  const availabilityFallback = startDependencies[0].checkCandidateAvailability?.(candidate).then((result) => {
    availabilitySettled = true;
    return result;
  });
  assert.ok(availabilityFallback);
  context.mock.timers.tick(7_999);
  await Promise.resolve();
  assert.equal(availabilitySettled, false);
  context.mock.timers.tick(1);
  assert.equal(await availabilityFallback, null);
});

test("job start rejects a missing id before starting a job", timeout, async () => {
  await withTestRouter(
    [createNeteaseImportAuditRouter(createDependencies())],
    async ({ requestJson }) => {
      const response = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs", {
        playlistId: "  "
      });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: "缺少网易云歌单 ID。" });
    }
  );
});

test("job lookup and cancellation pass trusted owners with decoded ids", timeout, async () => {
  const calls = { get: [] as Array<[string, string]>, cancel: [] as Array<[string, string]> };
  const resolveOwner = createBackgroundJobOwnerResolver({
    getClientSessionId: () => "audit-client",
    getCredentials: async () => ({ neteaseCookie: "", qqMusicCookie: "verified-cookie" }),
    readVerifiedIdentityState: async () => ({
      session: { loggedIn: false, profile: null },
      qqMusicUin: "70001"
    })
  });
  const dependencies = createDependencies({
    getCurrentUserKey: resolveOwner,
    getNeteaseImportAuditJob: (ownerKey, id) => {
      calls.get.push([ownerKey, id]);
      return id === "missing" ? null : queuedJob;
    },
    cancelNeteaseImportAuditJob: (ownerKey, id) => {
      calls.cancel.push([ownerKey, id]);
      return id === "missing" ? null : { ...queuedJob, status: "cancelling" };
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ request, requestJson }) => {
    const found = await request(
      "/api/playlist-transfer/netease-import-audit/jobs/job%20id?ownerKey=attacker&dataScopeId=account%3Aqqmusic%3A99999&uin=99999&profile=victim&provider=qqmusic",
      {
        headers: {
          "x-owner-key": "header-attacker",
          "x-data-scope-id": "account:netease:header-attacker",
          "x-qq-uin": "88888"
        }
      }
    );
    assert.equal(found.status, 200);
    assert.deepEqual(found.body, { job: queuedJob });

    const cancelled = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/job%20id/cancel", {});
    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.body as { job: { status: string } }).job.status, "cancelling");

    const missingGet = await request("/api/playlist-transfer/netease-import-audit/jobs/missing");
    assert.equal(missingGet.status, 404);
    const missingCancel = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/missing/cancel", {});
    assert.equal(missingCancel.status, 404);
  });

  assert.deepEqual(calls, {
    get: [["account:qqmusic:70001", "job id"], ["account:qqmusic:70001", "missing"]],
    cancel: [["account:qqmusic:70001", "job id"], ["account:qqmusic:70001", "missing"]]
  });
});

test("all owner-protected audit routes return the same clear 4xx for identity failures", timeout, async () => {
  let jobCalls = 0;
  const router = createNeteaseImportAuditRouter(createDependencies({
    getCurrentUserKey: async () => {
      throw new Error("owner lookup failed");
    },
    startNeteaseImportAuditJob: () => {
      jobCalls += 1;
      return queuedJob;
    },
    getNeteaseImportAuditJob: () => {
      jobCalls += 1;
      return queuedJob;
    },
    cancelNeteaseImportAuditJob: () => {
      jobCalls += 1;
      return queuedJob;
    }
  }));
  await withTestRouter([router], async ({ request, requestJson }) => {
    const responses = await Promise.all([
      requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs", { playlistId: "liked" }),
      request("/api/playlist-transfer/netease-import-audit/jobs/job-1"),
      requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/job-1/cancel", {}),
      requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/job-1/export", {}),
      requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/job-1/import/playable", {})
    ]);
    for (const response of responses) {
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: "无法确认后台任务所属身份。" });
    }
  });
  assert.equal(jobCalls, 0);
});

test("export keeps completion gates, default format, and raw string format handling", timeout, async () => {
  const formats: string[] = [];
  const dependencies = createDependencies({
    getNeteaseImportAuditJob: (_ownerKey, id) => {
      if (id === "missing") return null;
      if (id === "running") return queuedJob;
      return completedJob;
    },
    formatNeteaseImportAuditJobExport: (_result, format) => {
      formats.push(format);
      return { filename: "audit.txt", contentType: "text/plain", content: "audit" };
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const missing = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/missing/export", {});
    assert.equal(missing.status, 404);
    const running = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/running/export", {});
    assert.equal(running.status, 400);

    const defaultFormat = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/done/export", { format: 12 });
    assert.equal(defaultFormat.status, 200);
    assert.deepEqual(defaultFormat.body, { filename: "audit.txt", contentType: "text/plain", content: "audit" });

    const rawFormat = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/done/export", { format: " yaml " });
    assert.equal(rawFormat.status, 200);
  });

  assert.deepEqual(formats, ["text", " yaml "]);
});

test("playable import keeps track filtering result, names, and non-negative skippedCount", timeout, async () => {
  const creates: Array<[string, string[]]> = [];
  const shortAudit = { ...audit, scannedCount: 1 };
  const dependencies = createDependencies({
    getNeteaseImportAuditJob: (_ownerKey, id) => id === "short"
      ? { ...completedJob, result: shortAudit }
      : completedJob,
    createNeteasePlaylistFromTrackIds: async (name, trackIds) => {
      creates.push([name, trackIds]);
      return {
        playlistId: "new-list",
        playlistName: name,
        playlistUrl: "https://music.163.com/playlist?id=new-list",
        addedCount: trackIds.length
      };
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const custom = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/done/import/playable", {
      name: "  正常合集  "
    });
    assert.equal(custom.status, 200);
    assert.equal((custom.body as { skippedCount: number }).skippedCount, 3);

    const bounded = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/short/import/playable", {
      name: "  "
    });
    assert.equal(bounded.status, 200);
    assert.equal((bounded.body as { skippedCount: number }).skippedCount, 0);
  });

  assert.deepEqual(creates, [
    ["正常合集", ["1001", "1002"]],
    ["我喜欢的音乐 - 正常歌曲", ["1001", "1002"]]
  ]);
});

test("playable import preserves missing, incomplete, empty, and provider failure responses", timeout, async () => {
  const emptyJob: NeteaseImportAuditJob = {
    ...completedJob,
    result: { ...audit, playableTrackIds: [] }
  };
  const dependencies = createDependencies({
    getNeteaseImportAuditJob: (_ownerKey, id) => {
      if (id === "missing") return null;
      if (id === "running") return queuedJob;
      if (id === "empty") return emptyJob;
      return completedJob;
    },
    createNeteasePlaylistFromTrackIds: async (name) => {
      if (name === "known") throw new Error("create failed");
      throw "create failed";
    }
  });

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ requestJson }) => {
    const cases = [
      ["missing", 404, "网易云导入歌单清理任务不存在。"],
      ["running", 400, "任务尚未完成，不能创建正常歌曲新歌单。"],
      ["empty", 400, "扫描结果里没有正常可播歌曲，不能创建新歌单。"]
    ] as const;
    for (const [id, status, message] of cases) {
      const response = await requestJson("POST", `/api/playlist-transfer/netease-import-audit/jobs/${id}/import/playable`, {});
      assert.equal(response.status, status);
      assert.deepEqual(response.body, { message });
    }

    const known = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/done/import/playable", { name: "known" });
    assert.equal(known.status, 400);
    assert.deepEqual(known.body, { message: "create failed" });

    const fallback = await requestJson("POST", "/api/playlist-transfer/netease-import-audit/jobs/done/import/playable", { name: "other" });
    assert.equal(fallback.status, 400);
    assert.deepEqual(fallback.body, { message: "创建正常歌曲新歌单失败" });
  });
});

test("all follow-up job operations hide foreign, missing, and legacy-unowned records behind the same 404", timeout, async () => {
  let currentOwner = "owner-a";
  let cancelMutations = 0;
  let formatCalls = 0;
  let playlistWrites = 0;
  const resolvedOwners: string[] = [];
  const dependencies = createDependencies({
    getCurrentUserKey: async () => {
      resolvedOwners.push(currentOwner);
      return currentOwner;
    },
    getNeteaseImportAuditJob: (ownerKey, id) => ownerKey === "owner-a" && id === "owned"
      ? completedJob
      : null,
    cancelNeteaseImportAuditJob: (ownerKey, id) => {
      if (ownerKey === "owner-a" && id === "owned") {
        cancelMutations += 1;
        return completedJob;
      }
      return null;
    },
    formatNeteaseImportAuditJobExport: () => {
      formatCalls += 1;
      return { filename: "audit.txt", contentType: "text/plain", content: "audit" };
    },
    createNeteasePlaylistFromTrackIds: async () => {
      playlistWrites += 1;
      return {
        playlistId: "new-list",
        playlistName: "正常歌曲",
        playlistUrl: "https://music.163.com/playlist?id=new-list",
        addedCount: 2
      };
    }
  });
  const notFound = { message: "网易云导入歌单清理任务不存在。" };

  await withTestRouter([createNeteaseImportAuditRouter(dependencies)], async ({ request, requestJson }) => {
    const owned = await request("/api/playlist-transfer/netease-import-audit/jobs/owned");
    assert.equal(owned.status, 200);

    currentOwner = "owner-b";
    const foreignRead = await request(
      "/api/playlist-transfer/netease-import-audit/jobs/owned?ownerKey=owner-a",
      { headers: { "x-owner-key": "owner-a" } }
    );
    const foreignCancel = await requestJson(
      "POST",
      "/api/playlist-transfer/netease-import-audit/jobs/owned/cancel?ownerKey=owner-a",
      { ownerKey: "owner-a" },
      { "x-owner-key": "owner-a" }
    );
    const foreignExport = await requestJson(
      "POST",
      "/api/playlist-transfer/netease-import-audit/jobs/owned/export",
      { format: "text", ownerKey: "owner-a" }
    );
    const foreignImport = await requestJson(
      "POST",
      "/api/playlist-transfer/netease-import-audit/jobs/owned/import/playable",
      { name: "越权歌单", ownerKey: "owner-a" }
    );

    for (const response of [foreignRead, foreignCancel, foreignExport, foreignImport]) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, notFound);
    }

    currentOwner = "owner-a";
    const missing = await request("/api/playlist-transfer/netease-import-audit/jobs/missing");
    const legacyUnowned = await request("/api/playlist-transfer/netease-import-audit/jobs/legacy-unowned");
    for (const response of [missing, legacyUnowned]) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, notFound);
    }
  });

  assert.deepEqual(resolvedOwners, ["owner-a", "owner-b", "owner-b", "owner-b", "owner-b", "owner-a", "owner-a"]);
  assert.equal(cancelMutations, 0);
  assert.equal(formatCalls, 0);
  assert.equal(playlistWrites, 0);
});

test("unknown paths, unsupported methods, and compare routes pass to later handlers", timeout, async () => {
  await withTestRouter(
    [createNeteaseImportAuditRouter(createDependencies())],
    async ({ request, requestJson }) => {
      const responses = [
        await requestJson("POST", "/api/playlist-transfer/netease-import-audit/unknown", {}),
        await request("/api/playlist-transfer/netease-import-audit"),
        await requestJson("POST", "/api/playlist-transfer/compare", {}),
        await request("/api/playlist-transfer/jobs")
      ];

      for (const response of responses) {
        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { message: "test fallback" });
      }
    }
  );
});
