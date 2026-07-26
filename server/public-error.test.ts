import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  PUBLIC_ERROR_MESSAGES,
  safeHttpErrorHandler,
  toExpressError
} from "./public-error.js";
import { withTestRouter } from "./routes/router-test-http.js";

const timeout = { timeout: 5_000 };

test("toExpressError preserves Error instances and wraps every Express control-like value", () => {
  const existing = new Error("internal-only");
  assert.equal(toExpressError(existing, "fallback"), existing);

  for (const thrownValue of [null, undefined, false, 0, "", "route", "router"]) {
    const normalized = toExpressError(thrownValue, "fixed internal description");
    assert.ok(normalized instanceof Error);
    assert.equal(normalized.message, "fixed internal description");
  }
});

test("real Express error middleware safely terminates Error and non-Error throws", timeout, async () => {
  const secret = "express-throw-secret-sentinel";
  const thrownValues: unknown[] = [
    null,
    undefined,
    false,
    0,
    "",
    "route",
    "router",
    Object.assign(new Error(secret), { cause: { headers: { cookie: secret } } })
  ];
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);

  process.on("unhandledRejection", onUnhandledRejection);
  try {
    for (const thrownValue of thrownValues) {
      const router = express.Router();
      router.get("/throws", (_request, _response, next) => {
        try {
          throw thrownValue;
        } catch (error) {
          next(toExpressError(error, "Router threw a non-Error value"));
        }
      });

      await withTestRouter([router, safeHttpErrorHandler], async ({ request }) => {
        const response = await request("/throws", { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { message: PUBLIC_ERROR_MESSAGES.internalServer });
        assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
      });
    }

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});
