import assert from "node:assert/strict";
import test from "node:test";
import type { RequestHandler } from "express";
import { ADMIN_TOKEN_HEADER, authenticateAdminToken } from "../admin-auth.js";
import type { AdminConfigUpdate, AdminConfigView } from "../types.js";
import { createAdminRouter, type AdminRouterDependencies } from "./admin-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

function createAuthMiddleware(configuredToken: string | undefined): RequestHandler {
  return (request, response, next) => {
    const result = authenticateAdminToken(request.get(ADMIN_TOKEN_HEADER), configuredToken);
    if (!result.ok) {
      response.status(result.status).json({ code: result.code, message: result.message });
      return;
    }
    next();
  };
}

const config: AdminConfigView = {
  trustedUserWhitelistText: "alice\nbob",
  hasSystemDefaultToken: true,
  systemFallbackEnabled: false
};

function createDependencies(requireAdminAuth: RequestHandler) {
  let getCalls = 0;
  const saved: AdminConfigUpdate[] = [];
  const dependencies = {
    requireAdminAuth,
    getAdminConfig: async () => {
      getCalls += 1;
      return config;
    },
    saveAdminConfig: async (input: AdminConfigUpdate) => {
      saved.push(input);
      return { ...config, systemFallbackEnabled: input.systemFallbackEnabled };
    }
  } satisfies AdminRouterDependencies;

  return {
    dependencies,
    getGetCalls: () => getCalls,
    saved
  };
}

test("admin router returns 503 when the server token is not configured", timeout, async () => {
  const fake = createDependencies(createAuthMiddleware(undefined));

  await withTestRouter([createAdminRouter(fake.dependencies)], async ({ request }) => {
    const response = await request("/api/admin/config", {
      headers: { [ADMIN_TOKEN_HEADER]: "anything" }
    });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      code: "ADMIN_TOKEN_NOT_CONFIGURED",
      message: "服务端未配置管理员令牌，管理接口已禁用。"
    });
  });

  assert.equal(fake.getGetCalls(), 0);
});

test("admin router rejects missing, incorrect, and demo-session credentials with 403", timeout, async () => {
  const fake = createDependencies(createAuthMiddleware("server-secret"));

  await withTestRouter([createAdminRouter(fake.dependencies)], async ({ request }) => {
    const missing = await request("/api/admin/config");
    assert.equal(missing.status, 403);

    const incorrect = await request("/api/admin/config", {
      headers: { [ADMIN_TOKEN_HEADER]: "wrong-secret" }
    });
    assert.equal(incorrect.status, 403);

    const demoSession = await request("/api/admin/config", {
      headers: {
        "x-client-session-id": "demo-session",
        "x-trackvault-session-provider": "demo"
      }
    });
    assert.equal(demoSession.status, 403);

    for (const response of [missing, incorrect, demoSession]) {
      assert.deepEqual(response.body, {
        code: "ADMIN_TOKEN_INVALID",
        message: "管理员令牌缺失或错误。"
      });
    }
  });

  assert.equal(fake.getGetCalls(), 0);
  assert.deepEqual(fake.saved, []);
});

test("admin GET and POST accept the correct token and forward the update once", timeout, async () => {
  const fake = createDependencies(createAuthMiddleware("server-secret"));

  await withTestRouter([createAdminRouter(fake.dependencies)], async ({ request, requestJson }) => {
    const headers = { [ADMIN_TOKEN_HEADER]: "server-secret" };
    const getResponse = await request("/api/admin/config", { headers });
    assert.equal(getResponse.status, 200);
    assert.deepEqual(getResponse.body, config);

    const update: AdminConfigUpdate = {
      trustedUserWhitelistText: "carol",
      systemDefaultToken: "replacement",
      systemFallbackEnabled: true
    };
    const postResponse = await requestJson("POST", "/api/admin/config", update, headers);
    assert.equal(postResponse.status, 200);
    assert.deepEqual(postResponse.body, { ...config, systemFallbackEnabled: true });
    assert.deepEqual(fake.saved, [update]);
  });

  assert.equal(fake.getGetCalls(), 1);
});
