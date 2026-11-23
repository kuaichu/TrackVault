import assert from "node:assert/strict";
import test from "node:test";
import { concatBytes, getAllId3v2TagsLength, getId3v2TagLength, writeUint32BigEndian } from "./bytes.js";
import { injectFlacMetadata, isFlacBytes } from "./flac.js";
import { formatLyricsAsLrc, mergeLyricTranslations, parseLrc, parseYrc } from "./lrc.js";
import { getMpegFrameByteLength, injectMp3Metadata, isMp3Bytes } from "./mp3.js";

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

test("ID3v2 supports 10-byte empty headers, stacked headers, leading zero padding, and 4-byte MPEG validation (C046/C049)", () => {
  const mp3 = makeMinimalMp3();
  const emptyId3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const withEmptyId3 = concatBytes([emptyId3, mp3]);
  assert.equal(getId3v2TagLength(withEmptyId3), 10);
  assert.equal(isMp3Bytes(withEmptyId3), true);

  const stacked = concatBytes([emptyId3, emptyId3, new Uint8Array([0x00, 0x00, 0x00]), mp3]);
  assert.equal(getAllId3v2TagsLength(stacked), 20);
  assert.equal(isMp3Bytes(stacked), true);

  // Reserved bitrate 0xF0 or reserved sample rate 0x0C must fail 4-byte MPEG frame check
  assert.equal(isMp3Bytes(new Uint8Array([0xff, 0xfb, 0xf0, 0x64, 0x01, 0x02])), false);
  assert.equal(isMp3Bytes(new Uint8Array([0xff, 0xfb, 0x9c, 0x64, 0x01, 0x02])), false);

  // Lone surrogate in metadata encodes safely without throwing
  const loneMeta = { ...sampleMeta, title: "Bad\uD800Title" };
  assert.doesNotThrow(() => injectMp3Metadata(mp3, loneMeta, "", null));
});

test("MP3 and FLAC incremental tag injection preserves original cover, lyrics, and custom metadata (J08/C047/C048)", () => {
  // 1. MP3: inject cover + lyrics + custom TRCK frame, then re-inject with empty cover/lyrics
  const mp3 = makeMinimalMp3();
  const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xde, 0xad, 0xbe, 0xef, 0xff, 0xd9]);
  const firstMp3 = injectMp3Metadata(mp3, sampleMeta, "[00:01.00]Original Lyric", {
    mimeType: "image/jpeg",
    bytes: coverBytes,
  });
  // Add a custom TRCK frame into the first MP3's ID3v2.3 tag
  const trckPayload = new Uint8Array([0x03, 0x30, 0x37]); // UTF-8 "07"
  const trckFrame = concatBytes([
    new TextEncoder().encode("TRCK"),
    writeUint32BigEndian(trckPayload.length),
    new Uint8Array([0x00, 0x00]),
    trckPayload,
  ]);
  const firstTagLen = getId3v2TagLength(firstMp3);
  const existingBody = firstMp3.subarray(10, firstTagLen);
  const combinedBody = concatBytes([existingBody, trckFrame]);
  const withTrck = concatBytes([
    new Uint8Array([
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      (combinedBody.length >>> 21) & 0x7f,
      (combinedBody.length >>> 14) & 0x7f,
      (combinedBody.length >>> 7) & 0x7f,
      combinedBody.length & 0x7f,
    ]),
    combinedBody,
    firstMp3.subarray(firstTagLen),
  ]);

  const secondMp3 = injectMp3Metadata(withTrck, sampleMeta, "", null);
  const secondText = Buffer.from(secondMp3).toString("latin1");
  assert.ok(secondText.includes("APIC"), "original APIC cover frame should be preserved");
  assert.ok(secondText.includes("USLT"), "original USLT lyrics frame should be preserved");
  assert.ok(secondText.includes("TRCK"), "original custom TRCK frame should be preserved");
  assert.deepEqual(secondMp3.subarray(secondMp3.length - mp3.length), mp3);

  // 2. FLAC: preserve original picture + lyrics + custom TRACKNUMBER when new cover/lyrics absent
  const flac = makeMinimalFlac(true);
  const firstFlac = injectFlacMetadata(flac, sampleMeta, "[00:02.00]FLAC Lyric", {
    mimeType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xca, 0xfe]),
  });
  const secondFlac = injectFlacMetadata(firstFlac, sampleMeta, "", null);
  const secondFlacStr = Buffer.from(secondFlac).toString("latin1");
  assert.ok(secondFlacStr.includes("image/png"), "original FLAC picture block should be preserved");
  assert.ok(
    secondFlacStr.includes("LYRICS=[00:02.00]FLAC Lyric"),
    "original FLAC lyrics should be preserved",
  );

  // 3. C047: Reject FLAC with reserved block type 127
  const reservedBlockFlac = concatBytes([
    new Uint8Array([0x66, 0x4c, 0x61, 0x43]),
    new Uint8Array([0x00, 0x00, 0x00, 34]),
    new Uint8Array(34).fill(0x11),
    new Uint8Array([0xff, 0x00, 0x00, 2, 0x00, 0x00]), // isLast=1, type=127
    new Uint8Array([0xff, 0xf8, 0x69, 0x18]),
  ]);
  assert.equal(injectFlacMetadata(reservedBlockFlac, sampleMeta, "", null), reservedBlockFlac);

  // 4. C048: Oversized (>16MB) FLAC cover is gracefully skipped without throwing
  const hugeCover = new Uint8Array(0xffffff + 10);
  const taggedWithHugeCover = injectFlacMetadata(firstFlac, sampleMeta, "", {
    mimeType: "image/jpeg",
    bytes: hugeCover,
  });
  assert.equal(isFlacBytes(taggedWithHugeCover), true);
  assert.ok(
    Buffer.from(taggedWithHugeCover).toString("latin1").includes("image/png"),
    "existing cover preserved when oversized cover is skipped",
  );
});

