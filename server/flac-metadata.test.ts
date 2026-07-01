import assert from "node:assert/strict";
import test from "node:test";
import { injectFlacMetadata, isFlacBytes } from "./flac-metadata.js";
import type { Song } from "./types.js";

const textDecoder = new TextDecoder();

const testSong: Song = {
  id: "10086",
  title: "测试歌曲",
  artist: "测试歌手",
  artists: [{ name: "测试歌手" }],
  album: "测试专辑",
  duration: "01:00",
  quality: "FLAC",
  availableQualities: [{ level: "lossless", label: "FLAC" }],
  source: "netease"
};

function buildBlock(type: number, data: Uint8Array, isLast: boolean) {
  return new Uint8Array([
    (isLast ? 0x80 : 0) | type,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...data
  ]);
}

function buildMinimalFlac() {
  return new Uint8Array([
    0x66,
    0x4c,
    0x61,
    0x43,
    ...buildBlock(0, new Uint8Array(34), true),
    0x01,
    0x02,
    0x03
  ]);
}

function readVorbisTags(bytes: Uint8Array) {
  let offset = 4;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    const data = bytes.slice(offset, offset + length);
    offset += length;

    if (type === 4) {
      let dataOffset = 0;
      const readLe32 = () => {
        const value = data[dataOffset] | (data[dataOffset + 1] << 8) | (data[dataOffset + 2] << 16) | (data[dataOffset + 3] << 24);
        dataOffset += 4;
        return value >>> 0;
      };
      const vendorLength = readLe32();
      dataOffset += vendorLength;
      const commentCount = readLe32();
      const tags: Record<string, string> = {};

      for (let index = 0; index < commentCount; index += 1) {
        const commentLength = readLe32();
        const rawComment = textDecoder.decode(data.slice(dataOffset, dataOffset + commentLength));
        dataOffset += commentLength;
        const separatorIndex = rawComment.indexOf("=");
        tags[rawComment.slice(0, separatorIndex)] = rawComment.slice(separatorIndex + 1);
      }

      return tags;
    }

    if (header & 0x80) {
      break;
    }
  }

  return {};
}

test("injectFlacMetadata writes readable Vorbis comment tags", () => {
  const tagged = injectFlacMetadata(buildMinimalFlac(), testSong, "[00:00.00]一句歌词", {
    mimeType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff])
  });
  const tags = readVorbisTags(tagged);

  assert.equal(tags.TITLE, "测试歌曲");
  assert.equal(tags.ARTIST, "测试歌手");
  assert.equal(tags.ALBUM, "测试专辑");
  assert.equal(tags.LYRICS, "[00:00.00]一句歌词");
  assert.equal(tags.UNSYNCEDLYRICS, "[00:00.00]一句歌词");
});

test("injectFlacMetadata handles FLAC files with an ID3v2 prefix", () => {
  const dirtyFlac = new Uint8Array([
    0x49,
    0x44,
    0x33,
    0x04,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...buildMinimalFlac()
  ]);
  const tagged = injectFlacMetadata(dirtyFlac, testSong, "", null);

  assert.equal(isFlacBytes(dirtyFlac), true);
  assert.deepEqual(Array.from(tagged.slice(0, 4)), [0x66, 0x4c, 0x61, 0x43]);
  assert.equal(readVorbisTags(tagged).TITLE, "测试歌曲");
});
