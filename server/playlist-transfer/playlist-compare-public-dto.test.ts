import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";
import { comparePlaylists, type PlaylistCompareResult } from "./playlist-compare.js";
import {
  parsePublicPlaylistCompareResult,
  toPublicPlaylistCompareResult
} from "./playlist-compare-public-dto.js";
import type { TransferTrack } from "./types.js";

const secret = "compare-secret-sentinel";

function createInternalResult() {
  const leftTrack: TransferTrack & { raw: { ownerKey: string }; clientSessionId: string } = {
    source: "netease",
    sourceTrackId: "left-1",
    title: "歌曲",
    artists: ["歌手"],
    raw: { ownerKey: secret },
    clientSessionId: secret
  };
  const rightTrack: TransferTrack & { credentialFingerprint: string; guard: { SID: string } } = {
    source: "qq",
    sourceTrackId: "right-1",
    title: "歌曲",
    artists: ["歌手"],
    credentialFingerprint: secret,
    guard: { SID: secret }
  };
  const result = comparePlaylists({
    left: { provider: "netease", playlistId: "left", playlistName: "左歌单", tracks: [leftTrack] },
    right: { provider: "qq", playlistId: "right", playlistName: "右歌单", tracks: [rightTrack] }
  }) as PlaylistCompareResult & { ownerKey: string };
  result.ownerKey = secret;
  Object.assign(result.items[0], { cancelRequested: true, credentialDigest: secret });
  Object.assign(result.summary, { generation: 7 });
  return { result, leftTrack, rightTrack };
}

test("compare public DTO deeply allowlists fields and isolates mutable references", () => {
  const { result, leftTrack, rightTrack } = createInternalResult();
  const publicResult = toPublicPlaylistCompareResult(result);

  assertPublicDtoSafe(publicResult, secret);
  assert.notEqual(publicResult.items, result.items);
  assert.notEqual(publicResult.items[0], result.items[0]);
  assert.notEqual(publicResult.items[0].leftTrack, leftTrack);
  assert.notEqual(publicResult.items[0].rightTrack, rightTrack);
  assert.notEqual(publicResult.items[0].reasons, result.items[0].reasons);
  assert.notEqual(publicResult.summary, result.summary);

  publicResult.items[0].leftTrack?.artists.push("公共突变");
  result.items[0].reasons.push("内部突变");
  assert.deepEqual(leftTrack.artists, ["歌手"]);
  assert.deepEqual(publicResult.items[0].reasons, ["歌名一致", "歌手匹配"]);
});

test("compare export parser validates structure while stripping unknown fields", () => {
  const { result } = createInternalResult();
  const parsed = parsePublicPlaylistCompareResult(result);
  assert.ok(parsed);
  assertPublicDtoSafe(parsed, secret);
  assert.deepEqual(parsed.summary, {
    totalLeft: 1,
    totalRight: 1,
    exact: 1,
    sameTitleDifferentArtist: 0,
    similarTitle: 0,
    leftOnly: 0,
    rightOnly: 0
  });

  const invalidResults: unknown[] = [
    null,
    {},
    { ...result, items: "invalid" },
    { ...result, createdAt: 123 },
    { ...result, left: { ...result.left, total: -1 } },
    { ...result, summary: { ...result.summary, exact: Number.POSITIVE_INFINITY } },
    { ...result, items: [{ ...result.items[0], reasons: ["ok", 1] }] },
    { ...result, items: [{ ...result.items[0], leftTrack: { ...result.items[0].leftTrack, artists: null } }] }
  ];
  invalidResults.forEach((value) => assert.equal(parsePublicPlaylistCompareResult(value), null));
});
