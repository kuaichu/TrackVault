import assert from "node:assert/strict";
import test from "node:test";
import type { ImportAuditResult, Song, TransferResult } from "#shared";
import { AppError } from "../../domain/errors.js";
import type { ResolvedAudio } from "../../domain/ports/music-provider.js";
import { comparePlaylistsAsync } from "../../domain/transfer/playlist-comparator.js";
import { NeteaseAdapter } from "../../infrastructure/providers/netease/netease-adapter.js";
import {
  createServerTestHarness,
  createStubProviderAdapter,
  makeTestSong,
  makeTransferTrack,
  waitForJobTerminal,
} from "../../test-utils/fixtures.js";
import { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import { TransferService } from "./transfer-service.js";

function makeNeteaseDetailMockAdapter(totalTracks: number, missingDetailId?: number): NeteaseAdapter {
  const allIds = Array.from({ length: totalTracks }, (_, i) => i + 1);
  return new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: totalTracks,
            name: `${totalTracks} Playlist`,
            trackCount: totalTracks,
            trackIds: allIds.map((id) => ({ id })),
          },
        },
      }),
      song_detail: async ({ ids }) => ({
        body: {
          code: 200,
          songs: String(ids)
            .split(",")
            .map(Number)
            .filter((id) => id !== missingDetailId)
            .map((id) => ({
              id,
              name: `Track ${id}`,
              ar: [{ name: "Artist" }],
              dt: 180_000,
              al: { name: "Album" },
            })),
        },
      }),
    },
  });
}

test("comparePlaylistsAsync preserves duet/solo exact matching across orderings and separates Studio vs Live", async () => {
  const duet = makeTransferTrack("duet", "Echo", ["One", "Two"]);
  const one = makeTransferTrack("one", "Echo", ["One"]);
  const two = makeTransferTrack("two", "Echo", ["Two"]);

  const cmp1 = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: [duet, one] },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: [one, two] },
  });
  const cmp2 = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: [one, duet] },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: [one, two] },
  });
  assert.deepEqual([cmp1.summary.exact, cmp2.summary.exact], [2, 2]);

  const studioVsLive = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "L",
      playlistName: "L",
      tracks: [makeTransferTrack("1", "晴天", ["周杰伦"])],
    },
    right: {
      provider: "qq",
      playlistId: "R",
      playlistName: "R",
      tracks: [makeTransferTrack("2", "晴天 (Live)", ["周杰伦"])],
    },
  });
  assert.equal(studioVsLive.summary.exact, 0);
  assert.equal(studioVsLive.summary.similarTitle, 1);
});

test("comparePlaylistsAsync is invariant to arbitrary left and right permutations across all categories", async () => {
  const duet = makeTransferTrack("D", "Echo", ["甲", "乙"], { album: "Album", durationSeconds: 180 });
  const live = makeTransferTrack("L", "Echo (Live)", ["甲"], { album: "Album", durationSeconds: 180 });
  const other = makeTransferTrack("O", "Echo", ["丙"], { album: "Album", durationSeconds: 180 });
  const rA = makeTransferTrack("a", "Echo", ["甲"], { album: "Album", durationSeconds: 180 });
  const rB = makeTransferTrack("b", "Echo", ["乙"], { album: "Album", durationSeconds: 180 });
  const rC = makeTransferTrack("c", "Echo", ["丁"], { album: "Album", durationSeconds: 180 });

  const leftPerms = [
    [duet, live, other],
    [live, duet, other],
    [other, live, duet],
  ];
  const rightPerms = [
    [rA, rB, rC],
    [rB, rA, rC],
    [rC, rB, rA],
  ];

  let baseline: Awaited<ReturnType<typeof comparePlaylistsAsync>>["summary"] | null = null;
  for (const lTracks of leftPerms) {
    for (const rTracks of rightPerms) {
      const res = await comparePlaylistsAsync({
        left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: lTracks },
        right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: rTracks },
      });
      if (!baseline) {
        baseline = res.summary;
        assert.equal(baseline.exact, 1);
        assert.equal(baseline.similarTitle, 1);
        assert.equal(baseline.sameTitleDifferentArtist, 1);
      } else {
        assert.deepEqual(res.summary, baseline);
      }
    }
  }
});

