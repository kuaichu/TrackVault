import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistTransferRunJob, startPlaylistTransferRunJob } from "./playlist-transfer-job.js";
import type { PlaylistTransferJob } from "./types.js";

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
  let persistedJob: PlaylistTransferJob | undefined;
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
                artists: ["方山厨子Rex"],
                raw: { credentialDigest: "provider-secret" }
              }
            ]
          : []
      ),
      saveJob: async (nextJob) => {
        persistedJob = nextJob;
        return nextJob;
      }
    }
  );

  assert.equal(job.status, "queued");

  const completed = await waitForJob("session:test", job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.phase, "completed");
  assert.equal(completed.progress.processed, 2);
  assert.equal(completed.result?.summary.matched, 1);
  assert.equal(completed.result?.summary.notFound, 1);
  assert.equal(persistedJob?.ownerKey, "session:test");
  assert.deepEqual(persistedJob?.tracks[0]?.candidates[0]?.raw, { credentialDigest: "provider-secret" });
  assert.doesNotMatch(JSON.stringify(completed.result), /ownerKey|credentialDigest|\"raw\"/);
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
    clientSessionId: "secret-client-session",
    dataScopeId: "account:netease:attacker",
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
  assert.equal("clientSessionId" in job.input, false);
  assert.equal("dataScopeId" in job.input, false);
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

test("failed progress jobs expose only the stable action error", async () => {
  const secret = "transfer-job-error-secret-sentinel";
  const job = startPlaylistTransferRunJob(
    {
      ownerKey: "session:failure",
      sourceProvider: "text",
      targetProvider: "netease",
      text: "失败歌曲 - 歌手"
    },
    {
      searchTargetTracks: async () => {
        throw Object.assign(new Error(secret), { cause: { token: secret } });
      },
      saveJob: async (nextJob) => nextJob
    }
  );

  const failed = await waitForJob("session:failure", job.id, "failed");
  assert.equal(failed.error, "歌单互转失败");
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(secret));
  assert.equal("stack" in failed, false);
  assert.equal("cause" in failed, false);
});

test("empty playlist sources become failed progress jobs instead of completed 0/0", async () => {
  const job = startPlaylistTransferRunJob(
    { ownerKey: "session:empty", sourceProvider: "qq", targetProvider: "netease", playlistId: "empty" },
    { loadSourceTracks: async () => [], searchTargetTracks: async () => [], saveJob: async (nextJob) => nextJob }
  );
  const failed = await waitForJob("session:empty", job.id, "failed");
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, undefined);
});
