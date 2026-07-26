import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistCompareJob, startPlaylistCompareJob } from "./playlist-compare-job.js";
import type { TransferTrack } from "./types.js";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";

const leftTracks: TransferTrack[] = [
  { source: "netease", sourceTrackId: "l1", title: "晴天", artists: ["周杰伦"] },
  { source: "netease", sourceTrackId: "l2", title: "左边独有", artists: ["A"] }
];

const rightTracks: TransferTrack[] = [
  { source: "qq", sourceTrackId: "r1", title: "晴天", artists: ["周杰伦"] },
  { source: "qq", sourceTrackId: "r2", title: "右边独有", artists: ["B"] }
];

const compareInput = {
  leftProvider: "netease" as const,
  leftPlaylistId: "left",
  leftPlaylistName: "左歌单",
  rightProvider: "qq" as const,
  rightPlaylistId: "right",
  rightPlaylistName: "右歌单"
};

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nextEventLoopTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForCompareJob(ownerKey: string, id: string) {
  for (let index = 0; index < 30; index += 1) {
    const job = getPlaylistCompareJob(ownerKey, id);
    if (job?.status === "completed" || job?.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("compare job did not finish");
}

test("startPlaylistCompareJob updates progress and stores completed result", async () => {
  const bothLoadsStarted = createDeferred();
  const releaseLoads = createDeferred();
  let loadCount = 0;
  const job = startPlaylistCompareJob(
    "owner-a",
    compareInput,
    {
      loadSideTracks: async (provider) => {
        loadCount += 1;
        if (loadCount === 2) {
          bothLoadsStarted.resolve();
        }
        await releaseLoads.promise;
        return provider === "netease" ? leftTracks : rightTracks;
      }
    }
  );

  assert.equal(job.status, "queued");
  assert.equal("ownerKey" in job, false);
  assert.equal(getPlaylistCompareJob("owner-b", job.id), null);

  await bothLoadsStarted.promise;
  assert.equal(getPlaylistCompareJob("owner-a", job.id)?.status, "loading");
  releaseLoads.resolve();
  await nextEventLoopTurn();

  const completed = getPlaylistCompareJob("owner-a", job.id);

  assert.equal(completed?.status, "completed");
  assert.equal(completed?.progress.phase, "completed");
  assert.equal(completed?.progress.processed, leftTracks.length);
  assert.equal(completed?.result?.summary.exact, 1);
  assert.equal(completed?.result?.summary.leftOnly, 1);
  assert.equal(completed?.result?.summary.rightOnly, 1);
  assert.equal(getPlaylistCompareJob("owner-b", job.id), null);
  assert.equal(getPlaylistCompareJob("owner-a", "missing"), null);
  assert.deepEqual(getPlaylistCompareJob("owner-a", job.id), completed);
  assert.notEqual(getPlaylistCompareJob("owner-a", job.id), completed);
});

test("compare jobs return detached deep public DTOs at start and after completion", async () => {
  const secret = "compare-job-secret-sentinel";
  const privateLeft = [{
    source: "netease" as const,
    sourceTrackId: "private-left",
    title: "同一首歌",
    artists: ["歌手"],
    raw: { credentialDigest: secret },
    ownerKey: secret
  }];
  const privateRight = [{
    source: "qq" as const,
    sourceTrackId: "private-right",
    title: "同一首歌",
    artists: ["歌手"],
    clientSessionId: secret
  }];
  const input = Object.assign({ ...compareInput }, { ownerKey: secret, generation: 3 });
  const started = startPlaylistCompareJob("owner-private", input, {
    loadSideTracks: async (provider) => provider === "netease" ? privateLeft : privateRight
  });

  assert.equal(started.status, "queued");
  assertPublicDtoSafe(started, secret);
  const completed = await waitForCompareJob("owner-private", started.id);
  assert.equal(started.status, "queued", "a returned start DTO must not grow the internal result later");

  assert.equal(completed?.status, "completed");
  assert.ok(completed?.result);
  assertPublicDtoSafe(completed, secret);
  completed.result.items[0].leftTrack?.artists.push("公共突变");
  const reread = getPlaylistCompareJob("owner-private", started.id);
  assert.deepEqual(reread?.result?.items[0].leftTrack?.artists, ["歌手"]);
  assert.equal(privateLeft[0].raw.credentialDigest, secret);
});

test("legacy ownerless jobs remain inaccessible to every identity", async () => {
  const job = startPlaylistCompareJob("", compareInput, {
    loadSideTracks: async () => []
  });

  assert.equal(getPlaylistCompareJob("owner-a", job.id), null);
  assert.equal(getPlaylistCompareJob("owner-b", job.id), null);
  assert.equal(getPlaylistCompareJob("", job.id), null);

  await nextEventLoopTurn();
});

test("failed compare jobs expose only the stable action error", async () => {
  const secret = "compare-job-error-secret-sentinel";
  const started = startPlaylistCompareJob("owner-failure", compareInput, {
    loadSideTracks: async () => {
      throw Object.assign(new Error(secret), { cause: { credential: secret } });
    }
  });

  const failed = await waitForCompareJob("owner-failure", started.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "歌单对比失败");
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
  assert.equal(failed && "stack" in failed, false);
  assert.equal(failed && "cause" in failed, false);
});
