import assert from "node:assert/strict";
import test from "node:test";
import { matchTransferTrack } from "../transfer/track-matcher.js";
import { isQualityDowngraded } from "./quality-policy.js";
import { evaluateQqAvailability } from "./song-availability.js";

test("isQualityDowngraded recognizes alac/aiff/pcm lossless and flags high-bitrate lossy aac as downgraded", () => {
  assert.equal(
    isQualityDowngraded("lossless", { level: "lossless", format: "alac", bitrate: 900_000 }),
    false,
  );
  assert.equal(
    isQualityDowngraded("lossless", { level: "lossless", format: ".aiff", bitrate: 1_411_200 }),
    false,
  );
  assert.equal(
    isQualityDowngraded("lossless", { level: "lossless", format: "pcm", bitrate: 1_536_000 }),
    false,
  );
  assert.equal(isQualityDowngraded("hires", { level: "hires", format: "alac", bitrate: 2_200_000 }), false);

  // High-bitrate lossy codec (768kbps AAC) returned when lossless was requested MUST be downgraded
  assert.equal(isQualityDowngraded("lossless", { level: "lossless", format: "aac", bitrate: 768_000 }), true);
  assert.equal(isQualityDowngraded("hires", { level: "hires", format: "mp3", bitrate: 960_000 }), true);
  assert.equal(isQualityDowngraded("lossless", { level: "lossless", format: "m4a", bitrate: 900_000 }), true);
});

test("evaluateQqAvailability respects explicit vipEnabled=false while preserving public default when omitted", () => {
  const vipTrack = { actionSwitch: 1, payPlay: 1, payDownload: 1, tryEnd: 30 };

  const publicDefault = evaluateQqAvailability(vipTrack);
  assert.ok(publicDefault);
  assert.equal(publicDefault.playback.status, "vip");
  assert.equal(publicDefault.playback.locked, false);
  assert.equal(publicDefault.download.locked, false);

  const nonVipKnown = evaluateQqAvailability(vipTrack, { vipEnabled: false });
  assert.ok(nonVipKnown);
  assert.equal(nonVipKnown.playback.status, "vip");
  assert.equal(nonVipKnown.playback.locked, true);
  assert.equal(nonVipKnown.download.locked, true);

  const trialOnlyNoPay = evaluateQqAvailability(
    { actionSwitch: 1, payPlay: 0, payDownload: 0, tryEnd: 30 },
    { vipEnabled: false },
  );
  assert.ok(trialOnlyNoPay);
  assert.equal(trialOnlyNoPay.playback.locked, true);
  assert.equal(trialOnlyNoPay.download.locked, true);

  const vipKnown = evaluateQqAvailability(vipTrack, { vipEnabled: true });
  assert.ok(vipKnown);
  assert.equal(vipKnown.playback.locked, false);
  assert.equal(vipKnown.download.locked, false);
});

test("matchTransferTrack preserves paid_album and restricted as unavailable instead of matched", () => {
  const sourceTrack = {
    source: "netease" as const,
    sourceTrackId: "s-1",
    title: "晴天",
    artists: ["周杰伦"],
    album: "叶惠美",
    durationSeconds: 269,
  };

  const paidResult = matchTransferTrack(sourceTrack, [
    {
      provider: "qq",
      id: "q-paid",
      title: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美",
      durationSeconds: 269,
      availability: "paid_album",
    },
  ]);
  assert.equal(paidResult.status, "vip_only");
  assert.ok(paidResult.reason?.includes("数字专辑"));

  const restrictedResult = matchTransferTrack(sourceTrack, [
    {
      provider: "qq",
      id: "q-rest",
      title: "晴天",
      artists: ["周杰伦"],
      album: "叶惠美",
      durationSeconds: 269,
      availability: "restricted",
    },
  ]);
  assert.equal(restrictedResult.status, "copyright_unavailable");
  assert.ok(restrictedResult.reason?.includes("受限"));
});
