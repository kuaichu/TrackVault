import assert from "node:assert/strict";
import test from "node:test";
import { buildSelectedSourceTracks, getPlaylistSourceBlockReason, getPlaylistSourceKey, isCurrentPlaylistSourceRequest } from "./playlist-transfer-source.js";
import type { Song } from "./types.js";

const song: Song = { id: "local-1", providerSongId: "mid-1", title: "歌曲", artist: "歌手", artists: [{ name: "歌手" }], album: "专辑", duration: "03:05", quality: "标准", availableQualities: [], source: "qq" };

test("playlist source request identity rejects a stale A response that resolves after B", async () => {
  const a = getPlaylistSourceKey("qq", "A");
  const b = getPlaylistSourceKey("qq", "B");
  let currentRequestId = 1;
  let currentKey = a;
  let applied = "";
  let resolveA!: () => void;
  const aResponse = new Promise<void>((resolve) => { resolveA = resolve; }).then(() => {
    if (isCurrentPlaylistSourceRequest(1, currentRequestId, a, currentKey)) applied = "A";
  });
  currentRequestId = 2;
  currentKey = b;
  if (isCurrentPlaylistSourceRequest(2, currentRequestId, b, currentKey)) applied = "B";
  resolveA();
  await aResponse;
  assert.equal(applied, "B");
});

test("playlist source guard blocks loading, errors, empty sources, and empty selection", () => {
  const base = { provider: "qq" as const, playlistId: "A", loadedPlaylistKey: "qq:A", loading: false, error: "", songs: [song], selectedSongIds: [song.id] };
  assert.match(getPlaylistSourceBlockReason({ ...base, loading: true }), /仍在读取/);
  assert.match(getPlaylistSourceBlockReason({ ...base, error: "failed" }), /读取失败/);
  assert.match(getPlaylistSourceBlockReason({ ...base, loadedPlaylistKey: "qq:B" }), /读取完成/);
  assert.match(getPlaylistSourceBlockReason({ ...base, songs: [] }), /没有可迁移/);
  assert.match(getPlaylistSourceBlockReason({ ...base, selectedSongIds: [] }), /至少选择一首/);
});

test("selected source songs are handed off with complete transfer metadata", () => {
  assert.deepEqual(buildSelectedSourceTracks("qq", [song, { ...song, id: "local-2" }], [song.id]), [{ source: "qq", sourceTrackId: "mid-1", title: "歌曲", artists: ["歌手"], album: "专辑", durationSeconds: 185 }]);
});
