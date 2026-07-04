import assert from "node:assert/strict";
import test from "node:test";
import { createPlaylistTransferJob, getNeteaseImportTrackIds } from "./service.js";
import type { ProviderTrack } from "./types.js";

test("createPlaylistTransferJob parses text input and summarizes matched songs", async () => {
  const candidates: ProviderTrack[] = [
    {
      provider: "netease",
      id: "n1",
      title: "非我",
      artists: ["方山厨子Rex"],
      album: "非我"
    }
  ];

  const job = await createPlaylistTransferJob(
    {
      ownerKey: "session:test",
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "文字歌单",
      text: "非我 - 方山厨子Rex - 非我"
    },
    {
      searchTargetTracks: async () => candidates,
      saveJob: async (nextJob) => nextJob
    }
  );

  assert.equal(job.playlistName, "文字歌单");
  assert.equal(job.summary.total, 1);
  assert.equal(job.summary.matched, 1);
  assert.equal(job.tracks[0].selectedCandidate?.targetTrackId, "n1");
});

test("createPlaylistTransferJob marks duplicate imported songs", async () => {
  const job = await createPlaylistTransferJob(
    {
      ownerKey: "session:test",
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "重复歌单",
      text: "非我 - 方山厨子Rex\n非我 - 方山厨子Rex"
    },
    {
      searchTargetTracks: async () => [
        {
          provider: "netease",
          id: "n1",
          title: "非我",
          artists: ["方山厨子Rex"]
        }
      ],
      saveJob: async (nextJob) => nextJob
    }
  );

  assert.equal(job.summary.total, 2);
  assert.equal(job.summary.matched, 1);
  assert.equal(job.summary.duplicate, 1);
  assert.equal(job.tracks[1].status, "duplicate");
});

test("createPlaylistTransferJob filters provider playlist tracks by selected source ids", async () => {
  const job = await createPlaylistTransferJob(
    {
      ownerKey: "session:test",
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistName: "部分迁移",
      playlistId: "qq:demo",
      sourceTrackIds: ["qq-song-2"]
    },
    {
      loadSourceTracks: async () => [
        { source: "qq", sourceTrackId: "qq-song-1", title: "第一首", artists: ["歌手A"] },
        { source: "qq", sourceTrackId: "qq-song-2", title: "第二首", artists: ["歌手B"] }
      ],
      searchTargetTracks: async (track) => [
        {
          provider: "netease",
          id: `netease-${track.sourceTrackId}`,
          title: track.title,
          artists: track.artists
        }
      ],
      saveJob: async (nextJob) => nextJob
    }
  );

  assert.equal(job.summary.total, 1);
  assert.equal(job.tracks[0].sourceTrack.sourceTrackId, "qq-song-2");
  assert.equal(job.tracks[0].selectedCandidate?.targetTrackId, "netease-qq-song-2");
});

test("createPlaylistTransferJob reports progress while matching songs", async () => {
  const progress: Array<{ phase: string; processed: number; total: number; currentTitle?: string }> = [];

  await createPlaylistTransferJob(
    {
      ownerKey: "session:test",
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "进度歌单",
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
      saveJob: async (nextJob) => nextJob,
      onProgress: (nextProgress) => {
        progress.push(nextProgress);
      }
    }
  );

  assert.equal(progress[0].phase, "loading");
  assert.ok(progress.some((item) => item.phase === "matching" && item.total === 2));
  assert.ok(progress.some((item) => item.phase === "matching" && item.processed === 1 && item.currentTitle === "非我"));
  assert.ok(progress.some((item) => item.phase === "saving" && item.processed === 2));
  assert.equal(progress[progress.length - 1].phase, "completed");
  assert.equal(progress[progress.length - 1].processed, 2);
});

test("getNeteaseImportTrackIds returns unique matched netease candidate ids", () => {
  const ids = getNeteaseImportTrackIds({
    id: "job-1",
    ownerKey: "session:test",
    sourceProvider: "text",
    targetProvider: "netease",
    playlistName: "导入测试",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    summary: {
      total: 3,
      matched: 2,
      manualReview: 0,
      notFound: 1,
      unavailable: 0,
      duplicate: 0,
      skipped: 0
    },
    tracks: [
      {
        sourceTrack: { source: "text", title: "非我", artists: ["方山厨子Rex"] },
        status: "matched",
        candidates: [],
        selectedCandidate: {
          provider: "netease",
          targetTrackId: "1",
          title: "非我",
          artists: ["方山厨子Rex"],
          confidenceScore: 100,
          reasons: []
        }
      },
      {
        sourceTrack: { source: "text", title: "非我", artists: ["方山厨子Rex"] },
        status: "matched",
        candidates: [],
        selectedCandidate: {
          provider: "netease",
          targetTrackId: "1",
          title: "非我",
          artists: ["方山厨子Rex"],
          confidenceScore: 100,
          reasons: []
        }
      },
      {
        sourceTrack: { source: "text", title: "缺失歌", artists: ["未知歌手"] },
        status: "not_found",
        candidates: []
      }
    ]
  });

  assert.deepEqual(ids, ["1"]);
});
