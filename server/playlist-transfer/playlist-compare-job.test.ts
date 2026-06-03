import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistCompareJob, startPlaylistCompareJob } from "./playlist-compare-job.js";
import type { TransferTrack } from "./types.js";

const leftTracks: TransferTrack[] = [
  { source: "netease", sourceTrackId: "l1", title: "晴天", artists: ["周杰伦"] },
  { source: "netease", sourceTrackId: "l2", title: "左边独有", artists: ["A"] }
];

const rightTracks: TransferTrack[] = [
  { source: "qq", sourceTrackId: "r1", title: "晴天", artists: ["周杰伦"] },
  { source: "qq", sourceTrackId: "r2", title: "右边独有", artists: ["B"] }
];

async function waitForJob(id: string, status: "completed" | "failed") {
  for (let index = 0; index < 20; index += 1) {
    const job = getPlaylistCompareJob(id);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`job did not reach ${status}`);
}

test("startPlaylistCompareJob updates progress and stores completed result", async () => {
  const job = startPlaylistCompareJob(
    {
      leftProvider: "netease",
      leftPlaylistId: "left",
      leftPlaylistName: "左歌单",
      rightProvider: "qq",
      rightPlaylistId: "right",
      rightPlaylistName: "右歌单"
    },
    {
      loadSideTracks: async (provider) => (provider === "netease" ? leftTracks : rightTracks)
    }
  );

  assert.equal(job.status, "queued");

  const completed = await waitForJob(job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.phase, "completed");
  assert.equal(completed.progress.processed, leftTracks.length);
  assert.equal(completed.result?.summary.exact, 1);
  assert.equal(completed.result?.summary.leftOnly, 1);
  assert.equal(completed.result?.summary.rightOnly, 1);
});
