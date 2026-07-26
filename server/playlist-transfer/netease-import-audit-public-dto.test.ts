import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";
import type { NeteaseImportedPlaylistAudit } from "./netease-import-audit.js";
import { toPublicNeteaseImportedPlaylistAudit } from "./netease-import-audit-public-dto.js";
import type { MatchCandidate, TransferTrack } from "./types.js";

const secret = "audit-secret-sentinel";

test("Netease audit public DTO deeply allowlists fields and isolates mutable references", () => {
  const sourceTrack: TransferTrack & { raw: { SID: string }; ownerKey: string } = {
    source: "netease",
    sourceTrackId: "source-1",
    title: "歌曲",
    artists: ["原歌手"],
    rawText: "歌曲 - 原歌手",
    raw: { SID: secret },
    ownerKey: secret
  };
  const candidate: MatchCandidate & { clientSessionId: string; generation: number } = {
    provider: "netease",
    targetTrackId: "replacement-1",
    title: "歌曲",
    artists: ["替代歌手"],
    availability: { status: "available", reason: "可播放" },
    confidenceScore: 96,
    reasons: ["歌名一致"],
    raw: {
      cookie: secret,
      nested: { credentialDigest: secret, token: secret }
    },
    clientSessionId: secret,
    generation: 3
  };
  const audit: NeteaseImportedPlaylistAudit & { ownerKey: string; guard: string } = {
    playlistId: "liked",
    playlistName: "收藏",
    scannedCount: 1,
    summary: { total: 1, playable: 0, suspect: 1, replaceable: 1, needsReview: 0, unusable: 0 },
    playableTrackIds: [],
    playableTextPlaylist: "",
    items: [{
      originalTrackId: "source-1",
      sourceTrack,
      unusableReason: "无音源",
      status: "replaceable",
      candidates: [candidate],
      selectedCandidate: candidate,
      reason: "已找到替代"
    }],
    textPlaylist: "歌曲 - 替代歌手",
    unusableText: "",
    markdownReport: "# 审计",
    ownerKey: secret,
    guard: secret
  };

  const publicAudit = toPublicNeteaseImportedPlaylistAudit(audit);
  assertPublicDtoSafe(publicAudit, secret);
  assert.notEqual(publicAudit.summary, audit.summary);
  assert.notEqual(publicAudit.playableTrackIds, audit.playableTrackIds);
  assert.notEqual(publicAudit.items, audit.items);
  assert.notEqual(publicAudit.items[0], audit.items[0]);
  assert.notEqual(publicAudit.items[0].candidates, audit.items[0].candidates);
  assert.notEqual(publicAudit.items[0].sourceTrack, sourceTrack);
  assert.notEqual(publicAudit.items[0].candidates[0], candidate);
  assert.notEqual(publicAudit.items[0].selectedCandidate, candidate);
  assert.notEqual(publicAudit.items[0].candidates[0].artists, candidate.artists);
  assert.notEqual(publicAudit.items[0].candidates[0].reasons, candidate.reasons);
  assert.notEqual(publicAudit.items[0].candidates[0].availability, candidate.availability);

  publicAudit.items[0].candidates[0].artists.push("公共突变");
  publicAudit.items[0].candidates[0].availability!.reason = "公共原因";
  publicAudit.playableTrackIds.push("public-id");
  publicAudit.summary.total = 99;
  audit.items[0].candidates[0].reasons.push("内部突变");
  assert.deepEqual(candidate.artists, ["替代歌手"]);
  assert.equal(candidate.availability?.reason, "可播放");
  assert.deepEqual(audit.playableTrackIds, []);
  assert.equal(audit.summary.total, 1);
  assert.deepEqual(publicAudit.items[0].candidates[0].reasons, ["歌名一致"]);
  assert.equal((audit.items[0].candidates[0].raw as { nested: { credentialDigest: string } }).nested.credentialDigest, secret);
});
