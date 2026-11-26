import assert from "node:assert/strict";
import test from "node:test";
import { classifyAudioFormat, getQualityLabel, inferQualityLevelFromBitrate } from "./quality.js";
import {
  KugouQrLoginChannelSchema,
  MusicPlatformSchema,
  PlatformBindingViewSchema,
  ProviderModeSchema,
  QqQrLoginChannelSchema,
  QrLoginChannelSchema,
  QrStartResultSchema,
  StartQrLoginInputSchema,
  getPlatformDisplayName,
} from "./schemas/auth.js";
import {
  JobDetailViewSchema,
  JobEventSchema,
  JobSummaryViewSchema,
  JobViewSchema,
  JobsListResponseSchema,
} from "./schemas/jobs.js";
import { ProviderCapabilitiesSchema } from "./schemas/music.js";
import { PlayHistoryResponseSchema, PlayerStateSchema } from "./schemas/settings.js";
import {
  AuditIssueItemSchema,
  CompareResultSchema,
  ImportAuditResultSchema,
  InitialTrackMatchSnapshotSchema,
  ManualTransferDecisionSchema,
  PlayabilityStatusSchema,
  ScanStatsSchema,
  TransferAvailabilitySchema,
  TransferResultSchema,
  TransferTrackResultSchema,
  formatScanStatsSummary,
  normalizeScanStats,
} from "./schemas/transfer.js";

test("classifyAudioFormat classifies lossless, lossy, and unknown formats", () => {
  for (const fmt of ["wav", ".WAV", " aiff ", "PCM"]) {
    const classified = classifyAudioFormat(fmt);
    assert.equal(classified.category, "uncompressed_lossless");
    assert.equal(classified.isLossless, true);
    assert.equal(classified.isExplicitLossy, false);
  }

  for (const fmt of ["flac", ".FLAC", "ape", "alac"]) {
    const classified = classifyAudioFormat(fmt);
    assert.equal(classified.category, "compressed_lossless");
    assert.equal(classified.isLossless, true);
    assert.equal(classified.isExplicitLossy, false);
  }

  for (const fmt of ["mp3", "aac", "ogg", "opus", "wma", "webm", ".m4a", "mp4"]) {
    const classified = classifyAudioFormat(fmt);
    assert.equal(classified.category, "lossy");
    assert.equal(classified.isLossless, false);
    assert.equal(classified.isExplicitLossy, true);
  }

  const unknown = classifyAudioFormat("dsd");
  assert.deepEqual(unknown, {
    cleanFormat: "dsd",
    category: "unknown",
    isLossless: false,
    isExplicitLossy: false,
  });
  assert.deepEqual(classifyAudioFormat(null), {
    cleanFormat: "",
    category: "unknown",
    isLossless: false,
    isExplicitLossy: false,
  });

  // getQualityLabel and inferQualityLevelFromBitrate handle aiff/pcm consistently
  assert.equal(inferQualityLevelFromBitrate(1_411_200, "aiff"), "lossless");
  assert.equal(inferQualityLevelFromBitrate(2_304_000, "pcm"), "hires");
  assert.equal(getQualityLabel("lossless", 1_411_200, "aiff"), "AIFF");
  assert.equal(getQualityLabel("lossless", 1_536_000, "pcm"), "PCM");
});

test("JobSummaryViewSchema, JobDetailViewSchema, JobsListResponseSchema, and JobEventSchema parse revisions", () => {
  const baseSummary = {
    id: "job-1",
    kind: "transfer" as const,
    status: "completed" as const,
    progress: 100,
    title: "歌单互转",
    subtitle: "共 10 首",
    hasResult: true,
    revision: 42,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
  };

  const parsedSummary = JobSummaryViewSchema.parse(baseSummary);
  assert.equal(parsedSummary.hasResult, true);
  assert.equal(parsedSummary.revision, 42);
  assert.equal("result" in parsedSummary, false);

  const detail = JobDetailViewSchema.parse({
    ...baseSummary,
    result: { playlistName: "Favorites" },
  });
  assert.deepEqual(detail.result, { playlistName: "Favorites" });

  // Backwards-compatible alias accepts both summary and detail
  assert.equal(JobViewSchema.parse(baseSummary).id, "job-1");
  assert.equal(JobViewSchema.parse(detail).id, "job-1");

  const list = JobsListResponseSchema.parse({
    jobs: [baseSummary],
    serverRevision: 42,
    clearedBeforeRevision: 10,
  });
  assert.equal(list.jobs.length, 1);
  assert.equal(list.serverRevision, 42);
  assert.equal(list.clearedBeforeRevision, 10);

  const clearedEvent = JobEventSchema.parse({
    type: "jobs_cleared",
    serverRevision: 43,
    clearedBeforeRevision: 43,
    clearedKind: "download",
    timestamp: 1_700_000_006_000,
  });
  assert.equal(clearedEvent.type, "jobs_cleared");
  assert.equal(clearedEvent.clearedKind, "download");
});

