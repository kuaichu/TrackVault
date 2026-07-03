import assert from "node:assert/strict";
import test from "node:test";
import { findMembershipExpireAt, formatMembershipExpireText } from "./membership-utils.js";

test("findMembershipExpireAt reads nested millisecond timestamps", () => {
  const timestamp = Date.UTC(2026, 10, 15);
  assert.equal(findMembershipExpireAt({ data: { redVip: { expireTime: timestamp } } }), timestamp);
});

test("findMembershipExpireAt ignores vip type numbers that are not expiry dates", () => {
  assert.equal(findMembershipExpireAt({ profile: { vipType: 11 } }), undefined);
});

test("formatMembershipExpireText formats membership expiry dates", () => {
  assert.equal(formatMembershipExpireText(Date.UTC(2026, 10, 15)), "2026/11/15");
});
