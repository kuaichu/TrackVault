import assert from "node:assert/strict";
import test from "node:test";
import { filterTransferTracks, getCompletedTransferImportName, getDefaultTransferPlaylistName, getDefaultTransferResultFilter, resolveTransferImportName, type TransferResultFilter } from "./playlist-transfer-results.js";
import type { PlaylistTransferJob, TransferTrackResult, TransferTrackStatus } from "./types.js";

const statuses: TransferTrackStatus[] = ["matched", "manual_review", "metadata_conflict", "not_found", "copyright_unavailable", "vip_only", "trial_only", "duplicate", "skipped"];
const tracks = statuses.map((status, index): TransferTrackResult => ({
  status,
  sourceTrack: { source: "qq", sourceTrackId: String(index), title: status, artists: ["artist"] },
  candidates: []
}));

test("transfer result filters map every requested category", () => {
  const expected: Record<TransferResultFilter, TransferTrackStatus[]> = {
    all: statuses,
    matched: ["matched"],
    review: ["manual_review", "metadata_conflict"],
    not_found: ["not_found"],
    restricted: ["copyright_unavailable", "vip_only", "trial_only"],
    duplicate: ["duplicate"]
  };
  for (const [filter, wanted] of Object.entries(expected)) {
    assert.deepEqual(filterTransferTracks(tracks, filter as TransferResultFilter).map((track) => track.status), wanted);
  }
});

test("review filter never truncates items after the first 80 tracks", () => {
  const manyTracks = Array.from({ length: 90 }, (_, index): TransferTrackResult => ({
    status: index < 80 ? "matched" : "manual_review",
    sourceTrack: { source: "qq", sourceTrackId: String(index), title: `track-${index}`, artists: [] },
    candidates: []
  }));
  assert.equal(filterTransferTracks(manyTracks, "review").length, 10);
});

test("completed result defaults to review only when review items exist", () => {
  const job = { summary: { manualReview: 2 } } as PlaylistTransferJob;
  assert.equal(getDefaultTransferResultFilter(job), "review");
  assert.equal(getDefaultTransferResultFilter({ summary: { manualReview: 0 } } as PlaylistTransferJob), "all");
});

test("playlist naming keeps the source name and preserves a manual import name", () => {
  assert.equal(getDefaultTransferPlaylistName("  来源歌单  "), "来源歌单");
  assert.equal(resolveTransferImportName("来源歌单", "转换后的歌单"), "来源歌单");
  assert.equal(resolveTransferImportName("来源歌单", "  我的手工名称  "), "我的手工名称");
  assert.equal(getCompletedTransferImportName("来源歌单", "我的手工名称", true), "我的手工名称");
  assert.equal(getCompletedTransferImportName("来源歌单", "旧自动名称", false), "来源歌单");
});
