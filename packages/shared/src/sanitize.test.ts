import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(isAllowedCoverHost("evilmusic.126.net"), false);
  assert.equal(isAllowedCoverHost("127.0.0.1"), false);
});

test("normalizeCoverUrl upgrades http and sets param without duplicating query strings", () => {
  assert.equal(
    normalizeCoverUrl("http://p1.music.126.net/abc.jpg?foo=1", 600),
    "https://p1.music.126.net/abc.jpg?foo=1&param=600y600",
  );
  assert.equal(
    normalizeCoverUrl("https://p2.music.126.net/abc.jpg?param=100y100", 500),
    "https://p2.music.126.net/abc.jpg?param=500y500",
  );
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
