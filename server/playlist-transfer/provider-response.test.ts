import assert from "node:assert/strict";
import test from "node:test";
import { parseNeteasePlaylistSongsBody } from "../playlist-provider.js";
import { parseQqAccountPlaylistSongs } from "../qqmusic-provider.js";
import { parseQqPlaylistTransferBody } from "./qq-provider.js";

test("QQ playlist responses reject business errors and missing song structures", () => {
  assert.throws(() => parseQqPlaylistTransferBody({ code: 1, message: "denied" }), /读取失败/);
  assert.throws(() => parseQqPlaylistTransferBody({ code: 0 }), /缺少歌曲列表结构/);
  assert.deepEqual(parseQqPlaylistTransferBody({ code: 0, cdlist: [{ songlist: [] }] }), []);
  assert.throws(() => parseQqAccountPlaylistSongs({}), /缺少歌曲列表结构/);
  assert.throws(() => parseQqAccountPlaylistSongs({ code: 1, message: "denied", songlist: [] }), /读取失败/);
  assert.deepEqual(parseQqAccountPlaylistSongs({ songlist: [] }), []);
});

test("Netease playlist responses reject business errors and missing song structures", () => {
  assert.throws(() => parseNeteasePlaylistSongsBody({ code: 401, msg: "denied" }), /读取失败/);
  assert.throws(() => parseNeteasePlaylistSongsBody({ code: 200 }), /缺少歌曲列表结构/);
  assert.deepEqual(parseNeteasePlaylistSongsBody({ code: 200, songs: [] }), []);
});
