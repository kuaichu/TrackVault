import assert from "node:assert/strict";
import test from "node:test";
import { createQqPlaylistUsingApi } from "./qqmusic-provider.js";

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
