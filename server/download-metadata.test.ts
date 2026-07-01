import assert from "node:assert/strict";
import test from "node:test";
import { getHighResolutionCoverUrl } from "./download-metadata.js";

test("getHighResolutionCoverUrl upgrades NetEase resized covers for embedded artwork", () => {
  assert.equal(
    getHighResolutionCoverUrl("https://p1.music.126.net/example.jpg?param=160y160"),
    "https://p1.music.126.net/example.jpg?param=1000y1000"
  );
});

test("getHighResolutionCoverUrl upgrades QQ Music 300px album covers", () => {
  assert.equal(
    getHighResolutionCoverUrl("https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg"),
    "https://y.gtimg.cn/music/photo_new/T002R800x800M000abc.jpg"
  );
});
