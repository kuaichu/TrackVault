import assert from "node:assert/strict";
import test from "node:test";
import { matchTransferTrack } from "./matcher.js";
import type { ProviderTrack, TransferTrack } from "./types.js";

const sourceTrack: TransferTrack = {
  source: "text",
  sourceTrackId: "text-1",
  title: "非我",
  artists: ["方山厨子Rex"],
  album: "非我"
};

const exactCandidate: ProviderTrack = {
  provider: "netease",
  id: "338",
  title: "非我",
  artists: ["方山厨子Rex"],
  album: "非我",
  durationSeconds: 234
};

test("matchTransferTrack accepts exact title artist and album matches", () => {
  const result = matchTransferTrack(sourceTrack, [exactCandidate]);

  assert.equal(result.status, "matched");
  assert.equal(result.selectedCandidate?.targetTrackId, "338");
  assert.equal(result.selectedCandidate?.confidenceScore, 100);
});

test("matchTransferTrack sends close but uncertain matches to manual review", () => {
  const result = matchTransferTrack(sourceTrack, [
    {
      ...exactCandidate,
      id: "close",
      title: "非我 Live",
      album: "现场版"
    }
  ]);

  assert.equal(result.status, "manual_review");
  assert.equal(result.candidates[0].confidenceScore < 90, true);
});

test("matchTransferTrack reports missing candidates as not found", () => {
  const result = matchTransferTrack(sourceTrack, []);

  assert.equal(result.status, "not_found");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.reason, "目标平台未找到候选歌曲");
});
