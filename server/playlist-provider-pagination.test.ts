import assert from "node:assert/strict";
import test from "node:test";
import { getPlaylistPageMeta } from "./playlist-provider";

test("external playlist pagination keeps the provider total on every page", () => {
  assert.deepEqual(getPlaylistPageMeta(1, 100, 100, 235), { total: 235, hasMore: true });
  assert.deepEqual(getPlaylistPageMeta(2, 100, 100, 235), { total: 235, hasMore: true });
  assert.deepEqual(getPlaylistPageMeta(3, 100, 35, 235), { total: 235, hasMore: false });
});

test("an exact page multiple does not advertise an empty next page", () => {
  assert.deepEqual(getPlaylistPageMeta(2, 100, 100, 200), { total: 200, hasMore: false });
});
