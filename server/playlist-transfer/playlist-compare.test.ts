import assert from "node:assert/strict";
import test from "node:test";
import {
  comparePlaylists,
  formatPlaylistCompareExport,
  type PlaylistCompareResult
} from "./playlist-compare.js";
import {
  PLAYLIST_COMPARE_EXPORT_LIMITS,
  PlaylistCompareExportLimitError
} from "./playlist-compare-export-policy.js";
import type { TransferTrack } from "./types.js";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";

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

test("formatPlaylistCompareExport exports only selected rows and prefers the requested provider version", () => {
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
  });

  const qqOutput = formatPlaylistCompareExport(
    result,
    "text",
    ["same_title_different_artist"],
    { itemIndexes: [1], preferredProvider: "qq" }
  );
  const neteaseOutput = formatPlaylistCompareExport(
    result,
    "text",
    ["same_title_different_artist"],
    { itemIndexes: [1], preferredProvider: "netease" }
  );

  assert.match(qqOutput.content, /演员 - 林宥嘉 - 翻唱/);
  assert.doesNotMatch(qqOutput.content, /演员 - 薛之谦/);
  assert.match(neteaseOutput.content, /演员 - 薛之谦 - 初学者/);
  assert.doesNotMatch(neteaseOutput.content, /晴天 - 周杰伦/);
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

test("compare JSON formatter allowlists nested fields without changing filename, summary, or item order", () => {
  const secret = "compare-export-secret-sentinel";
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
  });
  Object.assign(result, { ownerKey: secret });
  Object.assign(result.left, { clientSessionId: secret });
  Object.assign(result.summary, { generation: secret });
  Object.assign(result.items[0], { cancelRequested: true });
  Object.assign(result.items[0].leftTrack!, { raw: { SID: secret, credentialDigest: secret } });

  const output = formatPlaylistCompareExport(result, "json", [
    "exact",
    "same_title_different_artist",
    "similar_title",
    "left_only",
    "right_only"
  ]);
  const parsed = JSON.parse(output.content) as {
    items: Array<{
      status: string;
      leftTrack?: { sourceTrackId?: string };
      rightTrack?: { sourceTrackId?: string };
    }>;
    summary: { totalLeft: number; totalRight: number };
  };

  assert.equal(output.filename, "左歌单-vs-右歌单-compare.json");
  assert.equal(output.contentType, "application/json; charset=utf-8");
  assertPublicDtoSafe(parsed, secret);
  assert.deepEqual(
    parsed.items.map((item) => [item.status, item.leftTrack?.sourceTrackId, item.rightTrack?.sourceTrackId]),
    result.items.map((item) => [item.status, item.leftTrack?.sourceTrackId, item.rightTrack?.sourceTrackId])
  );
  assert.deepEqual(parsed.summary, {
    totalLeft: result.summary.totalLeft,
    totalRight: result.summary.totalRight,
    exact: result.summary.exact,
    sameTitleDifferentArtist: result.summary.sameTitleDifferentArtist,
    similarTitle: result.summary.similarTitle,
    leftOnly: result.summary.leftOnly,
    rightOnly: result.summary.rightOnly
  });
});

function createLargeCompareResult(itemCount: number): PlaylistCompareResult {
  const item = {
    status: "exact" as const,
    leftTrack: leftTracks[0],
    rightTrack: rightTracks[0],
    score: 1,
    reasons: ["完全一致"]
  };
  return {
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", total: itemCount },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", total: itemCount },
    items: Array.from({ length: itemCount }, () => item),
    summary: {
      totalLeft: itemCount,
      totalRight: itemCount,
      exact: itemCount,
      sameTitleDifferentArtist: 0,
      similarTitle: 0,
      leftOnly: 0,
      rightOnly: 0
    },
    createdAt: "2026-07-27T00:00:00.000Z"
  };
}

function createTextBudgetResult(textBytes: number): PlaylistCompareResult {
  return {
    left: { provider: "netease", playlistName: "", total: 1 },
    right: { provider: "qq", playlistName: "", total: 0 },
    items: [{
      status: "left_only",
      leftTrack: { source: "netease", title: "x".repeat(textBytes), artists: [] },
      score: 0,
      reasons: []
    }],
    summary: {
      totalLeft: 1,
      totalRight: 0,
      exact: 0,
      sameTitleDifferentArtist: 0,
      similarTitle: 0,
      leftOnly: 1,
      rightOnly: 0
    },
    createdAt: ""
  };
}