test("LRC parser supports [offset:+/-ms], 4-digit fractions, interlude markers, YRC negatives, // dedup, and exact centiseconds (J09/C050/C051)", () => {
  // J09: [offset:+1000] shifts 10s -> 9s; [offset:-1000] shifts 10s -> 11s
  const earlier = parseLrc("[offset:+1000]\n[00:10.00]Line");
  const later = parseLrc("[offset:-1000]\n[00:10.00]Line");
  assert.equal(earlier[0]?.time, 9);
  assert.equal(later[0]?.time, 11);

  // C050: IEEE-754 float precision in formatLyricsAsLrc (1.29 and 59.999)
  assert.equal(
    formatLyricsAsLrc([
      { time: 1.29, text: "A" },
      { time: 59.999, text: "B" },
    ]),
    "[00:01.29]A\n[01:00.00]B",
  );

  // C051: 4-digit fraction, reject seconds >= 60, interlude empty marker preserved between lines
  const parsedLrc = parseLrc(
    "[00:00.00]\n[00:05.1234]Verse 1\n[00:10.00]\n[00:11.00]\n[00:75.00]Invalid\n[00:20.00]Verse 2",
  );
  assert.equal(parsedLrc.length, 3);
  assert.equal(parsedLrc[0]?.time, 5.1234);
  assert.equal(parsedLrc[1]?.time, 10);
  assert.equal(parsedLrc[1]?.text, "");
  assert.equal(parsedLrc[2]?.text, "Verse 2");

  // C051: YRC negative timestamps/tokens handled safely
  const parsedYrc = parseYrc("[-100,1000](-50,200,0)Intro (150,-10,0)Word");
  assert.equal(parsedYrc.length, 1);
  assert.equal(parsedYrc[0]?.time, 0);
  assert.equal(parsedYrc[0]?.text, "Intro Word");

  // C051: "//" placeholder translations ignored and each translation consumed at most once
  const merged = mergeLyricTranslations(
    [
      { time: 10.0, text: "Line A" },
      { time: 10.05, text: "Line B" },
      { time: 20.0, text: "Line C" },
    ],
    [
      { time: 10.0, text: "译文 A" },
      { time: 20.0, text: "//" },
    ],
  );
  assert.equal(merged[0]?.translation, "译文 A");
  assert.equal(merged[1]?.translation, undefined);
  assert.equal(merged[2]?.translation, undefined);
});

