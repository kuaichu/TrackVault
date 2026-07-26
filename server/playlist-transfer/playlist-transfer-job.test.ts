import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistTransferRunJob, startPlaylistTransferRunJob } from "./playlist-transfer-job.js";

async function waitForJob(ownerKey: string, id: string, status: "completed" | "failed") {
  for (let index = 0; index < 20; index += 1) {
    const job = getPlaylistTransferRunJob(ownerKey, id);
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

  const completed = await waitForJob("session:test", job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.phase, "completed");
  assert.equal(completed.progress.processed, 2);
  assert.equal(completed.result?.summary.matched, 1);
  assert.equal(completed.result?.summary.notFound, 1);
});

test("progress jobs remain bound to their server owner while running", async () => {
  let markSearchStarted!: () => void;
  let releaseSearch!: () => void;
  const searchStarted = new Promise<void>((resolve) => {
    markSearchStarted = resolve;
  });
  const searchGate = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const input = {
    ownerKey: "session:owner-a",
    sourceProvider: "text" as const,
    targetProvider: "netease" as const,
    playlistName: "归属隔离",
    text: "非我 - 方山厨子Rex"
  };
  const job = startPlaylistTransferRunJob(input, {
    searchTargetTracks: async () => {
      markSearchStarted();
      await searchGate;
      return [];
    },
    saveJob: async (nextJob) => nextJob
  });

  await searchStarted;
  input.ownerKey = "session:owner-b";

  assert.equal("ownerKey" in job.input, false);
  assert.equal(getPlaylistTransferRunJob("session:owner-a", job.id), job);
  assert.equal(getPlaylistTransferRunJob("session:owner-b", job.id), null);
  assert.equal(getPlaylistTransferRunJob("session:owner-a", "missing"), null);

  releaseSearch();
  const completed = await waitForJob("session:owner-a", job.id, "completed");
  assert.equal(completed.result && "ownerKey" in completed.result, false);
  assert.equal(getPlaylistTransferRunJob("session:owner-b", job.id), null);
});

test("legacy ownerless progress jobs fail closed", () => {
  const job = startPlaylistTransferRunJob(
    {
      ownerKey: "",
      sourceProvider: "text",
      targetProvider: "netease",
      text: "旧任务 - 未知歌手"
    },
    {
      searchTargetTracks: async () => [],
      saveJob: async (nextJob) => nextJob
    }
  );

  assert.equal(getPlaylistTransferRunJob("session:owner-a", job.id), null);
  assert.equal(getPlaylistTransferRunJob("", job.id), null);
});
