import assert from "node:assert/strict";
import test from "node:test";
import { toPublicPlaylistTransferJob, toPublicTransferImportRequest } from "./public-dto.js";
import { TransferImportRequestValidationError } from "./transfer-import-request.js";
import type { PlaylistTransferJob } from "./types.js";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";

const internalJob: PlaylistTransferJob & { internalAuthorization: string } = {
  id: "job-private",
  ownerKey: "guest:secret-client-session",
  internalAuthorization: "credential-digest",
  sourceProvider: "netease",
  targetProvider: "qq",
  playlistName: "Private boundaries",
  tracks: [{
    sourceTrack: {
      source: "netease",
      sourceTrackId: "source-1",
      title: "Song",
      artists: ["Artist"],
      album: "Album",
      durationSeconds: 180,
      rawText: "Song - Artist"
    },
    status: "matched",
    candidates: [{
      provider: "qq",
      targetTrackId: "target-1",
      title: "Song",
      artists: ["Artist"],
      album: "Album",
      durationSeconds: 180,
      availability: { status: "available", reason: "internal check" },
      confidenceScore: 100,
      reasons: ["exact"],
      raw: { pay: { payplay: 1 }, credentialDigest: "candidate-secret" }
    }],
    selectedCandidate: {
      provider: "qq",
      targetTrackId: "target-1",
      title: "Song",
      artists: ["Artist"],
      confidenceScore: 100,
      reasons: ["exact"],
      raw: { clientSessionId: "secret-client-session" }
    }
  }],
  summary: {
    total: 1,
    matched: 1,
    manualReview: 0,
    notFound: 0,
    unavailable: 0,
    duplicate: 0,
    skipped: 0
  },
  createdAt: "2026-07-26T00:00:00.000Z",
  updatedAt: "2026-07-26T00:00:00.000Z"
};

test("public transfer DTO allowlists fields deeply without mutating persisted records", () => {
  const publicJob = toPublicPlaylistTransferJob(internalJob);
  const serialized = JSON.stringify(publicJob);

  assertPublicDtoSafe(publicJob, "candidate-secret");
  assert.equal("ownerKey" in publicJob, false);
  assert.doesNotMatch(serialized, /ownerKey|secret-client-session|credential-digest|candidate-secret|internalAuthorization|\"raw\"/);
  assert.equal(publicJob.tracks[0]?.candidates[0]?.availability?.status, "available");
  assert.equal(publicJob.summary.matched, 1);
  assert.deepEqual(internalJob.tracks[0]?.candidates[0]?.raw, {
    pay: { payplay: 1 },
    credentialDigest: "candidate-secret"
  });
  assert.notEqual(publicJob.tracks, internalJob.tracks);
  assert.notEqual(publicJob.summary, internalJob.summary);
  assert.notEqual(publicJob.tracks[0], internalJob.tracks[0]);
  assert.notEqual(publicJob.tracks[0].sourceTrack, internalJob.tracks[0].sourceTrack);
  assert.notEqual(publicJob.tracks[0].candidates, internalJob.tracks[0].candidates);
  assert.notEqual(publicJob.tracks[0].candidates[0], internalJob.tracks[0].candidates[0]);
  assert.notEqual(publicJob.tracks[0].candidates[0].availability, internalJob.tracks[0].candidates[0].availability);
  publicJob.tracks[0].candidates[0].artists.push("public mutation");
  publicJob.tracks[0].candidates[0].availability!.reason = "public reason";
  publicJob.summary.total = 99;
  internalJob.tracks[0].candidates[0].reasons.push("internal mutation");
  assert.deepEqual(internalJob.tracks[0].candidates[0].artists, ["Artist"]);
  assert.equal(internalJob.tracks[0].candidates[0].availability?.reason, "internal check");
  assert.equal(internalJob.summary.total, 1);
  assert.deepEqual(publicJob.tracks[0].candidates[0].reasons, ["exact"]);
});

test("public transfer input DTO rejects invalid internal structures with a validation error", () => {
  assert.throws(
    () => toPublicTransferImportRequest({
      sourceProvider: "qq",
      targetProvider: "netease",
      sourceTracks: [null]
    }),
    (error) => error instanceof TransferImportRequestValidationError
      && error.message === "歌单互转任务输入格式无效。"
  );
});
