import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistTransferRunJob, startPlaylistTransferRunJob } from "./playlist-transfer-job.js";

async function waitForJob(id: string, status: "completed" | "failed") {
  for (let index = 0; index < 20; index += 1) {
    const job = getPlaylistTransferRunJob(id);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`job did not reach ${status}`);
}

test("startPlaylistTransferRunJob updates progress and stores completed result", async () => {
  const job = startPlaylistTransferRunJob(
    {
      ownerKey: "session:test",
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "进度转换",
      text: "非我 - 方山厨子Rex\n缺失歌 - 未知歌手"
    },
    {
      searchTargetTracks: async (track) => (
        track.title === "非我"
          ? [
              {
                provider: "netease",
                id: "n1",
                title: "非我",
                artists: ["方山厨子Rex"]
              }
            ]
          : []
      ),
      saveJob: async (nextJob) => nextJob
    }
  );

  assert.equal(job.status, "queued");

  const completed = await waitForJob(job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.phase, "completed");
  assert.equal(completed.progress.processed, 2);
  assert.equal(completed.result?.summary.matched, 1);
  assert.equal(completed.result?.summary.notFound, 1);
});
