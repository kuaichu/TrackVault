import assert from "node:assert/strict";
import test from "node:test";
import {
  getRequiredClientSessionId,
  runWithRequestContext
} from "./request-context.js";

test("protected client session IDs accept only explicit bounded identifiers", () => {
  assert.equal(runWithRequestContext("valid_sid-123", () => getRequiredClientSessionId()), "valid_sid-123");

  for (const clientSessionId of [undefined, null, "", "default", "a!b", "a".repeat(65)]) {
    assert.throws(
      () => runWithRequestContext(clientSessionId, () => getRequiredClientSessionId()),
      /客户端会话标识/
    );
  }
});
