import assert from "node:assert/strict";
import test from "node:test";
import { formatTransferExport } from "./export-formatters.js";
import type { PlaylistTransferJob } from "./types.js";

const job: PlaylistTransferJob = {
  id: "job-1",
  ownerKey: "session:test",
  sourceProvider: "netease",
  targetProvider: "qq",
  playlistName: "旧收藏",
  tracks: [
    {
      sourceTrack: {
        source: "netease",
        sourceTrackId: "n1",
        title: "非我",
        artists: ["方山厨子Rex"],
        album: "非我"
      },
      status: "matched",
      candidates: [
        {
          provider: "qq",
          targetTrackId: "q1",
          title: "非我",
          artists: ["方山厨子Rex"],
          album: "非我",
          confidenceScore: 100,
          reasons: ["歌名完全一致", "歌手匹配"]
        }
      ],
      selectedCandidate: {
        provider: "qq",
        targetTrackId: "q1",
        title: "非我",
        artists: ["方山厨子Rex"],
        album: "非我",
        confidenceScore: 100,
        reasons: ["歌名完全一致", "歌手匹配"]
      }
    },
    {
      sourceTrack: {
        source: "netease",
        sourceTrackId: "n2",
        title: "缺失歌",
        artists: ["未知歌手"]
      },
      status: "not_found",
      candidates: [],
      reason: "目标平台未找到候选歌曲"
    }
  ],
  summary: {
    total: 2,
    matched: 1,
    manualReview: 0,
    notFound: 1,
    unavailable: 0,
    duplicate: 0,
    skipped: 0
  },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z"
};

test("formatTransferExport creates a markdown report with matched and missing sections", () => {
  const output = formatTransferExport(job, "markdown");

  assert.match(output.content, /# 旧收藏 歌单互转报告/);
  assert.match(output.content, /## 已匹配/);
  assert.match(output.content, /非我 - 方山厨子Rex/);
  assert.match(output.content, /## 未找到/);
  assert.match(output.content, /缺失歌 - 未知歌手/);
});