test("Transfer availability, probe_error, manualDecision, and initialMatch contracts parse cleanly", () => {
  assert.equal(TransferAvailabilitySchema.parse("paid_album"), "paid_album");
  assert.equal(TransferAvailabilitySchema.parse("restricted"), "restricted");
  assert.equal(PlayabilityStatusSchema.parse("paid_album"), "paid_album");

  const auditIssue = AuditIssueItemSchema.parse({
    trackId: "123",
    title: "Song A",
    artists: ["Artist A"],
    issueType: "probe_error",
    reason: "探测超时",
    replacements: [],
  });
  assert.equal(auditIssue.issueType, "probe_error");

  const decision = ManualTransferDecisionSchema.parse({
    action: "select",
    targetTrackId: "target-99",
    updatedAt: 1_700_000_010_000,
  });
  const initialSnapshot = InitialTrackMatchSnapshotSchema.parse({
    status: "manual_review",
    reason: "需要人工确认",
  });

  const trackResult = TransferTrackResultSchema.parse({
    sourceTrack: {
      source: "netease",
      sourceTrackId: "1001",
      title: "Track One",
      artists: ["Artist One"],
    },
    status: "matched",
    candidates: [
      {
        provider: "qq",
        targetTrackId: "target-99",
        title: "Track One",
        artists: ["Artist One"],
        availability: "paid_album",
        confidenceScore: 92,
        reasons: ["歌名与歌手一致"],
      },
    ],
    selectedCandidate: {
      provider: "qq",
      targetTrackId: "target-99",
      title: "Track One",
      artists: ["Artist One"],
      availability: "paid_album",
      confidenceScore: 92,
      reasons: ["歌名与歌手一致"],
    },
    initialMatch: initialSnapshot,
    manualDecision: decision,
  });

  assert.equal(trackResult.initialMatch?.status, "manual_review");
  assert.equal(trackResult.manualDecision?.action, "select");
  assert.equal(trackResult.manualDecision?.targetTrackId, "target-99");
});

test("ScanStatsSchema, normalizeScanStats, and formatScanStatsSummary normalize legacy & structured", () => {
  const structuredStats = ScanStatsSchema.parse({
    playlistTotal: 2000,
    sourceTotal: 2000,
    scannedSlotCount: 1005,
    processedCount: 1000,
    unprocessedCount: 1000,
    missingDetailCount: 5,
    truncatedCount: 995,
    truncated: true,
  });

  const transferResult = TransferResultSchema.parse({
    sourceProvider: "netease",
    targetProvider: "qq",
    playlistName: "Big Playlist",
    summary: {
      total: 1000,
      matched: 900,
      manualReview: 50,
      notFound: 30,
      unavailable: 10,
      duplicate: 10,
      skipped: 0,
    },
    results: [],
    scanStats: structuredStats,
  });
  assert.deepEqual(normalizeScanStats(transferResult), structuredStats);

  const summary = formatScanStatsSummary(transferResult);
  assert.equal(summary.hasOmissions, true);
  assert.deepEqual(summary.parts, [
    "源歌单共 2000 首",
    "扫描前 1005 个位置",
    "已处理 1000 首",
    "未处理 1000 首",
    "缺少有效详情 5 首",
    "超出单次处理上限 995 首",
  ]);
  assert.equal(
    summary.summaryText,
    "源歌单共 2000 首，扫描前 1005 个位置，已处理 1000 首（未处理 1000 首：缺少有效详情 5 首，超出单次处理上限 995 首）",
  );

  // Legacy flat fields in selected subset mode
  const legacySelected = normalizeScanStats({
    playlistTotal: 500,
    sourceTotal: 50,
    summary: { total: 42 },
    beyondScanCount: 5,
    truncated: true,
  });
  assert.deepEqual(legacySelected, {
    playlistTotal: 500,
    sourceTotal: 50,
    scannedSlotCount: 45,
    processedCount: 42,
    unprocessedCount: 8,
    missingDetailCount: 3,
    truncatedCount: 5,
    truncated: true,
  });

  const selectedSummary = formatScanStatsSummary(legacySelected);
  assert.equal(
    selectedSummary.summaryText,
    "源歌单共 500 首，已选 50 首，已处理 42 首（未处理 8 首：缺少有效详情 3 首，超出单次处理上限 5 首）",
  );

  // Legacy ImportAuditResult & CompareResult schemas accept scanStats
  const auditResult = ImportAuditResultSchema.parse({
    playlistId: "pl-1",
    playlistName: "Audit List",
    scannedCount: 280,
    playableCount: 270,
    issueCount: 10,
    playableTrackIds: [],
    issues: [],
    sourceTotal: 300,
    truncated: false,
  });
  const auditSummary = formatScanStatsSummary(auditResult, { processedVerb: "已扫描" });
  assert.equal(auditSummary.stats.missingDetailCount, 20);
  assert.equal(
    auditSummary.summaryText,
    "源歌单共 300 首，已扫描 280 首（未处理 20 首：缺少有效详情 20 首）",
  );

  const compareResult = CompareResultSchema.parse({
    left: {
      provider: "netease",
      playlistId: "l1",
      playlistName: "Left",
      total: 100,
      scanStats: {
        playlistTotal: 100,
        sourceTotal: 100,
        scannedSlotCount: 100,
        processedCount: 100,
        unprocessedCount: 0,
        missingDetailCount: 0,
        truncatedCount: 0,
        truncated: false,
      },
    },
    right: {
      provider: "qq",
      playlistId: "r1",
      playlistName: "Right",
      total: 100,
    },
    summary: {
      leftTotal: 100,
      rightTotal: 100,
      exact: 90,
      sameTitleDifferentArtist: 0,
      similarTitle: 0,
      leftOnly: 10,
      rightOnly: 10,
    },
    items: [],
  });
  assert.equal(formatScanStatsSummary(compareResult.left).hasOmissions, false);
  assert.equal(formatScanStatsSummary(compareResult.right).hasOmissions, false);
});

