import assert from "node:assert/strict";
import test from "node:test";
import { playlistTotal, resultProvider, shouldWriteBrowserUrl } from "./frontend-route-state";

test("does not write duplicate browser history entries", () => {
  assert.equal(shouldWriteBrowserUrl("/cloud", "/cloud"), false);
  assert.equal(shouldWriteBrowserUrl("/discover", "/cloud"), true);
});

test("playlist URL provider overrides the global provider for result operations", () => {
  assert.equal(resultProvider("playlist", "qq", "netease"), "qq");
  assert.equal(resultProvider("search", "qq", "netease"), "netease");
});

test("a loaded external playlist total replaces its zero placeholder", () => {
  assert.equal(playlistTotal(235, 0), 235);
  assert.equal(playlistTotal(0, 42), 42);
});
