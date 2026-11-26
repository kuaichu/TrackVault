import assert from "node:assert/strict";
import test from "node:test";
import { QualityLevelSchema, getQualityLabel, normalizeQualityLevel } from "./quality.js";
import {
  escapeCsvCell,
  formatDurationSeconds,
  formatTimestampText,
  isAllowedCoverHost,
  normalizeCoverUrl,
  sanitizeCssUrl,
  sanitizeDownloadFilename,
  sanitizeExternalUrl,
  truncateCodePoints,
} from "./sanitize.js";
import { PlayerStateSchema } from "./schemas/settings.js";

test("sanitizeExternalUrl rejects javascript:, data:, file: and embedded credentials", () => {
  assert.equal(sanitizeExternalUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeExternalUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(sanitizeExternalUrl("file:///etc/passwd"), null);
  assert.equal(sanitizeExternalUrl("https://user:pass@example.com/a"), null);
  assert.equal(sanitizeExternalUrl("https://music.163.com/#/song?id=1"), "https://music.163.com/#/song?id=1");
});

test("isAllowedCoverHost matches exact and subdomain suffixes only", () => {
  assert.equal(isAllowedCoverHost("p1.music.126.net"), true);
  assert.equal(isAllowedCoverHost("y.gtimg.cn"), true);
  assert.equal(isAllowedCoverHost("thirdqq.qlogo.cn"), true);
  assert.equal(isAllowedCoverHost("evilmusic.126.net"), false);
  assert.equal(isAllowedCoverHost("127.0.0.1"), false);
});

test("normalizeCoverUrl upgrades http, validates host whitelist, and sets param safely", () => {
  assert.equal(
    normalizeCoverUrl("http://p1.music.126.net/abc.jpg?foo=1", 600),
    "https://p1.music.126.net/abc.jpg?foo=1&param=600y600",
  );
  assert.equal(
    normalizeCoverUrl("https://p2.music.126.net/abc.jpg?param=100y100", 500),
    "https://p2.music.126.net/abc.jpg?param=500y500",
  );
  assert.equal(normalizeCoverUrl("http://thirdqq.qlogo.cn/g?b=sdk", 300), "https://thirdqq.qlogo.cn/g?b=sdk");
  assert.equal(
    normalizeCoverUrl("http://imge.kugou.com/stdmusic/{size}/20230920/20230920142503632013.jpg", 400),
    "https://imge.kugou.com/stdmusic/400/20230920/20230920142503632013.jpg",
  );
  assert.equal(
    normalizeCoverUrl("http://c1.kgimg.com/custom/{size}/20211004/20211004180327643187.jpg", 600),
    "https://c1.kgimg.com/custom/480/20211004/20211004180327643187.jpg",
  );
  assert.equal(normalizeCoverUrl("https://www.kugou.com/a.jpg", 400), undefined);
  assert.equal(normalizeCoverUrl("https://evilmusic.126.net/a.jpg", 400), undefined);
  assert.equal(normalizeCoverUrl("https://evil.example.com/a.jpg", 400), undefined);
});

test("sanitizeDownloadFilename strips traversal, control chars, and Windows reserved names", () => {
  assert.equal(sanitizeDownloadFilename("../../etc/passwd\u0000.mp3"), "etc-passwd.mp3");
  assert.equal(sanitizeDownloadFilename("CON"), "TrackVault-Audio");
  assert.equal(sanitizeDownloadFilename("  Song: A/B*C?  "), "Song- A-B-C");
});

test("escapeCsvCell mitigates spreadsheet formula injection and escapes quotes", () => {
  assert.equal(escapeCsvCell("=CMD|' /C calc'!A0"), `"'=CMD|' /C calc'!A0"`);
  assert.equal(escapeCsvCell("+SUM(A1:A2)"), `"'` + `+SUM(A1:A2)"`);
  assert.equal(escapeCsvCell('Normal "Title", Live'), `"Normal ""Title"", Live"`);
  // C044: leading whitespace before formula characters and leading newline/tab/CR
  assert.equal(escapeCsvCell("  =HYPERLINK(1)"), `"'  =HYPERLINK(1)"`);
  assert.equal(escapeCsvCell("  @SUM(A1)"), `"'  @SUM(A1)"`);
  assert.equal(escapeCsvCell("\n=CMD"), `"'\n=CMD"`);
  assert.equal(escapeCsvCell("\tfoo"), `"'\tfoo"`);
  // Ordinary apostrophe title stays untouched
  assert.equal(escapeCsvCell("'Til Tomorrow"), `"'Til Tomorrow"`);
});

test("sanitizeCssUrl encodes characters that could break out of CSS url(...)", () => {
  assert.equal(sanitizeCssUrl("javascript:alert(1)"), null);
  const encoded = sanitizeCssUrl('https://p1.music.126.net/a"b)c.jpg');
  assert.ok(encoded);
  assert.equal(encoded.includes('"'), false);
  assert.equal(encoded.includes(")"), false);
});

test("sanitizeDownloadFilename protects surrogate pairs, trailing dots, Windows reserved extensions, and C1 controls (C043/B30)", () => {
  // Surrogate pair emoji right at the maxLength boundary must never be split or cause URIError
  const emojiTitle = `${"a".repeat(19)}🎵🎵`;
  const truncated = sanitizeDownloadFilename(emojiTitle, "Fallback", 20);
  assert.equal(Array.from(truncated).length, 20);
  assert.doesNotThrow(() => encodeURIComponent(truncated));

  // Lone surrogate in raw input is replaced cleanly
  const loneSurrogate = "Track\uD800Name";
  const safeLone = sanitizeDownloadFilename(loneSurrogate);
  assert.doesNotThrow(() => encodeURIComponent(safeLone));

  // Post-truncation trailing dot and space removed
  assert.equal(sanitizeDownloadFilename("abcdef...gh", "Fallback", 7), "abcdef");

  // Windows reserved device names with extensions blocked
  assert.equal(sanitizeDownloadFilename("CON.mp3"), "TrackVault-Audio");
  assert.equal(sanitizeDownloadFilename("nul.flac"), "TrackVault-Audio");
  assert.equal(sanitizeDownloadFilename("COM1.wav"), "TrackVault-Audio");

  // C1 control characters (0x80-0x9F) stripped
  assert.equal(sanitizeDownloadFilename("Hello\u0085World\u009BTest"), "HelloWorldTest");
});

test("quality helpers include higher 192K and never crash on unknown levels (A14)", () => {
  assert.equal(QualityLevelSchema.safeParse("higher").success, true);
  assert.equal(getQualityLabel("higher"), "192K");
  assert.equal(getQualityLabel("unknown_future_tier"), "UNKNOWN_FUTURE_TIER");
  assert.equal(normalizeQualityLevel("HIGHER", "standard"), "higher");
  assert.equal(normalizeQualityLevel("nonexistent", "exhigh"), "exhigh");
  // Phase 8 A14: explicit vivid shows "臻音 384K", while unknown tiers with >=384 kbps infer exhigh ("384K") without faking spatial audio
  assert.equal(QualityLevelSchema.safeParse("vivid").success, true);
  assert.equal(normalizeQualityLevel("vivid", "exhigh", { bitrate: 384_000, format: "mp4" }), "vivid");
  assert.equal(getQualityLabel("vivid", 384_000), "臻音 384K");
  const inferred384 = normalizeQualityLevel("spatial_future", "standard", {
    bitrate: 384_000,
    format: "mp3",
  });
  assert.equal(inferred384, "exhigh");
  assert.equal(getQualityLabel(inferred384, 384_000), "384K");

  // Explicit lossy format (e.g. AAC 768 kbps without level) must NEVER infer lossless or label as FLAC
  const inferredAac768 = normalizeQualityLevel(undefined, "vivid", {
    bitrate: 768_000,
    format: "aac",
  });
  assert.equal(inferredAac768, "exhigh");
  assert.equal(getQualityLabel(inferredAac768, 768_000), "768K");
  assert.equal(getQualityLabel("lossless", 768_000, "aac"), "AAC 768K");
  assert.equal(getQualityLabel("lossless", null, "aac"), "AAC");
  assert.equal(getQualityLabel("lossless", null, "m4a"), "M4A");
  assert.equal(getQualityLabel("lossless", 1_411_000, "wav"), "WAV");
  assert.equal(getQualityLabel("lossless", 128_000, "wav"), "WAV");
  // CD-quality 16-bit / 44.1 kHz stereo PCM WAV (1,411,200 bps) without upstream level stays lossless ("WAV"), not Hi-Res
  const inferredCdWav = normalizeQualityLevel(undefined, "lossless", {
    bitrate: 1_411_200,
    format: "wav",
  });
  assert.equal(inferredCdWav, "lossless");
  assert.equal(getQualityLabel(inferredCdWav, 1_411_200, "wav"), "WAV");
  const inferredHiResWav = normalizeQualityLevel(undefined, "lossless", {
    bitrate: 4_608_000,
    format: "wav",
  });
  assert.equal(inferredHiResWav, "hires");
});

test("PlayerStateSchema backwards-compatibly accepts optional muted & lastNonZeroVolume (U09)", () => {
  const legacy = PlayerStateSchema.parse({
    currentTrack: null,
    playQueue: [],
    playbackSeconds: 12,
    volume: 0,
    playbackMode: "sequential",
  });
  assert.equal(legacy.muted, undefined);
  assert.equal(legacy.lastNonZeroVolume, undefined);

  const extended = PlayerStateSchema.parse({
    currentTrack: null,
    playQueue: [],
    playbackSeconds: 12,
    volume: 0,
    muted: true,
    lastNonZeroVolume: 0.1,
    playbackMode: "shuffle",
  });
  assert.equal(extended.muted, true);
  assert.equal(extended.lastNonZeroVolume, 0.1);
});

test("truncateCodePoints truncates safely by Unicode code points without splitting surrogate pairs", () => {
  assert.equal(truncateCodePoints("Hello", 10), "Hello");
  assert.equal(truncateCodePoints("HelloWorld", 8), "Hello...");
  assert.equal(truncateCodePoints("Hello", 3), "Hel");
  assert.equal(truncateCodePoints("Hello", 0), "");

  // Surrogate pairs (2 UTF-16 code units = 1 code point) must never be split
  const emoji = "🎵🎶🎧🎤🎹";
  assert.equal(truncateCodePoints(emoji, 5), emoji);
  const truncatedEmoji = truncateCodePoints(emoji, 4);
  assert.equal(truncatedEmoji, "🎵...");
  assert.doesNotThrow(() => encodeURIComponent(truncatedEmoji));

  const shortEmoji = truncateCodePoints("🎵🎶🎧", 2);
  assert.equal(shortEmoji, "🎵🎶");
  assert.doesNotThrow(() => encodeURIComponent(shortEmoji));

  // Lone surrogate normalized safely
  const withLone = truncateCodePoints("A\uD800B", 5);
  assert.doesNotThrow(() => encodeURIComponent(withLone));
});

test("formatDurationSeconds formats MM:SS and HH:MM:SS for >= 3600s", () => {
  assert.equal(formatDurationSeconds(null), "00:00");
  assert.equal(formatDurationSeconds(undefined), "00:00");
  assert.equal(formatDurationSeconds(Number.NaN), "00:00");
  assert.equal(formatDurationSeconds(-12), "00:00");
  assert.equal(formatDurationSeconds(0), "00:00");
  assert.equal(formatDurationSeconds(65.9), "01:05");
  assert.equal(formatDurationSeconds(3599), "59:59");
  assert.equal(formatDurationSeconds(3600), "01:00:00");
  assert.equal(formatDurationSeconds(3661), "01:01:01");
});

test("formatTimestampText handles both seconds and milliseconds in Asia/Shanghai YYYY-MM-DD HH:mm", () => {
  assert.equal(formatTimestampText(null), "");
  assert.equal(formatTimestampText(undefined), "");
  assert.equal(formatTimestampText(0), "");
  assert.equal(formatTimestampText(-100), "");
  assert.equal(formatTimestampText(Number.NaN), "");
  assert.equal(formatTimestampText(1e20), "");

  const ms = Date.UTC(2024, 0, 1, 0, 0, 0); // 2024-01-01 08:00 Asia/Shanghai
  const sec = Math.floor(ms / 1000);
  assert.equal(formatTimestampText(ms), "2024-01-01 08:00");
  assert.equal(formatTimestampText(sec), "2024-01-01 08:00");

  // Midnight in Asia/Shanghai must format as 00:00 (not 24:00)
  const midnightMs = Date.UTC(2023, 11, 31, 16, 0, 0);
  assert.equal(formatTimestampText(midnightMs), "2024-01-01 00:00");
});