test("PlayHistoryResponseSchema, preferredQuality, and credentialCorrupted parse cleanly", () => {
  const sampleSong = {
    id: "song-1",
    platform: "netease" as const,
    title: "Sample Track",
    artist: "Sample Artist",
    album: "Sample Album",
    durationSeconds: 215,
    duration: "03:35",
    quality: "FLAC",
    availableQualities: [{ level: "lossless" as const, label: "无损 FLAC" }],
  };

  const history = PlayHistoryResponseSchema.parse({
    items: [sampleSong],
    revision: 7,
  });
  assert.equal(history.revision, 7);
  assert.equal(history.items.length, 1);

  const playerState = PlayerStateSchema.parse({
    currentTrack: sampleSong,
    playQueue: [sampleSong],
    playbackSeconds: 42,
    volume: 0.8,
    playbackMode: "sequential",
    preferredQuality: "hires",
  });
  assert.equal(playerState.preferredQuality, "hires");

  const binding = PlatformBindingViewSchema.parse({
    platform: "netease",
    connected: false,
    accountUid: "12345",
    displayName: "Demo",
    avatarUrl: null,
    vipEnabled: false,
    vipExpireAt: null,
    verifiedAt: null,
    message: "凭据解密失败，请重新绑定",
    credentialCorrupted: true,
  });
  assert.equal(binding.credentialCorrupted, true);

  for (const ch of ["mobile", "qq", "wx"] as const) {
    assert.equal(QqQrLoginChannelSchema.parse(ch), ch);
  }
  for (const ch of ["kg_lite", "kg_std", "kg_wx_lite", "kg_wx_std"] as const) {
    assert.equal(KugouQrLoginChannelSchema.parse(ch), ch);
    assert.equal(QrLoginChannelSchema.parse(ch), ch);
  }
  assert.equal(MusicPlatformSchema.parse("kugou"), "kugou");
  assert.equal(ProviderModeSchema.parse("kugou"), "kugou");
  assert.equal(getPlatformDisplayName("kugou"), "酷狗音乐");
  assert.deepEqual(StartQrLoginInputSchema.parse({}), {});
  assert.deepEqual(StartQrLoginInputSchema.parse({ channel: "mobile" }), { channel: "mobile" });
  assert.deepEqual(StartQrLoginInputSchema.parse({ channel: "kg_lite" }), { channel: "kg_lite" });
  assert.equal(
    QrStartResultSchema.parse({ key: "k1", qrImage: "data:image/png;base64,AA==", channel: "wx" }).channel,
    "wx",
  );
  const qqCaps = ProviderCapabilitiesSchema.parse({
    platform: "qq",
    canLikeSong: false,
    canManagePlaylistTracks: false,
    canCreatePlaylist: false,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    qrLoginChannels: ["mobile", "qq", "wx"],
    shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
  });
  assert.deepEqual(qqCaps.qrLoginChannels, ["mobile", "qq", "wx"]);
  const kgCaps = ProviderCapabilitiesSchema.parse({
    platform: "kugou",
    canLikeSong: false,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: false,
    canQrLogin: true,
    qrLoginChannels: ["kg_lite", "kg_std", "kg_wx_lite", "kg_wx_std"],
    shareUrlTemplate: "https://www.kugou.com/song/#hash={id}",
  });
  assert.deepEqual(kgCaps.qrLoginChannels, ["kg_lite", "kg_std", "kg_wx_lite", "kg_wx_std"]);
});
