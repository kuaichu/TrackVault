import assert from "node:assert/strict";
import test from "node:test";
import { createQqPlaylistUsingApi, getQqSongLyrics, getQqTaggedDownloadFallbackTypes } from "./qqmusic-provider.js";

test("tagged QQ downloads prefer FLAC, 320K MP3, and 128K MP3 before diagnosing M4A", () => {
  assert.deepEqual(getQqTaggedDownloadFallbackTypes(), ["flac", "320", "128", "m4a"]);
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