test("TransferService and audit actively probe statically locked songs when checkAvailability is true", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-probe-locked-" });
  const probedIds: string[] = [];
  const lockedNetease = makeTestSong("netease", "vip-1", "VIP Locked Song", { locked: true });
  const lockedQq = makeTestSong("qq", "qq-vip-1", "VIP Locked Song", { locked: true });

  const resolvePlayable = async (target: { id: string }) => {
    probedIds.push(target.id);
    return {
      url: "https://m7.music.126.net/unlocked.mp3",
      format: "mp3",
      bitrate: 320_000,
      level: "exhigh" as const,
      durationSeconds: 180,
      trial: false,
      downgraded: false,
    };
  };

  harness.providers.register(
    createStubProviderAdapter("netease", {
      getAllPlaylistTracks: async () => [lockedNetease],
      getPlaylistTracks: async () => ({
        playlist: {
          id: "demo",
          platform: "netease",
          name: "Demo",
          trackCount: 1,
          creatorName: "U",
          owned: true,
        },
        songs: [lockedNetease],
        total: 1,
        page: 1,
        limit: 50,
        hasMore: false,
      }),
      searchTracks: async () => [],
      resolveAudio: resolvePlayable,
    }),
  );
  harness.providers.register(
    createStubProviderAdapter("qq", {
      searchTracks: async () => [lockedQq],
      resolveAudio: resolvePlayable,
    }),
  );

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const auditJob = service.startImportAuditJob(harness.actor, {
      playlistId: "demo",
      maxTracks: 10,
      candidateLimit: 2,
      checkAvailability: true,
    });
    const auditDone = await waitForJobTerminal(harness.jobs, harness.actor, auditJob.id);
    assert.equal((auditDone.result as ImportAuditResult).playableCount, 1);
    assert.deepEqual(probedIds, ["vip-1"]);

    probedIds.length = 0;
    const transferJob = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistId: "demo",
      checkAvailability: true,
    });
    const transferDone = await waitForJobTerminal(harness.jobs, harness.actor, transferJob.id);
    assert.equal((transferDone.result as TransferResult).summary.matched, 1);
    assert.deepEqual(probedIds, ["qq-vip-1"]);
  } finally {
    await harness.cleanup();
  }
});

test("TransferService and audit disclose probe timeout errors instead of treating timed-out tracks as playable", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-probe-timeout-" });
  const sourceSong = makeTestSong("netease", "n-timeout", "Timeout Song");
  const targetSong = makeTestSong("qq", "q-timeout", "Timeout Song");
  const throwTimeout = async (): Promise<ResolvedAudio> => {
    throw new AppError("UPSTREAM_TIMEOUT", "音源网关超时");
  };

  harness.providers.register(
    createStubProviderAdapter("netease", {
      getAllPlaylistTracks: async () => [sourceSong],
      resolveAudio: throwTimeout,
    }),
  );
  harness.providers.register(
    createStubProviderAdapter("qq", {
      searchTracks: async () => [targetSong],
      resolveAudio: throwTimeout,
    }),
  );

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const auditJob = service.startImportAuditJob(harness.actor, {
      playlistId: "pl-t09",
      maxTracks: 5,
      candidateLimit: 2,
      checkAvailability: true,
    });
    const auditDone = await waitForJobTerminal(harness.jobs, harness.actor, auditJob.id);
    const auditRes = auditDone.result as ImportAuditResult;
    assert.equal(auditRes.playableCount, 0);
    assert.equal(auditRes.issueCount, 1);
    assert.equal(auditRes.issues[0]?.issueType, "probe_error");
    assert.ok(auditRes.issues[0]?.reason.includes("音源实测未完成"));

    const transferJob = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistId: "pl-t09",
      checkAvailability: true,
    });
    const transferDone = await waitForJobTerminal(harness.jobs, harness.actor, transferJob.id);
    const transferRes = transferDone.result as TransferResult;
    assert.equal(transferRes.summary.matched, 0);
    assert.equal(transferRes.summary.manualReview, 1);
    assert.ok(transferRes.results[0]?.reason?.includes("音源实测未完成"));
  } finally {
    await harness.cleanup();
  }
});

