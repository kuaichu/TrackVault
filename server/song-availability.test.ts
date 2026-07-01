import assert from "node:assert/strict";
import test from "node:test";
import { getNeteaseSongAvailability } from "./song-availability.js";

test("getNeteaseSongAvailability locks VIP playback and download when privilege bitrate is zero", () => {
  const availability = getNeteaseSongAvailability({
    fee: 1,
    privilege: {
      fee: 1,
      pl: 0,
      dl: 0
    }
  });

  assert.equal(availability?.playback.status, "vip");
  assert.equal(availability?.playback.locked, true);
  assert.equal(availability?.download.status, "vip");
  assert.equal(availability?.download.locked, true);
});

test("getNeteaseSongAvailability reports copyright unavailable songs", () => {
  const availability = getNeteaseSongAvailability({
    st: -200,
    noCopyrightRcmd: { type: 1 },
    privilege: {
      pl: 0,
      dl: 0
    }
  });

  assert.equal(availability?.playback.status, "copyright");
  assert.equal(availability?.playback.locked, true);
  assert.equal(availability?.download.status, "copyright");
  assert.equal(availability?.download.locked, true);
});

test("getNeteaseSongAvailability warns but does not lock unclear non-VIP download limits", () => {
  const availability = getNeteaseSongAvailability({
    fee: 8,
    privilege: {
      fee: 8,
      pl: 320000,
      dl: 0
    }
  });

  assert.equal(availability?.playback.status, "available");
  assert.equal(availability?.playback.locked, false);
  assert.equal(availability?.download.status, "restricted");
  assert.equal(availability?.download.locked, false);
});
