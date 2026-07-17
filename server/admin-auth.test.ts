import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { authenticateAdminToken, requireAdminAuth } from "./admin-auth.js";

test("authenticateAdminToken disables admin access when the server token is not configured", () => {
  const result = authenticateAdminToken("anything", undefined);

  assert.deepEqual(result, {
    ok: false,
    status: 503,
    code: "ADMIN_TOKEN_NOT_CONFIGURED",
    message: "服务端未配置管理员令牌，管理接口已禁用。"
  });
});

test("requireAdminAuth rejects admin operations when the server token is not configured", (context) => {
  const previousToken = process.env.TRACKVAULT_ADMIN_TOKEN;
  delete process.env.TRACKVAULT_ADMIN_TOKEN;
  context.after(() => {
    if (previousToken !== undefined) {
      process.env.TRACKVAULT_ADMIN_TOKEN = previousToken;
    }
  });

  let statusCode = 200;
  let responseBody: unknown;
  const request = { get: () => "anything" } as unknown as Request;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    }
  } as unknown as Response;

  requireAdminAuth(request, response, () => assert.fail("disabled admin middleware must not continue"));

  assert.equal(statusCode, 503);
  assert.deepEqual(responseBody, {
    code: "ADMIN_TOKEN_NOT_CONFIGURED",
    message: "服务端未配置管理员令牌，管理接口已禁用。"
  });
});

test("authenticateAdminToken rejects a missing request token", () => {
  const result = authenticateAdminToken(undefined, "server-secret");

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.status, 403);
  assert.equal(result.ok ? undefined : result.code, "ADMIN_TOKEN_INVALID");
});

test("authenticateAdminToken rejects an incorrect request token", () => {
  const result = authenticateAdminToken("wrong-secret", "server-secret");

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.status, 403);
});

test("authenticateAdminToken accepts the configured request token without returning it", () => {
  const adminToken = "server-secret";
  const result = authenticateAdminToken(adminToken, adminToken);

  assert.deepEqual(result, { ok: true });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(adminToken));
});

test("a logged-in demo or ordinary session cannot bypass a missing admin token", (context) => {
  const previousToken = process.env.TRACKVAULT_ADMIN_TOKEN;
  process.env.TRACKVAULT_ADMIN_TOKEN = "server-secret";
  context.after(() => {
    if (previousToken === undefined) {
      delete process.env.TRACKVAULT_ADMIN_TOKEN;
    } else {
      process.env.TRACKVAULT_ADMIN_TOKEN = previousToken;
    }
  });

  let statusCode = 200;
  let responseBody: unknown;
  let nextCalled = false;
  const request = {
    session: { loggedIn: true, profile: { provider: "demo" } },
    get: () => undefined
  } as unknown as Request;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    }
  } as unknown as Response;
  const next = (() => {
    nextCalled = true;
  }) as NextFunction;

  requireAdminAuth(request, response, next);

  assert.equal(statusCode, 403);
  assert.deepEqual(responseBody, {
    code: "ADMIN_TOKEN_INVALID",
    message: "管理员令牌缺失或错误。"
  });
  assert.equal(nextCalled, false);
});

test("requireAdminAuth passes a request with the correct admin token", (context) => {
  const previousToken = process.env.TRACKVAULT_ADMIN_TOKEN;
  process.env.TRACKVAULT_ADMIN_TOKEN = "server-secret";
  context.after(() => {
    if (previousToken === undefined) {
      delete process.env.TRACKVAULT_ADMIN_TOKEN;
    } else {
      process.env.TRACKVAULT_ADMIN_TOKEN = previousToken;
    }
  });

  let nextCalled = false;
  const request = {
    get: () => "server-secret"
  } as unknown as Request;
  const response = {} as Response;

  requireAdminAuth(request, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});
