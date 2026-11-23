import assert from "node:assert/strict";
import test from "node:test";
import { buildDownwardQualityOrder, isQualityDowngraded } from "./policies/quality-policy.js";
import {
  evaluateNeteaseAvailability,
  evaluateQqAvailability,
  parseOptionalNumber,
} from "./policies/song-availability.js";
import {
  comparePlaylistsAsync,
  hasArtistOverlap,
  matchTransferTrack,
  normalizeMatchText,
} from "./transfer/matcher.js";
import { formatTransferExport, parseCsvPlaylist, parseTextPlaylist } from "./transfer/text-and-csv.js";

test("parseOptionalNumber distinguishes null and empty string from 0", () => {
  assert.equal(parseOptionalNumber(null), null);
  assert.equal(parseOptionalNumber(undefined), null);
  assert.equal(parseOptionalNumber(""), null);
  assert.equal(parseOptionalNumber(0), 0);
  assert.equal(parseOptionalNumber("320000"), 320000);
});

test("evaluateNeteaseAvailability handles null pl/fee safely and separates paid albums", () => {
  // pl: null must NOT lock a free track as copyright unavailable
  const playable = evaluateNeteaseAvailability({ fee: 0, pl: null, dl: null, st: 0 });
  assert.equal(playable?.playback.status, "available");
  assert.equal(playable?.playback.locked, false);

  // fee: 4 with pl: 0 is paid_album, not copyright unavailable
  const paidAlbum = evaluateNeteaseAvailability({ fee: 4, pl: 0, dl: 0, st: 0 });
  assert.equal(paidAlbum?.playback.status, "paid_album");
  assert.equal(paidAlbum?.playback.locked, true);

  // Cloud tracks are never copyright locked
  const cloud = evaluateNeteaseAvailability({ fee: 1, pl: 0, st: -200, isCloud: true });
  assert.equal(cloud?.playback.status, "available");
});

test("evaluateQqAvailability prioritizes switch === 0 as copyright unavailable", () => {
  const noCopyright = evaluateQqAvailability({ actionSwitch: 0, payPlay: 1 });
  assert.equal(noCopyright?.playback.status, "copyright");
  assert.equal(noCopyright?.playback.locked, true);
});

test("buildDownwardQualityOrder never upgrades quality when requested tier is absent", () => {
  const order = buildDownwardQualityOrder("exhigh", ["hires", "lossless", "standard"]);
  assert.deepEqual(order, ["standard"]);
});

test("isQualityDowngraded compares quality tier rank before container extension (A05)", () => {
  // Hi-Res requested, ordinary lossless FLAC returned -> MUST report downgraded: true
  assert.equal(isQualityDowngraded("hires", { bitrate: 950_000, format: "flac", level: "lossless" }), true);
  // Hi-Res requested, Hi-Res FLAC returned -> not downgraded
  assert.equal(isQualityDowngraded("hires", { bitrate: 1_800_000, format: "flac", level: "hires" }), false);
  // 320K requested, 192K higher returned -> downgraded
  assert.equal(isQualityDowngraded("exhigh", { bitrate: 192_000, format: "mp3", level: "higher" }), true);
});

test("evaluateNeteaseAvailability ignores noCopyrightRcmd when playable (A08) and respects cp===0 VIP guardrail (C040)", () => {
  // A08: explicit playable privilege with informational noCopyrightRcmd must NOT be locked
  const playableWithHint = evaluateNeteaseAvailability({
    fee: 0,
    pl: 320000,
    dl: 320000,
    st: 0,
    noCopyrightRcmd: { type: 1, typeDesc: "可替换版本" },
  });
  assert.equal(playableWithHint?.playback.status, "available");
  assert.equal(playableWithHint?.playback.locked, false);

  // C040 guardrail: VIP track with pl > 0 and cp === 0 must remain VIP playable, NOT locked as copyright
  const vipPlayableCp0 = evaluateNeteaseAvailability({
    fee: 1,
    pl: 320000,
    dl: 320000,
    st: 0,
    cp: 0,
  });
  assert.equal(vipPlayableCp0?.playback.status, "vip");
  assert.equal(vipPlayableCp0?.playback.locked, false);

  // Auxiliary cp === 0 when pl is absent and non-VIP / non-paid-album marks copyright unavailable
  const noCopyrightCp0 = evaluateNeteaseAvailability({
    fee: 0,
    pl: null,
    dl: null,
    st: 0,
    cp: 0,
  });
  assert.equal(noCopyrightCp0?.playback.status, "copyright");
  assert.equal(noCopyrightCp0?.playback.locked, true);
});

test("matcher prevents parenthesized empty-title collision and single-char artist false positives", () => {
  assert.equal(normalizeMatchText("(Intro)"), "intro");
  assert.equal(hasArtistOverlap(["a"], ["adele"]), false);
  assert.equal(hasArtistOverlap(["周杰伦"], ["周杰伦"]), true);

  const result = matchTransferTrack({ source: "text", title: "(Intro)", artists: ["Artist X"] }, [
    { provider: "netease", id: "1", title: "(Outro)", artists: ["Artist X"] },
  ]);
  assert.notEqual(result.status, "matched");
});

test("CSV export and RFC4180 CSV parser round-trip titles with commas and quotes", () => {
  const exported = formatTransferExport(
    {
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "My List",
      summary: {
        total: 1,
        matched: 1,
        manualReview: 0,
        notFound: 0,
        unavailable: 0,
        duplicate: 0,
        skipped: 0,
      },
      results: [
        {
          sourceTrack: {
            source: "text",
            title: 'Hello, "World"',
            artists: ["Tyler, The Creator"],
            album: "Igor, Vol. 1",
          },
          status: "matched",
          candidates: [],
        },
      ],
    },
    "csv",
  );

  const parsed = parseCsvPlaylist(exported.content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.title, 'Hello, "World"');
  assert.deepEqual(parsed[0]?.artists, ["Tyler, The Creator"]);
  assert.equal(parsed[0]?.album, "Igor, Vol. 1");
});

test("parseTextPlaylist ignores markdown headers and preserves commas in artist names", () => {
  const tracks = parseTextPlaylist(`
# 歌单互转报告
目标：netease
1. EARFQUAKE - Tyler, The Creator - IGOR
2. 晴天 - 周杰伦
  `);
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0]?.title, "EARFQUAKE");
  assert.deepEqual(tracks[0]?.artists, ["Tyler, The Creator"]);
});

test("comparePlaylistsAsync accurately classifies exact, diff-artist, left-only and right-only", async () => {
  const result = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "1",
      playlistName: "L",
      tracks: [
        { source: "netease", title: "晴天", artists: ["周杰伦"] },
        { source: "netease", title: "平凡之路", artists: ["朴树"] },
        { source: "netease", title: "独占歌", artists: ["歌手甲"] },
      ],
    },
    right: {
      provider: "qq",
      playlistId: "2",
      playlistName: "R",
      tracks: [
        { source: "qq", title: "晴天", artists: ["周杰伦"] },
        { source: "qq", title: "平凡之路", artists: ["翻唱歌手"] },
        { source: "qq", title: "右侧独占", artists: ["歌手乙"] },
      ],
    },
  });

  assert.equal(result.summary.exact, 1);
  assert.equal(result.summary.sameTitleDifferentArtist, 1);
  assert.equal(result.summary.leftOnly, 1);
  assert.equal(result.summary.rightOnly, 1);
});
