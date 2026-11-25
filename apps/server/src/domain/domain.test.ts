import assert from "node:assert/strict";
import test from "node:test";
import { buildDownwardQualityOrder, isQualityDowngraded } from "./policies/quality-policy.js";
import {
  evaluateNeteaseAvailability,
  evaluateQqAvailability,
  parseOptionalNumber,
} from "./policies/song-availability.js";
import { comparePlaylistsAsync } from "./transfer/playlist-comparator.js";
import {
  formatImportAuditExport,
  formatTransferExport,
  parseCsvPlaylist,
  parseCsvPlaylistWithStats,
  parseTextPlaylist,
  parseTextPlaylistWithStats,
} from "./transfer/text-and-csv.js";
import { matchTransferTrack } from "./transfer/track-matcher.js";
import { buildTransferDedupKey, hasArtistOverlap, normalizeMatchText } from "./transfer/track-normalizer.js";

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

test("buildTransferDedupKey prefers sourceTrackId and preserves version qualifiers (T03)", () => {
  const studio = buildTransferDedupKey({
    source: "netease",
    sourceTrackId: "101",
    title: "晴天",
    artists: ["周杰伦"],
  });
  const live = buildTransferDedupKey({
    source: "netease",
    sourceTrackId: "202",
    title: "晴天 (Live)",
    artists: ["周杰伦"],
  });
  assert.notEqual(studio, live);
  assert.equal(studio, "netease:101");

  // Without sourceTrackId, studio vs Live must remain distinct while identical tracks collapse
  const textStudio = buildTransferDedupKey({
    source: "text",
    title: "晴天",
    artists: ["周杰伦"],
  });
  const textLive = buildTransferDedupKey({
    source: "text",
    title: "晴天 (Live)",
    artists: ["周杰伦"],
  });
  assert.notEqual(textStudio, textLive);
  assert.equal(textStudio, buildTransferDedupKey({ source: "text", title: "  晴天 ", artists: ["周杰伦"] }));
});

test("matcher rejects unrelated titles, tie-breaks playable candidates, penalizes version mismatches, and tightens artist overlap (T07/T08/C026)", () => {
  // T07: Same artist with completely unrelated title must be not_found, NEVER copyright_unavailable
  const unrelated = matchTransferTrack({ source: "text", title: "Blue", artists: ["Artist A"] }, [
    {
      provider: "qq",
      id: "q1",
      title: "Mars",
      artists: ["Artist A"],
      availability: "copyright_unavailable",
    },
  ]);
  assert.equal(unrelated.status, "not_found");
  assert.equal(unrelated.selectedCandidate, undefined);

  // T08: Equal-score playable candidate beats copyright_unavailable
  const tieBreak = matchTransferTrack(
    { source: "text", title: "七里香", artists: ["周杰伦"], album: "七里香" },
    [
      {
        provider: "qq",
        id: "unavail",
        title: "七里香",
        artists: ["周杰伦"],
        album: "七里香",
        availability: "copyright_unavailable",
      },
      {
        provider: "qq",
        id: "playable",
        title: "七里香",
        artists: ["周杰伦"],
        album: "七里香",
        availability: "playable",
      },
    ],
  );
  assert.equal(tieBreak.status, "matched");
  assert.equal(tieBreak.selectedCandidate?.targetTrackId, "playable");

  // C026: Original studio track must NOT auto-match an instrumental or Live track with 100 pts
  const vsInstrumental = matchTransferTrack({ source: "text", title: "晴天", artists: ["周杰伦"] }, [
    {
      provider: "qq",
      id: "inst",
      title: "晴天 (伴奏)",
      artists: ["周杰伦"],
      availability: "playable",
    },
  ]);
  assert.notEqual(vsInstrumental.status, "matched");
  assert.ok((vsInstrumental.candidates[0]?.confidenceScore ?? 0) < 70);

  const vsBracketInst = matchTransferTrack({ source: "text", title: "Halo", artists: ["Beyonce"] }, [
    {
      provider: "qq",
      id: "inst-en",
      title: "Halo [Instrumental]",
      artists: ["Beyonce"],
      availability: "playable",
    },
  ]);
  assert.notEqual(vsBracketInst.status, "matched");

  // Live source track SHOULD match Live candidate
  const liveMatch = matchTransferTrack({ source: "text", title: "晴天 (Live)", artists: ["周杰伦"] }, [
    {
      provider: "qq",
      id: "live-1",
      title: "晴天 (Live)",
      artists: ["周杰伦"],
      availability: "playable",
    },
  ]);
  assert.equal(liveMatch.status, "matched");
  assert.equal(liveMatch.selectedCandidate?.targetTrackId, "live-1");

  // C026: Artist substring false positives blocked while parenthetical aliases match
  assert.equal(hasArtistOverlap(["张杰"], ["张杰伦"]), false);
  assert.equal(hasArtistOverlap(["李健"], ["李健达"]), false);
  assert.equal(hasArtistOverlap(["Mark"], ["Mark Ronson"]), false);
  assert.equal(hasArtistOverlap(["周杰伦"], ["周杰伦 (Jay Chou)"]), true);
  assert.equal(hasArtistOverlap(["Jay Chou"], ["周杰伦 (Jay Chou)"]), true);
});