test("injectMp3Metadata preserves ID3v1.1 track number & fallback tags and converts ID3v2.2 frames (Phase 7 J08)", () => {
  const mp3 = makeMinimalMp3();

  // 1. Build MP3 with trailing 128-byte ID3v1.1 tag (track = 7, year = "2005", comment = "V1Note")
  const v1 = new Uint8Array(128);
  v1.set(new TextEncoder().encode("TAG"), 0);
  v1.set(new TextEncoder().encode("V1 Title"), 3);
  v1.set(new TextEncoder().encode("V1 Artist"), 33);
  v1.set(new TextEncoder().encode("V1 Album"), 63);
  v1.set(new TextEncoder().encode("2005"), 93);
  v1.set(new TextEncoder().encode("V1Note"), 97);
  v1[125] = 0x00;
  v1[126] = 7; // Track #7
  v1[127] = 13; // Pop

  const mp3WithV11 = concatBytes([mp3, v1]);
  const injectedFromV11 = injectMp3Metadata(mp3WithV11, sampleMeta, "", null);
  const v11Text = Buffer.from(injectedFromV11).toString("latin1");
  assert.ok(v11Text.includes("TRCK"), "ID3v1.1 track number must be promoted to TRCK");
  assert.ok(v11Text.includes("TYER"), "ID3v1.1 year must be preserved as TYER");
  assert.ok(v11Text.includes("COMM"), "ID3v1.1 comment must be preserved as COMM");
  // Trailing 128-byte ID3v1 block stripped cleanly, original MPEG frames intact at tail
  assert.deepEqual(injectedFromV11.subarray(injectedFromV11.length - mp3.length), mp3);
  // Decode UTF-16LE "7" inside TRCK frame
  assert.ok(Buffer.from(injectedFromV11).includes(Buffer.from([0xff, 0xfe, 0x37, 0x00])));

  // 2. Build MP3 with ID3v2.2 (major = 2, 6-byte frame headers: TRK="09", PIC=PNG)
  const trkData = new Uint8Array([0x00, 0x30, 0x39]); // Latin-1 "09"
  const trkV22 = concatBytes([
    new TextEncoder().encode("TRK"),
    new Uint8Array([0x00, 0x00, trkData.length]),
    trkData,
  ]);
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb]);
  // ID3v2.2 PIC: [encoding=0x00, format="PNG", picType=0x03, desc="", 0x00, imageBytes]
  const picData = concatBytes([
    new Uint8Array([0x00]),
    new TextEncoder().encode("PNG"),
    new Uint8Array([0x03, 0x00]),
    pngBytes,
  ]);
  const picV22 = concatBytes([
    new TextEncoder().encode("PIC"),
    new Uint8Array([0x00, 0x00, picData.length]),
    picData,
  ]);
  const v22Body = concatBytes([trkV22, picV22]);
  const v22Tag = concatBytes([
    new Uint8Array([
      0x49,
      0x44,
      0x33,
      0x02,
      0x00,
      0x00,
      (v22Body.length >>> 21) & 0x7f,
      (v22Body.length >>> 14) & 0x7f,
      (v22Body.length >>> 7) & 0x7f,
      v22Body.length & 0x7f,
    ]),
    v22Body,
  ]);
  const mp3WithV22 = concatBytes([v22Tag, mp3]);
  const injectedFromV22 = injectMp3Metadata(mp3WithV22, sampleMeta, "", null);
  const v22OutLatin1 = Buffer.from(injectedFromV22).toString("latin1");
  assert.equal(injectedFromV22[3], 0x03, "output upgraded to ID3v2.3");
  assert.ok(v22OutLatin1.includes("TRCK"), "ID3v2.2 TRK mapped to ID3v2.3 TRCK");
  assert.ok(v22OutLatin1.includes("APIC"), "ID3v2.2 PIC mapped to ID3v2.3 APIC");
  assert.ok(v22OutLatin1.includes("image/png\0"), "ID3v2.2 3-char PNG converted to MIME image/png\\0");
  assert.deepEqual(injectedFromV22.subarray(injectedFromV22.length - mp3.length), mp3);
});