test("TransferService promotes playable fallback on primary probe timeout and preserves vip_only when locked probe times out", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-probe-alt-" });
  let candidateMode: "alt-playable" | "locked-timeout" = "alt-playable";

  harness.providers.register(
    createStubProviderAdapter("netease", {
      getAllPlaylistTracks: async () => [makeTestSong("netease", "n-1", "Echo")],
    }),
  );
  harness.providers.register(
    createStubProviderAdapter("qq", {
      searchTracks: async () =>
        candidateMode === "alt-playable"
          ? [
              makeTestSong("qq", "first-timeout", "Echo"),
              makeTestSong("qq", "alt-playable", "Echo", { locked: true }),
            ]
          : [makeTestSong("qq", "locked-timeout", "Echo", { locked: true })],
      resolveAudio: async ({ id }) => {
        if (id === "first-timeout" || id === "locked-timeout") {
          throw new AppError("UPSTREAM_TIMEOUT", "Primary gateway timeout");
        }
        return {
          url: "https://ws.stream.qqmusic.qq.com/ok.mp3",
          format: "mp3",
          bitrate: 320_000,
          level: "exhigh",
          durationSeconds: 180,
          trial: false,
          downgraded: false,
        };
      },
    }),
  );

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const altJob = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistId: "pl-alt",
      checkAvailability: true,
    });
    const altDone = await waitForJobTerminal(harness.jobs, harness.actor, altJob.id);
    const altRes = altDone.result as TransferResult;
    assert.equal(altRes.results[0]?.status, "matched");
    assert.equal(altRes.results[0]?.selectedCandidate?.targetTrackId, "alt-playable");

    candidateMode = "locked-timeout";
    const lockedJob = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistId: "pl-locked-timeout",
      checkAvailability: true,
    });
    const lockedDone = await waitForJobTerminal(harness.jobs, harness.actor, lockedJob.id);
    const lockedRes = lockedDone.result as TransferResult;
    assert.equal(lockedRes.results[0]?.status, "vip_only");
    assert.ok(lockedRes.results[0]?.reason?.includes("音源实测未完成"));
  } finally {
    await harness.cleanup();
  }
});

test("TransferService probes past top-5 slice and auto-selects 6th playable candidate without misselecting unavailable ones", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-probe-six-" });
  const probedIds: string[] = [];
  let playableSixth = false;

  harness.providers.register(
    createStubProviderAdapter("qq", {
      getAllPlaylistTracks: async () => [makeTestSong("qq", "src-1", "Original Song")],
    }),
  );
  harness.providers.register(
    createStubProviderAdapter("netease", {
      searchTracks: async () =>
        Array.from({ length: 6 }, (_, idx) =>
          makeTestSong("netease", `ed-${idx + 1}`, "Original Song", {
            album: playableSixth && idx === 5 ? "Compilation" : "Demo",
          }),
        ),
      resolveAudio: async ({ id }) => {
        probedIds.push(id);
        if (playableSixth && id === "ed-6") {
          return {
            url: "https://m7.music.126.net/ed6.mp3",
            format: "mp3",
            bitrate: 320_000,
            level: "exhigh",
            durationSeconds: 200,
            trial: false,
            downgraded: false,
          };
        }
        throw new AppError("COPYRIGHT_UNAVAILABLE", "No copyright");
      },
    }),
  );

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const unavailJob = service.startTransferJob(harness.actor, {
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistId: "pl-6",
      checkAvailability: true,
    });
    const unavailDone = await waitForJobTerminal(harness.jobs, harness.actor, unavailJob.id);
    const unavailRes = unavailDone.result as TransferResult;
    assert.equal(probedIds.length, 6);
    assert.equal(unavailRes.results[0]?.status, "copyright_unavailable");

    playableSixth = true;
    probedIds.length = 0;
    const sixthJob = service.startTransferJob(harness.actor, {
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistId: "p-sixth",
      checkAvailability: true,
    });
    const sixthDone = await waitForJobTerminal(harness.jobs, harness.actor, sixthJob.id);
    const sixthRes = sixthDone.result as TransferResult;
    assert.equal(sixthRes.results[0]?.status, "matched");
    assert.equal(sixthRes.results[0]?.selectedCandidate?.targetTrackId, "ed-6");
  } finally {
    await harness.cleanup();
  }
});

