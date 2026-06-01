import assert from "node:assert/strict";
import test from "node:test";
import { createPlaylistTransferJob } from "./service.js";
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
