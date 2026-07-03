import assert from "node:assert/strict";
import test from "node:test";
import { injectMp3Metadata, isMp3Bytes } from "./mp3-metadata.js";
import type { Song } from "./types.js";

const textDecoder = new TextDecoder("utf-16le");

const testSong: Song = {
  id: "10086",
  title: "测试歌曲",
  artist: "测试歌手",
  artists: [{ name: "测试歌手" }],
  album: "测试专辑",
  duration: "01:00",
  quality: "MP3 320K",
  availableQualities: [{ level: "exhigh", label: "MP3 320K" }],
  source: "netease"
};

function buildMinimalMp3() {
  return new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);
}

function readSyncsafeUint32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];
}

function decodeUtf16Text(data: Uint8Array) {
  const textBytes = data[0] === 0x01 ? data.slice(1) : data;
  const withoutBom = textBytes[0] === 0xff && textBytes[1] === 0xfe ? textBytes.slice(2) : textBytes;
  return textDecoder.decode(withoutBom).replace(/\0+$/, "");
}

function readId3Frames(bytes: Uint8Array) {
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0x49, 0x44, 0x33]);
  const tagLength = readSyncsafeUint32(bytes, 6);
  let offset = 10;
  const endOffset = 10 + tagLength;
  const frames = new Map<string, Uint8Array>();

  while (offset + 10 <= endOffset) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
    offset += 10;
    frames.set(id, bytes.slice(offset, offset + length));
    offset += length;
  }

  return frames;
}

function readUnsyncedLyrics(data: Uint8Array) {
  assert.equal(data[0], 0x01);
  assert.equal(String.fromCharCode(...data.slice(1, 4)), "XXX");
  let offset = 4;

  if (data[offset] === 0xff && data[offset + 1] === 0xfe) {
    offset += 2;
  }

  while (offset + 1 < data.length) {
    if (data[offset] === 0x00 && data[offset + 1] === 0x00) {
      offset += 2;
      break;
    }

    offset += 2;
  }

  return textDecoder.decode(data.slice(offset)).replace(/\0+$/, "");
}

test("injectMp3Metadata writes ID3v2.3 text, lyrics, and cover frames", () => {
  const tagged = injectMp3Metadata(buildMinimalMp3(), testSong, "[00:00.00]一句歌词", {
    mimeType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff])
  });
  const frames = readId3Frames(tagged);

  assert.equal(isMp3Bytes(tagged), true);
  assert.equal(decodeUtf16Text(frames.get("TIT2")!), "测试歌曲");
  assert.equal(decodeUtf16Text(frames.get("TPE1")!), "测试歌手");
  assert.equal(decodeUtf16Text(frames.get("TALB")!), "测试专辑");
  assert.equal(readUnsyncedLyrics(frames.get("USLT")!), "[00:00.00]一句歌词");
  const pictureFrame = frames.get("APIC")!;
  assert.equal(pictureFrame[pictureFrame.length - 3], 0xff);
  assert.equal(pictureFrame[pictureFrame.length - 2], 0xd8);
  assert.equal(pictureFrame[pictureFrame.length - 1], 0xff);
});

test("injectMp3Metadata replaces an existing ID3v2 tag", () => {
  const staleTag = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x04, 0x41, 0x42, 0x43, 0x44]);
  const tagged = injectMp3Metadata(new Uint8Array([...staleTag, ...buildMinimalMp3()]), testSong, "", null);
  const tagLength = readSyncsafeUint32(tagged, 6);

  assert.deepEqual(Array.from(tagged.slice(10 + tagLength, 10 + tagLength + 4)), [0xff, 0xfb, 0x90, 0x64]);
  assert.equal(readId3Frames(tagged).has("TIT2"), true);
});