test("TransferService deep-scans >1,000 selected IDs via getAllPlaylistTracks and discloses >10,000 cap omissions", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-scan-fallback-" });
  const largePlaylist: Song[] = Array.from({ length: 12_005 }, (_, idx) =>
    makeTestSong("netease", String(idx + 1), `Track ${idx + 1}`),
  );
  let currentPlaylist = largePlaylist.slice(0, 1001);

  harness.providers.register(
    createStubProviderAdapter("netease", {
      getAllPlaylistTracks: async (_id, _auth, max = 2000) => currentPlaylist.slice(0, max),
      getPlaylistTracks: async (id) => ({
        playlist: {
          id,
          platform: "netease",
          name: "Large",
          trackCount: currentPlaylist.length,
          creatorName: "U",
          owned: true,
        },
        songs: currentPlaylist.slice(0, 1),
        total: currentPlaylist.length,
        page: 1,
        limit: 1,
        hasMore: true,
      }),
    }),
  );

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const job1001 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "pl-1001",
      selectedSourceTrackIds: ["1", "1001"],
      checkAvailability: false,
    });
    const done1001 = await waitForJobTerminal(harness.jobs, harness.actor, job1001.id);
    const res1001 = done1001.result as TransferResult;
    assert.deepEqual(
      res1001.results.map((r) => r.sourceTrack.sourceTrackId),
      ["1", "1001"],
    );
    assert.equal(res1001.sourceTotal, 2);
    assert.equal(res1001.unprocessedCount, 0);
    assert.equal(res1001.truncated, false);
    assert.equal(res1001.scanStats?.truncated, false);

    currentPlaylist = largePlaylist;
    const job12005 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "pl-12005",
      selectedSourceTrackIds: ["1", "12005"],
      checkAvailability: false,
    });
    const done12005 = await waitForJobTerminal(harness.jobs, harness.actor, job12005.id);
    const res12005 = done12005.result as TransferResult;
    assert.deepEqual(
      res12005.results.map((r) => r.sourceTrack.sourceTrackId),
      ["1"],
    );
    assert.equal(res12005.sourceTotal, 2);
    assert.equal(res12005.unprocessedCount, 1);
    assert.equal(res12005.truncated, true);
    assert.equal(res12005.scanStats?.truncatedCount, 1);
  } finally {
    await harness.cleanup();
  }
});

test("TransferService deep-scans #2001 and discloses solo #12005 truncation cleanly with NeteaseAdapter", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-scan-ne-12k-" });
  const mockNe = makeNeteaseDetailMockAdapter(12_005, 500);
  harness.providers.register(mockNe);

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const job2001 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "12005",
      selectedSourceTrackIds: ["2001"],
      checkAvailability: false,
    });
    const done2001 = await waitForJobTerminal(harness.jobs, harness.actor, job2001.id);
    const res2001 = done2001.result as TransferResult;
    assert.deepEqual(
      res2001.results.map((r) => r.sourceTrack.sourceTrackId),
      ["2001"],
    );
    assert.equal(res2001.truncated, false);

    const job12005 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "12005",
      selectedSourceTrackIds: ["12005"],
      checkAvailability: false,
    });
    const done12005 = await waitForJobTerminal(harness.jobs, harness.actor, job12005.id);
    const res12005 = done12005.result as TransferResult;
    assert.deepEqual(res12005.results, []);
    assert.equal(res12005.sourceTotal, 1);
    assert.equal(res12005.unprocessedCount, 1);
    assert.equal(res12005.truncated, true);
    assert.equal(res12005.scanStats?.truncatedCount, 1);
  } finally {
    mockNe.close();
    await harness.cleanup();
  }
});

test("TransferService attributes missing song_detail #901 to missingDetailCount rather than 10,000 scan truncation", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-scan-missing-" });
  const mockNe2501 = makeNeteaseDetailMockAdapter(2501, 901);
  let mockNe10001: NeteaseAdapter | null = null;
  harness.providers.register(mockNe2501);

  try {
    const service = new TransferService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      jobs: harness.jobs,
    });

    const job2501 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "2501",
      selectedSourceTrackIds: ["901"],
      checkAvailability: false,
    });
    const done2501 = await waitForJobTerminal(harness.jobs, harness.actor, job2501.id);
    const res2501 = done2501.result as TransferResult;
    assert.equal(res2501.truncated, false);
    assert.equal(res2501.playlistTotal, 2501);
    assert.equal(res2501.sourceTotal, 1);
    assert.equal(res2501.unprocessedCount, 1);
    assert.equal(res2501.scanStats?.missingDetailCount, 1);
    assert.equal(/10000|10,000/.test(done2501.subtitle ?? ""), false);

    mockNe10001 = makeNeteaseDetailMockAdapter(10_001, 901);
    harness.providers.register(mockNe10001);
    const job10001 = service.startTransferJob(harness.actor, {
      sourceProvider: "netease",
      targetProvider: "netease",
      playlistId: "10001",
      selectedSourceTrackIds: ["901"],
      checkAvailability: false,
    });
    const done10001 = await waitForJobTerminal(harness.jobs, harness.actor, job10001.id);
    const res10001 = done10001.result as TransferResult;
    assert.equal(res10001.truncated, false);
    assert.equal(res10001.scanStats?.missingDetailCount, 1);
    assert.equal(res10001.scanStats?.truncatedCount, 0);
    assert.equal(/超出前/.test(done10001.subtitle ?? ""), false);
  } finally {
    mockNe2501.close();
    mockNe10001?.close();
    await harness.cleanup();
  }
});
