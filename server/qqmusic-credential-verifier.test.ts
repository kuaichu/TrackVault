import assert from "node:assert/strict";
import test from "node:test";
import {
  createQqCredentialVerifier,
  QqCredentialVerificationError,
  type QqLoginStatusTransport
} from "./qqmusic-credential-verifier.js";

function loginResponse(uin: string, loginType = 1) {
  return {
    code: 0,
    req_0: {
      code: 0,
      data: { login_type: loginType, user_info: { uin } }
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

test("GetLoginUserInfo accepts an explicitly logged-in matching account", async () => {
  const result = await verifierWith(loginResponse("12345"))({ uin: "12345", qm_keyst: "original-secret" });
  assert.deepEqual(result, { uin: "12345" });
});

test("GetLoginUserInfo rejects an account mismatch", async () => {
  await assertErrorType(
    verifierWith(loginResponse("54321"))({ uin: "12345", qm_keyst: "original-secret" }),
    "credential_rejected"
  );
});

test("GetLoginUserInfo classifies provider rejection", async () => {
  await assertErrorType(
    verifierWith({ code: 0, req_0: { code: 2001, data: {} } })({ uin: "12345", qm_keyst: "original-secret" }),
    "credential_rejected"
  );
});

test("GetLoginUserInfo classifies mocked transport failure without leaking its details", async () => {
  const verify = createQqCredentialVerifier(async () => {
    throw new Error("secret URL, headers, cookie and response");
  });
  await assertErrorType(
    verify({ uin: "12345", qm_keyst: "original-secret" }),
    "network_failure"
  );
});

test("GetLoginUserInfo classifies malformed protocol responses", async () => {
  await assertErrorType(
    verifierWith({ code: 0, req_0: { code: 0, data: { login_type: 1 } } })({ uin: "12345", qm_keyst: "original-secret" }),
    "protocol_response_invalid"
  );
});
