import assert from "node:assert/strict";
import test from "node:test";
import { QualityLevelSchema, getQualityLabel, normalizeQualityLevel } from "./quality.js";
import {
  escapeCsvCell,
  isAllowedCoverHost,
  normalizeCoverUrl,
  sanitizeCssUrl,
  sanitizeDownloadFilename,
  sanitizeExternalUrl,
} from "./sanitize.js";

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
});
