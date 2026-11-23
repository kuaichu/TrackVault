import assert from "node:assert/strict";
import test from "node:test";
import { concatBytes, getId3v2TagLength } from "./bytes.js";
import { injectFlacMetadata, isFlacBytes } from "./flac.js";
import { formatLyricsAsLrc, mergeLyricTranslations, parseLrc, parseYrc } from "./lrc.js";
import { injectMp3Metadata, isMp3Bytes } from "./mp3.js";

const sampleMeta = {
  title: "夜曲",
  artist: "周杰伦",
  artists: [{ name: "周杰伦" }],
  album: "十一月的萧邦",
  source: "netease",
};

function makeMinimalFlac(withIsLast: boolean): Uint8Array {
  const streamInfo = new Uint8Array(34).fill(0x11);
  const blockHeader = new Uint8Array([withIsLast ? 0x80 : 0x00, 0x00, 0x00, 34]);
  const audioFrames = new Uint8Array([0xff, 0xf8, 0x69, 0x18, 0x00, 0xaa, 0xbb]);
  return concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), blockHeader, streamInfo, audioFrames]);
}

function makeMinimalMp3(): Uint8Array {
  // Valid MPEG1 Layer3 frame sync: 0xFF 0xFB
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03, 0x04]);
}

test("getId3v2TagLength rejects out-of-bounds and invalid version headers", () => {
  const malicious = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x7f, 0x7f, 0x7f, 0x7f, 0xff, 0xfb]);
  assert.equal(getId3v2TagLength(malicious), 0);

  const badVersion = new Uint8Array([
    0x49, 0x44, 0x33, 0x09, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0xff, 0xfb,
  ]);
  assert.equal(getId3v2TagLength(badVersion), 0);
});

test("injectMp3Metadata writes ID3v2.3 tags to valid MP3 and refuses non-MP3 payloads", () => {
  const mp3 = makeMinimalMp3();
  assert.equal(isMp3Bytes(mp3), true);
  const tagged = injectMp3Metadata(mp3, sampleMeta, "[00:01.00]一群嗜血的蚂蚁", {
    mimeType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  });
  assert.equal(tagged[0], 0x49); // I
  assert.equal(tagged[1], 0x44); // D
  assert.equal(tagged[2], 0x33); // 3
  assert.equal(isMp3Bytes(tagged), true);
  // Audio payload must survive intact at the tail
  assert.deepEqual(tagged.subarray(tagged.length - mp3.length), mp3);

  const htmlPayload = new TextEncoder().encode("<html><body>403 Forbidden</body></html>");
  assert.equal(isMp3Bytes(htmlPayload), false);
  assert.equal(injectMp3Metadata(htmlPayload, sampleMeta, "", null), htmlPayload);
});

test("injectFlacMetadata injects tags on valid FLAC and protects malformed FLAC without isLast bit", () => {
  const validFlac = makeMinimalFlac(true);
  assert.equal(isFlacBytes(validFlac), true);
  const tagged = injectFlacMetadata(validFlac, sampleMeta, "[00:01.00]为你弹奏萧邦的夜曲", {
    mimeType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(isFlacBytes(tagged), true);
  assert.ok(tagged.length > validFlac.length);
  // Last 7 audio frame bytes preserved
  assert.deepEqual(tagged.subarray(tagged.length - 7), validFlac.subarray(validFlac.length - 7));

  const malformed = makeMinimalFlac(false);
  assert.equal(injectFlacMetadata(malformed, sampleMeta, "", null), malformed);
});

test("parseYrc preserves parenthesized text and mergeLyricTranslations handles slight drift", () => {
  const yrc = "[12000,3000](12000,500,0)Hello (12500,500,0)(World)!";
  const parsed = parseYrc(yrc);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.text, "Hello (World)!");

  const base = parseLrc("[00:12.00]Hello (World)!");
  const trans = parseLrc("[00:12.02]你好（世界）！");
  const merged = mergeLyricTranslations(base, trans);
  assert.equal(merged[0]?.translation, "你好（世界）！");
  assert.equal(formatLyricsAsLrc(merged), "[00:12.00]Hello (World)! / 你好（世界）！");
});
