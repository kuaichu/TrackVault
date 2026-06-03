import assert from "node:assert/strict";
import test from "node:test";
import { cancelNeteaseImportAuditJob, getNeteaseImportAuditJob, startNeteaseImportAuditJob } from "./netease-import-audit-job.js";

const unavailableTrack = {
  id: "song-1",
  name: "缺音源",
  ar: [{ name: "原歌手" }],
  noCopyrightRcmd: {
    typeDesc: "其它版本可播"
  }
};

async function waitForJob(id: string, status: "completed" | "cancelled" | "failed") {
  for (let index = 0; index < 20; index += 1) {
    const job = getNeteaseImportAuditJob(id);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`job did not reach ${status}`);
}

test("startNeteaseImportAuditJob runs in background and stores completed result", async () => {
  const job = startNeteaseImportAuditJob(
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      maxTracks: 10,
      candidateLimit: 3,
      checkAvailability: false
    },
    {
      loadEntries: async () => [
        {
          track: unavailableTrack,
          privilege: {
            id: "song-1",
            st: -200,
            pl: 0,
            dl: 0
          }
        }
      ],
      searchCandidates: async () => [
        {
          provider: "netease",
          id: "replacement",
          title: "缺音源",
          artists: ["替代歌手"]
        }
      ]
    }
  );

  assert.equal(job.status, "queued");
  const completed = await waitForJob(job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.scanned, 1);
  assert.equal(completed.result?.summary.replaceable, 1);
});

test("cancelNeteaseImportAuditJob marks running jobs for cancellation", async () => {
  const job = startNeteaseImportAuditJob(
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      maxTracks: 10,
      candidateLimit: 3,
      checkAvailability: false
    },
    {
      loadEntries: async () => [
        {
          track: unavailableTrack,
          privilege: {
            id: "song-1",
            st: -200,
            pl: 0,
            dl: 0
          }
        }
      ],
      searchCandidates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      }
    }
  );

  const cancelling = cancelNeteaseImportAuditJob(job.id);
  assert.equal(cancelling?.status, "cancelling");

  const cancelled = await waitForJob(job.id, "cancelled");
  assert.equal(cancelled.status, "cancelled");
});
