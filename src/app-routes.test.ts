import assert from "node:assert/strict";
import test from "node:test";
import { detailRoute, parseAppRoute, searchRoute } from "./app-routes";

test("parses every stable top-level route", () => {
  for (const page of ["discover", "search", "playlists", "cloud", "transfer", "downloads", "history", "settings"] as const) {
    assert.deepEqual(parseAppRoute(`/${page}`), { kind: "top", page, query: undefined });
  }
});

test("search query is encoded and restored", () => {
  assert.equal(searchRoute(" 周杰伦 "), "/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6");
  assert.deepEqual(parseAppRoute("/search", "?q=%E5%91%A8%E6%9D%B0%E4%BC%A6"), {
    kind: "top",
    page: "search",
    query: "周杰伦"
  });
});

test("detail routes contain only public provider and stable id", () => {
  assert.equal(detailRoute("playlists", "qq", "list / 42"), "/playlists/qq/list%20%2F%2042");
  assert.deepEqual(parseAppRoute("/playlists/qq/list%20%2F%2042"), {
    kind: "playlist",
    provider: "qq",
    id: "list / 42"
  });
  assert.deepEqual(parseAppRoute("/artists/netease/123"), { kind: "artist", provider: "netease", id: "123" });
  assert.deepEqual(parseAppRoute("/albums/netease/456"), { kind: "album", provider: "netease", id: "456" });
});

test("rejects unsupported providers, malformed ids, and unknown paths", () => {
  assert.deepEqual(parseAppRoute("/artists/qq/123"), { kind: "unknown" });
  assert.deepEqual(parseAppRoute("/playlists/netease/%E0%A4%A"), { kind: "unknown" });
  assert.deepEqual(parseAppRoute("/not-a-page"), { kind: "unknown" });
});
