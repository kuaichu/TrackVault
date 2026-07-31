import assert from "node:assert/strict";
import test from "node:test";
import { createQqPlaylistUsingApi, getQqSongLyrics, getQqTaggedDownloadFallbackTypes } from "./qqmusic-provider.js";

test("tagged QQ downloads respect the requested quality fallback chain", () => {
  assert.deepEqual(getQqTaggedDownloadFallbackTypes("standard"), ["128", "m4a"]);
  assert.deepEqual(getQqTaggedDownloadFallbackTypes("exhigh"), ["320", "128", "m4a"]);
  assert.deepEqual(getQqTaggedDownloadFallbackTypes("lossless"), ["flac", "320", "128", "m4a"]);
  assert.deepEqual(getQqTaggedDownloadFallbackTypes("hires"), ["flac", "320", "128", "m4a"]);
});

test("QQ lyrics return empty only when at least one candidate request succeeds", async () => {
  const empty = await getQqSongLyrics("song-mid", "stale-mid", undefined, async (candidate) => {
    if (candidate === "stale-mid") throw new Error("stale");
    return { lyric: "" };
  });
  assert.deepEqual(empty.lines, []);

  const lastError = new Error("last candidate failed");
  await assert.rejects(
    () => getQqSongLyrics("song-mid", "stale-mid", undefined, async (candidate) => {
      if (candidate === "song-mid") throw lastError;
      throw new Error("first candidate failed");
    }),
    (error) => error === lastError
  );
});

test("QQ lyrics continue to the next songmid candidate after a fetch failure", async () => {
  const candidates: string[] = [];
  const result = await getQqSongLyrics("song-mid", "stale-media-mid", "12345", async (candidate) => {
    candidates.push(candidate);
    if (candidate === "stale-media-mid") throw new Error("stale");
    return { lyric: "[00:01.00]next candidate works" };
  });
  assert.deepEqual(candidates, ["stale-media-mid", "song-mid"]);
  assert.equal(result.lines[0]?.text, "next candidate works");
});

test("createQqPlaylistUsingApi creates a playlist and adds unique song mids in batches", async () => {
  const calls: Array<{ path: string; query?: Record<string, string | number> }> = [];
  const mids = Array.from({ length: 52 }, (_, index) => `mid-${index + 1}`);

  const result = await createQqPlaylistUsingApi("跨平台所选歌曲", [...mids, "mid-1"], async (path, query) => {
    calls.push({ path, query });
    return path === "songlist/create" ? { dirid: 7788 } : undefined;
  });

  assert.deepEqual(result, {
    playlistId: "7788",
    playlistName: "跨平台所选歌曲",
    addedCount: 52
  });
  assert.equal(calls[0].path, "songlist/create");
  assert.equal(calls[0].query?.name, "跨平台所选歌曲");
  assert.equal(calls[1].path, "songlist/add");
  assert.equal(String(calls[1].query?.mid).split(",").length, 50);
  assert.equal(calls[2].path, "songlist/add");
  assert.equal(String(calls[2].query?.mid).split(",").length, 2);
});

test("createQqPlaylistUsingApi does not create an empty playlist", async () => {
  await assert.rejects(
    () => createQqPlaylistUsingApi("空歌单", [], async () => ({ dirid: 1 })),
    /没有可导入 QQ 音乐的已匹配歌曲/
  );
});
