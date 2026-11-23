import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNeteaseCookie } from "./netease-adapter.js";

test("normalizeNeteaseCookie strips Set-Cookie attributes and avoids os=pc -460 mismatch", () => {
  const raw =
    "MUSIC_U=abc123; Max-Age=31536000; Expires=Thu, 20 Nov 2036 00:00:00 GMT; Path=/; HttpOnly; __csrf=xyz789; os=pc";
  const normalized = normalizeNeteaseCookie(raw);

  assert.equal(normalized.includes("MUSIC_U=abc123"), true);
  assert.equal(normalized.includes("__csrf=xyz789"), true);
  assert.equal(normalized.includes("os=android"), true);
  assert.equal(normalized.includes("Max-Age"), false);
  assert.equal(normalized.includes("Expires"), false);
  assert.equal(normalized.includes("Path="), false);
  assert.equal(normalized.includes("HttpOnly"), false);
  assert.equal(normalized.includes("os=pc"), false);
});
