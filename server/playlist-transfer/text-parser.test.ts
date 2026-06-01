import assert from "node:assert/strict";
import test from "node:test";
import { parseTextPlaylist } from "./text-parser.js";

test("parseTextPlaylist extracts numbered title artist album rows", () => {
  const tracks = parseTextPlaylist(`
歌单：旧收藏
1. 非我 - 方山厨子Rex - 非我
2. Way Back Home - SHAUN - Take
  `);

  assert.deepEqual(tracks, [
    {
      source: "text",
      sourceTrackId: "text-1",
      title: "非我",
      artists: ["方山厨子Rex"],
      album: "非我",
      rawText: "非我 - 方山厨子Rex - 非我"
    },
    {
      source: "text",
      sourceTrackId: "text-2",
      title: "Way Back Home",
      artists: ["SHAUN"],
      album: "Take",
      rawText: "Way Back Home - SHAUN - Take"
    }
  ]);
});

test("parseTextPlaylist preserves slash separated artists and plain titles", () => {
  const tracks = parseTextPlaylist(`
周杰伦 / 温岚 - 屋顶
玻璃
  `);

  assert.equal(tracks[0].title, "屋顶");
  assert.deepEqual(tracks[0].artists, ["周杰伦", "温岚"]);
  assert.equal(tracks[1].title, "玻璃");
  assert.deepEqual(tracks[1].artists, []);
});