test("comparePlaylistsAsync is left-order invariant across three deterministic passes (T06/B58/C026)", async () => {
  const rightTracks = [
    { source: "qq" as const, title: "晴天", artists: ["周杰伦"] },
    { source: "qq" as const, title: "晴天 (Live)", artists: ["周杰伦"] },
  ];

  const forward = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "L1",
      playlistName: "Forward",
      tracks: [
        { source: "netease", title: "晴天", artists: ["翻唱歌手"] },
        { source: "netease", title: "晴天", artists: ["周杰伦"] },
      ],
    },
    right: { provider: "qq", playlistId: "R1", playlistName: "Right", tracks: rightTracks },
  });

  const reversed = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "L2",
      playlistName: "Reversed",
      tracks: [
        { source: "netease", title: "晴天", artists: ["周杰伦"] },
        { source: "netease", title: "晴天", artists: ["翻唱歌手"] },
      ],
    },
    right: { provider: "qq", playlistId: "R1", playlistName: "Right", tracks: rightTracks },
  });

  assert.equal(forward.summary.exact, 1);
  assert.equal(reversed.summary.exact, 1);
  assert.equal(forward.summary.sameTitleDifferentArtist, reversed.summary.sameTitleDifferentArtist);

  // Short substring must not steal an exact title match in Pass 3
  const shortVsExact = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "L3",
      playlistName: "Short",
      tracks: [
        { source: "netease", title: "Go", artists: ["Band X"] },
        { source: "netease", title: "Let It Go", artists: ["Band X"] },
      ],
    },
    right: {
      provider: "qq",
      playlistId: "R3",
      playlistName: "Target",
      tracks: [{ source: "qq", title: "Let It Go", artists: ["Band X"] }],
    },
  });
  assert.equal(shortVsExact.summary.exact, 1);
  assert.equal(shortVsExact.summary.leftOnly, 1);
});

test("CSV and text parsers handle missing header columns, apostrophes, band names, spaced quotes, decimal titles, and audit headers (T11-T14/B59/C028)", () => {
  // T12: album,title header leaves artist empty instead of borrowing column 0/1
  const csvHeader = parseCsvPlaylist("album,title\n叶惠美,晴天\n");
  assert.equal(csvHeader.length, 1);
  assert.equal(csvHeader[0]?.title, "晴天");
  assert.equal(csvHeader[0]?.album, "叶惠美");
  assert.deepEqual(csvHeader[0]?.artists, []);

  // T13: ordinary leading apostrophe preserved, exported formula escape stripped
  const csvQuotes = parseCsvPlaylist(
    `title,artist\n"'Til Tomorrow",Artist A\n"'=CMD|' /C calc'!A0",Artist B\n`,
  );
  assert.equal(csvQuotes[0]?.title, "'Til Tomorrow");
  assert.equal(csvQuotes[1]?.title, "=CMD|' /C calc'!A0");

  // T14: AC/DC and Simon & Garfunkel stay intact while explicit separators split
  const csvArtists = parseCsvPlaylist(
    `title,artist\nBack In Black,AC/DC\nThe Sound of Silence,Simon & Garfunkel\n珊瑚海,"周杰伦 / 梁心颐"\n合唱,"歌手A、歌手B;歌手C"\n`,
  );
  assert.deepEqual(csvArtists[0]?.artists, ["AC/DC"]);
  assert.deepEqual(csvArtists[1]?.artists, ["Simon & Garfunkel"]);
  assert.deepEqual(csvArtists[2]?.artists, ["周杰伦", "梁心颐"]);
  assert.deepEqual(csvArtists[3]?.artists, ["歌手A", "歌手B", "歌手C"]);

  // B59: Leading whitespace before quoted CSV cell still opens RFC4180 quotes
  const spacedQuote = parseCsvPlaylist(`title,artist\n  "Hello, World",  "Tyler, The Creator"\n`);
  assert.equal(spacedQuote[0]?.title, "Hello, World");
  assert.deepEqual(spacedQuote[0]?.artists, ["Tyler, The Creator"]);

  // C028: Decimal title like 3.14 is preserved and audit export header "已扫描：" is ignored
  const auditExport = formatImportAuditExport(
    {
      playlistId: "1",
      playlistName: "Audit",
      scannedCount: 1,
      playableCount: 0,
      issueCount: 1,
      playableTrackIds: [],
      issues: [
        {
          trackId: "1",
          title: "3.14",
          artists: ["圆周率乐队"],
          issueType: "copyright_unavailable",
          reason: "无版权",
          replacements: [],
        },
      ],
    },
    "text",
  );
  const reimported = parseTextPlaylist(auditExport.content);
  assert.equal(reimported.length, 1);
  assert.equal(reimported[0]?.title, "3.14");
  assert.deepEqual(reimported[0]?.artists, ["圆周率乐队"]);

  // Pasted audit markdown header ("已扫描：...") must also be ignored
  const auditMd = formatImportAuditExport(
    {
      playlistId: "1",
      playlistName: "Audit",
      scannedCount: 5,
      playableCount: 4,
      issueCount: 1,
      playableTrackIds: [],
      issues: [
        {
          trackId: "1",
          title: "10.15 Saturday Night",
          artists: ["The Cure"],
          issueType: "copyright_unavailable",
          reason: "无版权",
          replacements: [],
        },
      ],
    },
    "markdown",
  );
  const parsedFromMd = parseTextPlaylist(auditMd.content);
  assert.equal(parsedFromMd.length, 1);
  assert.equal(parsedFromMd[0]?.title, "10.15 Saturday Night");

  // T11: Stats report sourceTotal and truncated accurately
  const textLines = Array.from({ length: 5 }, (_, i) => `${i + 1}. Song ${i + 1} - Artist ${i + 1}`).join(
    "\n",
  );
  const stats = parseTextPlaylistWithStats(textLines, 3);
  assert.equal(stats.tracks.length, 3);
  assert.equal(stats.sourceTotal, 5);
  assert.equal(stats.truncated, true);

  const csvStats = parseCsvPlaylistWithStats("title,artist\nA,X\nB,Y\nC,Z\nD,W\n", 2);
  assert.equal(csvStats.tracks.length, 2);
  assert.equal(csvStats.sourceTotal, 4);
  assert.equal(csvStats.truncated, true);
});