test("Phase 8 · J01 + J08: getMpegFrameByteLength, ID3v1 genre (e.g. 17 -> Rock, 255 -> unset), and ID3v2.2 CNT/POP migration", () => {
  // 1. Exact MPEG frame byte length calculation (MPEG1 L3 128kbps 44.1kHz = 417B, with padding = 418B)
  assert.equal(getMpegFrameByteLength(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 0), 417);
  assert.equal(getMpegFrameByteLength(new Uint8Array([0xff, 0xfb, 0x92, 0x00]), 0), 418);
  assert.equal(getMpegFrameByteLength(new Uint8Array([0xff, 0xfb, 0xf0, 0x00]), 0), null);

  const mp3 = makeMinimalMp3();

  // 2. ID3v1 genre 17 ("Rock") promoted to ID3v2.3 TCON when TCON is absent; 255 is ignored
  const v1Rock = new Uint8Array(128);
  v1Rock.set(new TextEncoder().encode("TAG"), 0);
  v1Rock[127] = 17; // Rock
  const withRock = injectMp3Metadata(concatBytes([mp3, v1Rock]), sampleMeta, "", null);
  const rockLatin1 = Buffer.from(withRock).toString("latin1");
  assert.ok(rockLatin1.includes("TCON"), "ID3v1 genre 17 must produce TCON");
  // UTF-16LE BOM + "Rock"
  assert.ok(
    Buffer.from(withRock).includes(Buffer.from([0xff, 0xfe, 0x52, 0x00, 0x6f, 0x00, 0x63, 0x00, 0x6b, 0x00])),
    "TCON frame must contain 'Rock'",
  );

  const v1Unset = new Uint8Array(128);
  v1Unset.set(new TextEncoder().encode("TAG"), 0);
  v1Unset[127] = 255; // Unset
  const withUnset = injectMp3Metadata(concatBytes([mp3, v1Unset]), sampleMeta, "", null);
  assert.equal(Buffer.from(withUnset).toString("latin1").includes("TCON"), false);

  // 3. ID3v2.2 CNT -> PCNT and POP -> POPM
  const cntPayload = new Uint8Array([0x00, 0x00, 0x01, 0x2c]); // 300 plays
  const cntV22 = concatBytes([
    new TextEncoder().encode("CNT"),
    new Uint8Array([0x00, 0x00, cntPayload.length]),
    cntPayload,
  ]);
  const popPayload = concatBytes([
    new TextEncoder().encode("user@example.com"),
    new Uint8Array([0x00, 0xc4, 0x00, 0x00, 0x00, 0x2a]), // rating 196, count 42
  ]);
  const popV22 = concatBytes([
    new TextEncoder().encode("POP"),
    new Uint8Array([0x00, 0x00, popPayload.length]),
    popPayload,
  ]);
  const v22Body = concatBytes([cntV22, popV22]);
  const v22Header = new Uint8Array([
    0x49,
    0x44,
    0x33,
    0x02,
    0x00,
    0x00,
    (v22Body.length >>> 21) & 0x7f,
    (v22Body.length >>> 14) & 0x7f,
    (v22Body.length >>> 7) & 0x7f,
    v22Body.length & 0x7f,
  ]);
  const upgraded = injectMp3Metadata(concatBytes([v22Header, v22Body, mp3]), sampleMeta, "", null);
  const upgradedLatin1 = Buffer.from(upgraded).toString("latin1");
  assert.ok(upgradedLatin1.includes("PCNT"), "ID3v2.2 CNT must migrate to ID3v2.3 PCNT");
  assert.ok(upgradedLatin1.includes("POPM"), "ID3v2.2 POP must migrate to ID3v2.3 POPM");
  assert.ok(Buffer.from(upgraded).includes(Buffer.from(cntPayload)), "PCNT counter bytes preserved");
  assert.ok(
    Buffer.from(upgraded).includes(Buffer.from(popPayload)),
    "POPM email + rating + counter preserved",
  );
});
