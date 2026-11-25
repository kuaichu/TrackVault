import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { concatBytes, getAllId3v2TagsLength, getId3v2TagLength, writeUint32BigEndian } from "./bytes.js";
import { injectAudioFileMetadata } from "./file-stream.js";
import { injectFlacMetadata, isFlacBytes } from "./flac.js";
import { formatLyricsAsLrc, mergeLyricTranslations, parseLrc, parseYrc } from "./lrc.js";
import { getMpegFrameByteLength, injectMp3Metadata, isMp3Bytes } from "./mp3.js";
import { hasValidAudioSignature, verifyDownloadedAudioFile } from "./verify.js";

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

test("ID3v2 empty frames (rawSize === 0) are safely skipped without dropping subsequent APIC/USLT/TXXX", () => {
  const mp3 = makeMinimalMp3();
  const enc = new TextEncoder();
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]);

  const makeSyncsafeHeader = (major: number, bodyLength: number) =>
    new Uint8Array([
      0x49,
      0x44,
      0x33,
      major,
      0x00,
      0x00,
      (bodyLength >>> 21) & 0x7f,
      (bodyLength >>> 14) & 0x7f,
      (bodyLength >>> 7) & 0x7f,
      bodyLength & 0x7f,
    ]);

  const makeV23Frame = (id: string, data: Uint8Array) =>
    concatBytes([enc.encode(id), writeUint32BigEndian(data.length), new Uint8Array([0x00, 0x00]), data]);

  // 1. ID3v2.3: empty TIT2 (size=0) followed by TXXX, USLT, and APIC
  const emptyV23Tit2 = makeV23Frame("TIT2", new Uint8Array(0));
  const txxxV23 = makeV23Frame(
    "TXXX",
    concatBytes([
      new Uint8Array([0x00]),
      enc.encode("CUSTOM_NOTE"),
      new Uint8Array([0x00]),
      enc.encode("keep-me"),
    ]),
  );
  const usltV23 = makeV23Frame(
    "USLT",
    concatBytes([new Uint8Array([0x00]), enc.encode("XXX"), new Uint8Array([0x00]), enc.encode("V23 Lyric")]),
  );
  const apicV23 = makeV23Frame(
    "APIC",
    concatBytes([
      new Uint8Array([0x00]),
      enc.encode("image/png"),
      new Uint8Array([0x00, 0x03, 0x00]),
      pngBytes,
    ]),
  );
  const v23Body = concatBytes([emptyV23Tit2, txxxV23, usltV23, apicV23]);
  const v23Result = injectMp3Metadata(
    concatBytes([makeSyncsafeHeader(3, v23Body.length), v23Body, mp3]),
    sampleMeta,
    "",
    null,
  );
  const v23Buf = Buffer.from(v23Result);
  assert.ok(v23Buf.includes(Buffer.from("CUSTOM_NOTE")), "TXXX after empty v2.3 frame must survive");
  assert.ok(v23Buf.includes(Buffer.from("V23 Lyric")), "USLT after empty v2.3 frame must survive");
  assert.ok(v23Buf.includes(Buffer.from(pngBytes)), "APIC after empty v2.3 frame must survive");
  assert.deepEqual(v23Result.subarray(v23Result.length - mp3.length), mp3);

  // 2. ID3v2.4: empty TPE1 (syncsafe size=0) followed by APIC and USLT
  const emptyV24Tpe1 = makeV23Frame("TPE1", new Uint8Array(0));
  const v24Body = concatBytes([emptyV24Tpe1, usltV23, apicV23]);
  const v24Result = injectMp3Metadata(
    concatBytes([makeSyncsafeHeader(4, v24Body.length), v24Body, mp3]),
    sampleMeta,
    "",
    null,
  );
  const v24Buf = Buffer.from(v24Result);
  assert.ok(v24Buf.includes(Buffer.from("V23 Lyric")), "USLT after empty v2.4 frame must survive");
  assert.ok(v24Buf.includes(Buffer.from(pngBytes)), "APIC after empty v2.4 frame must survive");

  // 3. ID3v2.2: empty TT2 (6-byte header, size=0) followed by TXX, ULT, PIC
  const makeV22Frame = (id: string, data: Uint8Array) =>
    concatBytes([
      enc.encode(id),
      new Uint8Array([(data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff]),
      data,
    ]);
  const emptyV22Tt2 = makeV22Frame("TT2", new Uint8Array(0));
  const txxV22 = makeV22Frame(
    "TXX",
    concatBytes([
      new Uint8Array([0x00]),
      enc.encode("V22_KEY"),
      new Uint8Array([0x00]),
      enc.encode("v22-val"),
    ]),
  );
  const ultV22 = makeV22Frame(
    "ULT",
    concatBytes([new Uint8Array([0x00]), enc.encode("XXX"), new Uint8Array([0x00]), enc.encode("V22 Lyric")]),
  );
  const picV22 = makeV22Frame(
    "PIC",
    concatBytes([new Uint8Array([0x00]), enc.encode("PNG"), new Uint8Array([0x03, 0x00]), pngBytes]),
  );
  const v22Body = concatBytes([emptyV22Tt2, txxV22, ultV22, picV22]);
  const v22Result = injectMp3Metadata(
    concatBytes([makeSyncsafeHeader(2, v22Body.length), v22Body, mp3]),
    sampleMeta,
    "",
    null,
  );
  const v22Buf = Buffer.from(v22Result);
  assert.ok(v22Buf.includes(Buffer.from("V22_KEY")), "TXX->TXXX after empty v2.2 frame must survive");
  assert.ok(v22Buf.includes(Buffer.from("V22 Lyric")), "ULT->USLT after empty v2.2 frame must survive");
  assert.ok(v22Buf.includes(Buffer.from(pngBytes)), "PIC->APIC after empty v2.2 frame must survive");
});