test("compare formatter enforces shared collection limits for direct callers", () => {
  const atLimit = createLargeCompareResult(PLAYLIST_COMPARE_EXPORT_LIMITS.items);
  const withinLimit = formatPlaylistCompareExport(
    atLimit,
    "json",
    Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.statuses }, () => "exact"),
    { itemIndexes: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.itemIndexes }, () => 0) }
  );
  assert.equal(JSON.parse(withinLimit.content).items.length, 1);
  const largeText = formatPlaylistCompareExport(atLimit, "text", ["exact"]);
  assert.equal(largeText.content.split("晴天 - 周杰伦 - 叶惠美").length - 1, PLAYLIST_COMPARE_EXPORT_LIMITS.items);

  const nestedAtLimit = createLargeCompareResult(1);
  nestedAtLimit.items[0] = {
    ...nestedAtLimit.items[0],
    leftTrack: {
      ...nestedAtLimit.items[0].leftTrack!,
      artists: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.artistsPerTrack }, () => "歌手")
    },
    reasons: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.reasonsPerItem }, () => "原因")
  };
  assert.equal(formatPlaylistCompareExport(nestedAtLimit, "text", ["exact"]).contentType, "text/plain; charset=utf-8");
  assert.equal(
    formatPlaylistCompareExport(
      createTextBudgetResult(PLAYLIST_COMPARE_EXPORT_LIMITS.textBytes),
      "text",
      ["left_only"]
    ).contentType,
    "text/plain; charset=utf-8"
  );

  const overLimitCases: Array<{
    expectedResource: string;
    result: PlaylistCompareResult;
    statuses: Array<"exact">;
    itemIndexes?: number[];
  }> = [
    {
      expectedResource: "items",
      result: createLargeCompareResult(PLAYLIST_COMPARE_EXPORT_LIMITS.items + 1),
      statuses: ["exact"]
    },
    {
      expectedResource: "statuses",
      result: createLargeCompareResult(1),
      statuses: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.statuses + 1 }, () => "exact")
    },
    {
      expectedResource: "itemIndexes",
      result: createLargeCompareResult(1),
      statuses: ["exact"],
      itemIndexes: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.itemIndexes + 1 }, () => 0)
    },
    {
      expectedResource: "artistsPerTrack",
      result: {
        ...createLargeCompareResult(1),
        items: [{
          ...createLargeCompareResult(1).items[0],
          leftTrack: {
            ...leftTracks[0],
            artists: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.artistsPerTrack + 1 }, () => "歌手")
          }
        }]
      },
      statuses: ["exact"]
    },
    {
      expectedResource: "reasonsPerItem",
      result: {
        ...createLargeCompareResult(1),
        items: [{
          ...createLargeCompareResult(1).items[0],
          reasons: Array.from({ length: PLAYLIST_COMPARE_EXPORT_LIMITS.reasonsPerItem + 1 }, () => "原因")
        }]
      },
      statuses: ["exact"]
    },
    {
      expectedResource: "textBytes",
      result: createTextBudgetResult(PLAYLIST_COMPARE_EXPORT_LIMITS.textBytes + 1),
      statuses: ["exact"]
    }
  ];

  for (const testCase of overLimitCases) {
    assert.throws(
      () => formatPlaylistCompareExport(testCase.result, "json", testCase.statuses, {
        itemIndexes: testCase.itemIndexes
      }),
      (error) => error instanceof PlaylistCompareExportLimitError && error.resource === testCase.expectedResource
    );
  }
});

test("compare formatter keeps order and bounded duplicate-status semantics across all formats", () => {
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: leftTracks },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: rightTracks }
  });
  const formats = ["markdown", "text", "csv", "json"] as const;

  for (const format of formats) {
    const single = formatPlaylistCompareExport(result, format, ["exact"], { itemIndexes: [2, 0, 2] });
    const duplicate = formatPlaylistCompareExport(result, format, ["exact", "exact"], { itemIndexes: [2, 0, 2] });
    assert.equal(single.filename.endsWith(format === "markdown" ? ".md" : format === "text" ? ".txt" : `.${format}`), true);
    assert.match(single.contentType, format === "json" ? /^application\/json/ : format === "csv" ? /^text\/csv/ : format === "text" ? /^text\/plain/ : /^text\/markdown/);
    if (format === "markdown" || format === "text") {
      assert.equal(duplicate.content.split("晴天 - 周杰伦").length - 1, format === "markdown" ? 4 : 2);
    } else {
      assert.equal(duplicate.content, single.content);
    }
  }

  const ordered = createLargeCompareResult(3);
  ordered.items = ordered.items.map((item, index) => ({
    ...item,
    leftTrack: { ...item.leftTrack!, title: `左侧-${index}` },
    rightTrack: { ...item.rightTrack!, title: `右侧-${index}` }
  }));
  const selected = formatPlaylistCompareExport(ordered, "json", ["exact"], {
    itemIndexes: [2, 0, 2]
  });
  assert.deepEqual(
    JSON.parse(selected.content).items.map((item: { leftTrack: { title: string } }) => item.leftTrack.title),
    ["左侧-0", "左侧-2"]
  );
});
