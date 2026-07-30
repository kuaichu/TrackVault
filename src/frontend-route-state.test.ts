import assert from "node:assert/strict";
import test from "node:test";
import { detailBackFallback, playlistTotals, requiresNeteasePlaybackAuth, resultProvider, shouldWriteBrowserUrl } from "./frontend-route-state";

test("does not write duplicate browser history entries", () => {
  assert.equal(shouldWriteBrowserUrl("/cloud", null, "/cloud"), false);
  assert.equal(shouldWriteBrowserUrl("/discover", null, "/cloud"), true);
  assert.equal(shouldWriteBrowserUrl("/discover", "/cloud", "/cloud"), false);
  assert.equal(shouldWriteBrowserUrl("/discover", "/playlists/1", "/cloud"), true);
});

test("a detail opened in a new tab falls back to discover", () => {
  assert.equal(detailBackFallback(0), "/discover");
  assert.equal(detailBackFallback(1), null);
});

test("playlist URL provider overrides the global provider for result operations", () => {
  assert.equal(resultProvider("playlist", "qq", "netease"), "qq");
  assert.equal(resultProvider("search", "qq", "netease"), "netease");
});

test("playlist match totals stay separate from source totals", () => {
  assert.deepEqual(playlistTotals(235, 500, 42), { matchTotal: 235, sourceTotal: 500 });
  assert.deepEqual(playlistTotals(0, 500, 42), { matchTotal: 0, sourceTotal: 500 });
  assert.deepEqual(playlistTotals(0, undefined, 42), { matchTotal: 0, sourceTotal: 42 });
});

test("playback auth follows the song provider instead of the global mode", () => {
  assert.equal(requiresNeteasePlaybackAuth(false, "netease"), true);
  assert.equal(requiresNeteasePlaybackAuth(false, "qqmusic"), false);
  assert.equal(requiresNeteasePlaybackAuth(true, "netease"), false);
  assert.equal(requiresNeteasePlaybackAuth(false, undefined), true);
});