test("verifyDownloadedAudioFile validates FLAC, MP3, AAC, M4A, OGG, RIFF WAV, and RF64 WAV", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-audio-verify-"));
  const writeCheck = async (name: string, bytes: Uint8Array) => {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, bytes);
    return verifyDownloadedAudioFile(file);
  };

  try {
    // 1. MP3: complete 417-byte frame + >4KB ID3v2 passes; truncated or trailing error text fails
    const fullMp3Frame = Buffer.alloc(417);
    fullMp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
    assert.equal(hasValidAudioSignature(fullMp3Frame), true);
    assert.equal(await writeCheck("full.mp3", fullMp3Frame), true);
    assert.equal(await writeCheck("trunc-100.mp3", fullMp3Frame.subarray(0, 100)), false);
    assert.equal(await writeCheck("trunc-416.mp3", fullMp3Frame.subarray(0, 416)), false);

    const bigCoverMp3 = injectMp3Metadata(Buffer.concat([fullMp3Frame, fullMp3Frame]), sampleMeta, "", {
      mimeType: "image/png",
      bytes: new Uint8Array(5000).fill(0xaa),
    });
    assert.equal(await writeCheck("big-cover.mp3", bigCoverMp3), true);

    const fakeId3Body = Buffer.alloc(5000, 0x20);
    const fakeId3Header = Buffer.from([
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      (5000 >>> 21) & 0x7f,
      (5000 >>> 14) & 0x7f,
      (5000 >>> 7) & 0x7f,
      5000 & 0x7f,
    ]);
    assert.equal(
      await writeCheck("fake-id3.mp3", Buffer.concat([fakeId3Header, fakeId3Body, Buffer.from("Error 403")])),
      false,
    );

    // 2. AAC ADTS
    const aacLen = 64;
    const fullAac = Buffer.alloc(aacLen);
    fullAac[0] = 0xff;
    fullAac[1] = 0xf1;
    fullAac[2] = 0x50;
    fullAac[3] = 0x80 | ((aacLen >>> 11) & 0x03);
    fullAac[4] = (aacLen >>> 3) & 0xff;
    fullAac[5] = ((aacLen & 0x07) << 5) | 0x1f;
    fullAac[6] = 0xfc;
    assert.equal(hasValidAudioSignature(fullAac), true);
    assert.equal(await writeCheck("full.aac", fullAac), true);
    assert.equal(await writeCheck("trunc.aac", fullAac.subarray(0, 30)), false);

    // 3. FLAC
    const fullFlac = Buffer.alloc(42);
    fullFlac.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
    assert.equal(hasValidAudioSignature(fullFlac), true);
    assert.equal(await writeCheck("full.flac", fullFlac), true);
    assert.equal(await writeCheck("trunc.flac", fullFlac.subarray(0, 20)), false);

    // 4. M4A
    const fullM4a = Buffer.alloc(32);
    fullM4a.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    assert.equal(hasValidAudioSignature(fullM4a), true);
    assert.equal(await writeCheck("full.m4a", fullM4a), true);
    assert.equal(await writeCheck("trunc.m4a", fullM4a.subarray(0, 12)), false);

    // 5. OGG
    const fullOgg = Buffer.alloc(28);
    fullOgg.set([0x4f, 0x67, 0x67, 0x53]);
    fullOgg[26] = 1;
    assert.equal(hasValidAudioSignature(fullOgg), true);
    assert.equal(await writeCheck("full.ogg", fullOgg), true);
    assert.equal(await writeCheck("trunc.ogg", fullOgg.subarray(0, 12)), false);

    // 6. RIFF WAV
    const makeChunk = (type: string, body: Buffer) => {
      const hdr = Buffer.alloc(8);
      hdr.write(type, 0, "ascii");
      hdr.writeUInt32LE(body.length, 4);
      return Buffer.concat([hdr, body]);
    };
    const wavFmt = Buffer.alloc(16);
    wavFmt.writeUInt16LE(1, 0);
    wavFmt.writeUInt16LE(1, 2);
    wavFmt.writeUInt32LE(8000, 4);
    wavFmt.writeUInt32LE(16000, 8);
    wavFmt.writeUInt16LE(2, 12);
    wavFmt.writeUInt16LE(16, 14);
    const fullWav = makeChunk(
      "RIFF",
      Buffer.concat([
        Buffer.from("WAVE"),
        makeChunk("JUNK", Buffer.alloc(128)),
        makeChunk("fmt ", wavFmt),
        makeChunk("data", Buffer.alloc(32)),
      ]),
    );
    assert.equal(hasValidAudioSignature(fullWav), true);
    assert.equal(await writeCheck("full.wav", fullWav), true);
    assert.equal(await writeCheck("trunc-60.wav", fullWav.subarray(0, 60)), false);
    assert.equal(await writeCheck("trunc-data.wav", fullWav.subarray(0, fullWav.length - 4)), false);

    // 7. RF64 WAV with ds64
    const rf64Header = Buffer.alloc(12);
    rf64Header.write("RF64", 0, "ascii");
    rf64Header.writeUInt32LE(0xffffffff, 4);
    rf64Header.write("WAVE", 8, "ascii");
    const ds64 = Buffer.alloc(36);
    ds64.write("ds64", 0, "ascii");
    ds64.writeUInt32LE(28, 4);
    const rf64FmtChunk = makeChunk("fmt ", wavFmt);
    const rf64DataHdr = Buffer.alloc(8);
    rf64DataHdr.write("data", 0, "ascii");
    rf64DataHdr.writeUInt32LE(0xffffffff, 4);
    const rf64Pcm = Buffer.alloc(32);
    const fullRf64Len =
      rf64Header.length + ds64.length + rf64FmtChunk.length + rf64DataHdr.length + rf64Pcm.length;
    ds64.writeBigUInt64LE(BigInt(fullRf64Len - 8), 8);
    ds64.writeBigUInt64LE(BigInt(rf64Pcm.length), 16);
    ds64.writeBigUInt64LE(16n, 24);
    const fullRf64 = Buffer.concat([rf64Header, ds64, rf64FmtChunk, rf64DataHdr, rf64Pcm]);
    assert.equal(await writeCheck("full.rf64.wav", fullRf64), true);
    assert.equal(await writeCheck("trunc.rf64.wav", fullRf64.subarray(0, fullRf64.length - 16)), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("injectAudioFileMetadata matches in-memory injectFlacMetadata/injectMp3Metadata byte-for-byte", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-stream-tag-"));
  const cover = {
    mimeType: "image/png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xca, 0xfe]),
  };

  try {
    // 1. FLAC > 150 KB (spans multiple 64 KiB chunks), with ID3v2 prefix & incremental tags
    const largeFlacAudio = new Uint8Array(160 * 1024);
    for (let i = 0; i < largeFlacAudio.length; i += 1) {
      largeFlacAudio[i] = (i * 31 + 7) & 0xff;
    }
    const streamInfo = new Uint8Array(34).fill(0x22);
    const baseFlac = concatBytes([
      new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34]),
      streamInfo,
      largeFlacAudio,
    ]);
    // First tag via in-memory to populate Vorbis comment + picture, then prepend an ID3v2 header
    const preTaggedFlac = injectFlacMetadata(baseFlac, sampleMeta, "[00:01.00]Old FLAC Lyric", cover);
    const id3Prefix = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const flacInput = concatBytes([id3Prefix, preTaggedFlac]);

    const flacPath = path.join(tmpDir, "track.flac");
    await fs.writeFile(flacPath, flacInput);
    const expectedFlac = injectFlacMetadata(flacInput, sampleMeta, "", null);
    const flacResult = await injectAudioFileMetadata(flacPath, {
      formatHint: "flac",
      meta: sampleMeta,
      lyricsText: "",
      cover: null,
    });
    assert.deepEqual(flacResult, { tagged: true, format: "flac" });
    const actualFlac = new Uint8Array(await fs.readFile(flacPath));
    assert.equal(Buffer.compare(Buffer.from(actualFlac), Buffer.from(expectedFlac)), 0);

    // Malformed FLAC without isLast bit returns passthrough without modifying file
    const badFlac = makeMinimalFlac(false);
    const badFlacPath = path.join(tmpDir, "bad.flac");
    await fs.writeFile(badFlacPath, badFlac);
    const badFlacRes = await injectAudioFileMetadata(badFlacPath, {
      formatHint: "flac",
      meta: sampleMeta,
      lyricsText: "",
      cover: null,
    });
    assert.deepEqual(badFlacRes, { tagged: false, format: "passthrough" });
    assert.equal(Buffer.compare(await fs.readFile(badFlacPath), Buffer.from(badFlac)), 0);

    // 2. MP3 > 150 KB (spans multiple 64 KiB chunks), stacked ID3v2 + empty frame + zero pad + ID3v1.1
    const mpegChunk = new Uint8Array(160 * 1024);
    mpegChunk.set([0xff, 0xfb, 0x90, 0x00], 0);
    for (let i = 4; i < mpegChunk.length; i += 1) {
      mpegChunk[i] = (i * 17 + 3) & 0xff;
    }

    const enc = new TextEncoder();
    const trkData = new Uint8Array([0x00, 0x30, 0x35]); // "05"
    const v22Body = concatBytes([enc.encode("TRK"), new Uint8Array([0x00, 0x00, trkData.length]), trkData]);
    const v22Tag = concatBytes([
      new Uint8Array([0x49, 0x44, 0x33, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, v22Body.length]),
      v22Body,
    ]);
    const txxxPayload = concatBytes([
      new Uint8Array([0x00]),
      enc.encode("CUSTOM_STREAM"),
      new Uint8Array([0x00]),
      enc.encode("ok"),
    ]);
    const v23Body = concatBytes([
      enc.encode("TIT2"),
      writeUint32BigEndian(0),
      new Uint8Array([0x00, 0x00]), // empty frame
      enc.encode("TXXX"),
      writeUint32BigEndian(txxxPayload.length),
      new Uint8Array([0x00, 0x00]),
      txxxPayload,
    ]);
    const v23Tag = concatBytes([
      new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, v23Body.length]),
      v23Body,
    ]);
    const v1Tag = new Uint8Array(128);
    v1Tag.set(enc.encode("TAG"), 0);
    v1Tag.set(enc.encode("2010"), 93);
    v1Tag[127] = 17; // Rock

    const mp3Input = concatBytes([v22Tag, v23Tag, new Uint8Array([0x00, 0x00, 0x00]), mpegChunk, v1Tag]);
    const mp3Path = path.join(tmpDir, "track.mp3");
    await fs.writeFile(mp3Path, mp3Input);

    const expectedMp3 = injectMp3Metadata(mp3Input, sampleMeta, "[00:05.00]MP3 Stream", cover);
    const mp3Result = await injectAudioFileMetadata(mp3Path, {
      meta: sampleMeta, // also tests auto-detection without formatHint
      lyricsText: "[00:05.00]MP3 Stream",
      cover,
    });
    assert.deepEqual(mp3Result, { tagged: true, format: "mp3" });
    const actualMp3 = new Uint8Array(await fs.readFile(mp3Path));
    assert.equal(Buffer.compare(Buffer.from(actualMp3), Buffer.from(expectedMp3)), 0);

    // 3. M4A / HTML passthrough without touching file
    const m4aPath = path.join(tmpDir, "track.m4a");
    const m4aBytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    await fs.writeFile(m4aPath, m4aBytes);
    assert.deepEqual(
      await injectAudioFileMetadata(m4aPath, {
        formatHint: "m4a",
        meta: sampleMeta,
        lyricsText: "",
        cover,
      }),
      { tagged: false, format: "passthrough" },
    );
    assert.equal(Buffer.compare(await fs.readFile(m4aPath), Buffer.from(m4aBytes)), 0);

    const entries = await fs.readdir(tmpDir);
    assert.equal(
      entries.some((name) => name.includes(".tagging")),
      false,
      `no leftover .tagging temp files allowed: ${entries.join(", ")}`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
