import assert from "node:assert/strict";
import test from "node:test";
import { injectFlacMetadata as injectServerFlacMetadata } from "../server/flac-metadata";
import { injectMp3Metadata as injectServerMp3Metadata } from "../server/mp3-metadata";
import { injectFlacMetadata as injectBrowserFlacMetadata, injectMp3Metadata as injectBrowserMp3Metadata } from "./api";
import type { Song } from "./types";

const song: Song = {
  id: "compat-song",
  title: "一致性测试",
  artist: "TrackVault",
  album: "Bounded Media",
  duration: "03:00",
  quality: "无损",
  availableQualities: [],
  source: "netease"
};

function buildMinimalFlac() {
  return Uint8Array.from([
    0x66, 0x4c, 0x61, 0x43,
    0x80, 0x00, 0x00, 0x22,
    ...new Array(34).fill(0),
    0xff, 0xf8, 0x01, 0x02
  ]);
}

test("small MP3 tagging remains byte-identical between browser and server paths", () => {
  const input = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01, 0x02, 0x03]);
  const lyrics = "[00:00.00]一致性歌词";
  assert.deepEqual(
    injectBrowserMp3Metadata(input, song, lyrics, null),
    injectServerMp3Metadata(input, song, lyrics, null)
  );
});

test("small FLAC tagging remains byte-identical between browser and server paths", () => {
  const input = buildMinimalFlac();
  const lyrics = "[00:00.00]一致性歌词";
  assert.deepEqual(
    injectBrowserFlacMetadata(input, song, lyrics, null),
    injectServerFlacMetadata(input, song, lyrics, null)
  );
});
