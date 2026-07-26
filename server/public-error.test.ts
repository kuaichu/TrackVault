import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { registerHttpJsonBodyParsers } from "./http-json-body.js";
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

test("malformed and truncated JSON receive the fixed public 400 contract without parser detail leakage", timeout, async () => {
  const secret = "parser-error-secret-sentinel";
  const router = express.Router();
  router.post("/json", (_request, response) => {
    response.status(204).end();
  });
  const attachParserSentinels: ErrorRequestHandler = (error: unknown, _request, _response, next) => {
    if (error instanceof Error) {
      Object.assign(error, {
        message: secret,
        body: secret,
        cause: { headers: { cookie: secret } }
      });
    }
    next(error);
  };

  await withTestRouter([router, attachParserSentinels, safeHttpErrorHandler], async ({ request }) => {
    for (const body of [
      `{"secret":"${secret}","broken":}`,
      "{",
      "["
    ]) {
      const response = await request("/json", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(1_000)
      });

      assert.equal(response.status, 400);
      assert.deepEqual(response.body, {
        code: "INVALID_JSON_BODY",
        message: "请求 JSON 格式无效。"
      });
      assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
    }
  }, { registerJsonBodyParsers: registerHttpJsonBodyParsers });
});

test("JSON bodies over 2 MiB receive the fixed public 413 contract without reflecting content", timeout, async () => {
  const secret = "oversized-parser-body-secret-sentinel";
  const router = express.Router();
  router.post("/json", (_request, response) => {
    response.status(204).end();
  });

  await withTestRouter([router, safeHttpErrorHandler], async ({ request }) => {
    const response = await request("/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, padding: "x".repeat(2 * 1024 * 1024) }),
      signal: AbortSignal.timeout(3_000)
    });

    assert.equal(response.status, 413);
    assert.deepEqual(response.body, {
      code: "REQUEST_BODY_TOO_LARGE",
      message: "请求体超过允许大小。"
    });
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(secret));
  }, { registerJsonBodyParsers: registerHttpJsonBodyParsers });
});

test("the global strict parser maps primitive JSON to the fixed public 400 contract", timeout, async () => {
  let routeCalls = 0;
  const router = express.Router();
  router.post("/ordinary", (_request, response) => {
    routeCalls += 1;
    response.status(204).end();
  });

  await withTestRouter([router, safeHttpErrorHandler], async ({ requestJson }) => {
    const response = await requestJson("POST", "/ordinary", "primitive");
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      code: "INVALID_JSON_BODY",
      message: "请求 JSON 格式无效。"
    });
  }, { registerJsonBodyParsers: registerHttpJsonBodyParsers });

  assert.equal(routeCalls, 0);
});

test("headers already sent errors are normalized and forwarded without another response", () => {
  let statusCalls = 0;
  let jsonCalls = 0;
  let forwarded: unknown;
  const response = {
    headersSent: true,
    status: () => {
      statusCalls += 1;
      return response;
    },
    json: () => {
      jsonCalls += 1;
      return response;
    }
  } as unknown as Response;
  const next = ((error?: unknown) => {
    forwarded = error;
  }) as NextFunction;

  safeHttpErrorHandler("route", {} as Request, response, next);

  assert.equal(statusCalls, 0);
  assert.equal(jsonCalls, 0);
  assert.ok(forwarded instanceof Error);
  assert.equal(forwarded.message, "HTTP request failed after response headers were sent");
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
    Object.assign(new Error(secret), { cause: { headers: { cookie: secret } } }),
    Object.assign(new Error(secret), { status: 500, type: "entity.parse.failed", body: secret }),
    Object.assign(new Error(secret), { status: 400, type: "entity.too.large", body: secret })
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
