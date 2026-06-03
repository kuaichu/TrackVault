import assert from "node:assert/strict";
import test from "node:test";
import { comparePlaylists, formatPlaylistCompareExport } from "./playlist-compare.js";
import type { TransferTrack } from "./types.js";

const leftTracks: TransferTrack[] = [
  { source: "netease", sourceTrackId: "l1", title: "晴天", artists: ["周杰伦"], album: "叶惠美" },
  { source: "netease", sourceTrackId: "l2", title: "演员", artists: ["薛之谦"], album: "初学者" },
  { source: "netease", sourceTrackId: "l3", title: "雪龙吟", artists: ["张杰"], album: "雪龙吟" },
  { source: "netease", sourceTrackId: "l4", title: "左边独有", artists: ["A"] }
];

const rightTracks: TransferTrack[] = [
  { source: "qq", sourceTrackId: "r1", title: "晴天", artists: ["周杰伦"], album: "叶惠美" },
  { source: "qq", sourceTrackId: "r2", title: "演员", artists: ["林宥嘉"], album: "翻唱" },
  { source: "qq", sourceTrackId: "r3", title: "雪龙吟 (Live)", artists: ["张杰"], album: "现场版" },
  { source: "qq", sourceTrackId: "r4", title: "右边独有", artists: ["B"] }
];

test("comparePlaylists groups exact matches, same-title artist mismatches, similar titles, and side-only tracks", () => {
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
  });

  assert.equal(result.summary.exact, 1);
  assert.equal(result.summary.sameTitleDifferentArtist, 1);
  assert.equal(result.summary.similarTitle, 1);
  assert.equal(result.summary.leftOnly, 1);
  assert.equal(result.summary.rightOnly, 1);
  assert.equal(result.items[0].status, "exact");
  assert.equal(result.items[1].status, "same_title_different_artist");
  assert.equal(result.items[2].status, "similar_title");
});

test("formatPlaylistCompareExport creates a text playlist for selected comparison buckets", () => {
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
  });

  const output = formatPlaylistCompareExport(result, "text", ["same_title_different_artist", "left_only"]);

  assert.equal(output.contentType, "text/plain; charset=utf-8");
  assert.match(output.content, /演员 - 薛之谦/);
  assert.match(output.content, /左边独有 - A/);
  assert.doesNotMatch(output.content, /晴天 - 周杰伦/);
});

test("comparePlaylists reports progress while comparing left tracks", () => {
  const progress: Array<{ phase: string; processed: number; total: number; currentTitle?: string }> = [];

  comparePlaylists(
    {
      left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
      right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
    },
    {
      onProgress: (nextProgress) => {
        progress.push(nextProgress);
      }
    }
  );

  assert.equal(progress[0].phase, "comparing");
  assert.equal(progress[0].total, leftTracks.length);
  assert.ok(progress.some((item) => item.processed === 1 && item.currentTitle === "晴天"));
  assert.equal(progress[progress.length - 1].phase, "completed");
  assert.equal(progress[progress.length - 1].processed, leftTracks.length);
});
