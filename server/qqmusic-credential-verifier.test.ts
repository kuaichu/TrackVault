import assert from "node:assert/strict";
import test from "node:test";
import {
  createQqCredentialVerifier,
  fetchQqLoginStatus,
  QqCredentialVerificationError,
  type QqLoginStatusTransport
} from "./qqmusic-credential-verifier.js";

function loginResponse(userInfo?: Record<string, unknown>) {
  return {
    code: 0,
    ts: 1730000000000,
    start_ts: 1730000000000,
    req_0: {
      code: 0,
      data: {
        base: { is_login: true },
        ...(userInfo ? { user_info: userInfo } : {})
      }
    }
  };
}

function verifierWith(response: unknown) {
  const transport: QqLoginStatusTransport = async (request, cookie) => {
    assert.deepEqual(request, {
      comm: { ct: 24, cv: 0, format: "json", uin: "12345" },
      req_0: {
        module: "music.UserInfo.userInfoServer",
        method: "GetLoginUserInfo",
        param: {}
      }
    });
    assert.equal(cookie.qm_keyst, "original-secret");
    return response;
  };
  return createQqCredentialVerifier(transport);
}

async function assertErrorType(operation: Promise<unknown>, errorType: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof QqCredentialVerificationError);
    assert.equal(error.errorType, errorType);
    assert.equal(error.message, errorType);
    return true;
  });
}

test("GetLoginUserInfo accepts a realistic success envelope without login_type or user_info", async () => {
  const result = await verifierWith(loginResponse())({ uin: "12345", qm_keyst: "original-secret" });
  assert.deepEqual(result, { uin: "12345" });
});

test("GetLoginUserInfo accepts a matching reliable response account ID", async () => {
  const result = await verifierWith(loginResponse({ uin: 12345, nick: "fixture-user" }))(
    { uin: "12345", qm_keyst: "original-secret" }
  );
  assert.deepEqual(result, { uin: "12345" });
});

test("GetLoginUserInfo rejects an account mismatch", async () => {
  await assertErrorType(
    verifierWith(loginResponse({ uin: "54321" }))({ uin: "12345", qm_keyst: "original-secret" }),
    "credential_rejected"
  );
});

test("GetLoginUserInfo classifies known provider codes", async () => {
  for (const code of [1000, 104400, 104401]) {
    await assertErrorType(
      verifierWith({ code: 0, req_0: { code, data: {} } })({ uin: "12345", qm_keyst: "original-secret" }),
      "credential_rejected"
    );
    await assertErrorType(
      verifierWith({ code })({ uin: "12345", qm_keyst: "original-secret" }),
      "credential_rejected"
    );
  }
  for (const code of [2001, 429]) {
    await assertErrorType(
      verifierWith({ code: 0, req_0: { code, data: {} } })({ uin: "12345", qm_keyst: "original-secret" }),
      "rate_limited"
    );
  }
  await assertErrorType(
    verifierWith({ code: 0, req_0: { code: 987654, data: {} } })({ uin: "12345", qm_keyst: "original-secret" }),
    "protocol_response_invalid"
  );
});

test("GetLoginUserInfo classifies mocked transport failure without leaking its details", async () => {
  const verify = createQqCredentialVerifier(async () => {
    throw new Error("secret URL, headers, cookie and response");
  });
  await assertErrorType(
    verify({ uin: "12345", qm_keyst: "original-secret" }),
    "temporary_failure"
  );
});

test("GetLoginUserInfo classifies malformed protocol responses", async () => {
  await assertErrorType(
    verifierWith({ code: 0, req_0: { data: {} } })({ uin: "12345", qm_keyst: "original-secret" }),
    "protocol_response_invalid"
  );
});

test("GetLoginUserInfo rejects a submitted UIN with mixed characters before transport", async () => {
  let calls = 0;
  const verify = createQqCredentialVerifier(async () => {
    calls += 1;
    return loginResponse();
  });
  await assertErrorType(verify({ uin: "12abc34", qm_keyst: "original-secret" }), "credential_rejected");
  assert.equal(calls, 0);
});

test("GetLoginUserInfo transport maps HTTP failures and includes an abort signal", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const request = {
    comm: { ct: 24, cv: 0, format: "json" as const, uin: "12345" },
    req_0: {
      module: "music.UserInfo.userInfoServer" as const,
      method: "GetLoginUserInfo" as const,
      param: {}
    }
  };

  let capturedSignal: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    capturedSignal = init?.signal as AbortSignal;
    return new Response("{}", { status: 429 });
  };
  await assertErrorType(fetchQqLoginStatus(request, { uin: "12345" }), "rate_limited");
  assert.ok(capturedSignal instanceof AbortSignal);

  globalThis.fetch = async () => new Response("{}", { status: 503 });
  await assertErrorType(fetchQqLoginStatus(request, { uin: "12345" }), "temporary_failure");

  globalThis.fetch = async () => new Response("{}", { status: 404 });
  await assertErrorType(fetchQqLoginStatus(request, { uin: "12345" }), "protocol_response_invalid");

  globalThis.fetch = async () => { throw new TypeError("synthetic network failure"); };
  await assertErrorType(fetchQqLoginStatus(request, { uin: "12345" }), "temporary_failure");
});
