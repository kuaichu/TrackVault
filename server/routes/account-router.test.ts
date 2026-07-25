import assert from "node:assert/strict";
import test from "node:test";
import { getClientSessionId } from "../request-context.js";
import type { AccountState, AuthSession, QqMusicAccountStatus, QqMusicUserProfile } from "../types.js";
import { createAccountRouter, type AccountLoginInput, type AccountRouterDependencies } from "./account-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const loggedOutSession: AuthSession = { loggedIn: false, profile: null };
const loggedOutState: AccountState = { ...loggedOutSession, dataScopeId: "scope-out" };
const demoSession: AuthSession = {
  loggedIn: true,
  profile: {
    id: "demo-user",
    displayName: "Demo User",
    level: 8,
    vipEnabled: true,
    avatarSeed: "demo",
    provider: "demo",
    bio: "local account",
    favoriteGenres: [],
    lastLoginAt: "2026-07-26T00:00:00.000Z"
  }
};
const demoState: AccountState = { ...demoSession, dataScopeId: "scope-demo" };
const qqStatus: QqMusicAccountStatus = {
  ok: true,
  uin: "10001",
  displayName: "QQ User",
  vipEnabled: false,
  message: "ok"
};
const qqProfile: QqMusicUserProfile = {
  account: qqStatus,
  detail: { signature: "hello" },
  stats: {
    createdPlaylists: 0,
    collectedPlaylists: 0,
    collectedAlbums: 0,
    followSingers: 0,
    followUsers: 0,
    fans: 0
  },
  createdPlaylists: [],
  collectedPlaylists: [],
  collectedAlbums: [],
  followSingers: [],
  followUsers: [],
  fans: [],
  issues: []
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected account dependency call: ${name}`);
}

function createFailingDependencies(): AccountRouterDependencies {
  return {
    getAccountState: async () => unexpectedDependency("getAccountState"),
    loginSession: async () => unexpectedDependency("loginSession"),
    logoutSession: async () => unexpectedDependency("logoutSession"),
    getQqMusicAccountStatus: async () => unexpectedDependency("getQqMusicAccountStatus"),
    getQqMusicUserProfile: async () => unexpectedDependency("getQqMusicUserProfile"),
    startQqMusicQrLogin: async () => unexpectedDependency("startQqMusicQrLogin"),
    checkQqMusicQrLogin: async () => unexpectedDependency("checkQqMusicQrLogin"),
    logoutQqMusicSession: async () => unexpectedDependency("logoutQqMusicSession"),
    startNeteaseQrLogin: async () => unexpectedDependency("startNeteaseQrLogin"),
    checkNeteaseQrLogin: async () => unexpectedDependency("checkNeteaseQrLogin"),
    sendNeteaseCaptcha: async () => unexpectedDependency("sendNeteaseCaptcha"),
    loginWithNeteaseCellphone: async () => unexpectedDependency("loginWithNeteaseCellphone")
  };
}

test("account GET returns state once and receives the request SID context", timeout, async () => {
  let calls = 0;
  let observedSessionId = "";
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    getAccountState: async () => {
      calls += 1;
      observedSessionId = getClientSessionId();
      return loggedOutState;
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/account?sid=account-sid");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, loggedOutState);
  });

  assert.equal(calls, 1);
  assert.equal(observedSessionId, "account-sid");
});

test("demo login maps parameters and passes the returned session as the state override", timeout, async () => {
  const loginInputs: AccountLoginInput[] = [];
  const stateOverrides: (AuthSession | undefined)[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    loginSession: async (input) => {
      loginInputs.push(input);
      return demoSession;
    },
    getAccountState: async (sessionOverride) => {
      stateOverrides.push(sessionOverride);
      return demoState;
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/account/login", {
      accountName: "Demo User",
      vipEnabled: "enabled",
      note: 42
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, demoState);
  });

  assert.deepEqual(loginInputs, [{ accountName: "Demo User", vipEnabled: true, note: "" }]);
  assert.deepEqual(stateOverrides, [demoSession]);
});

test("netease/local logout calls only the session logout chain and preserves its override", timeout, async () => {
  let logoutCalls = 0;
  const stateOverrides: (AuthSession | undefined)[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    logoutSession: async () => {
      logoutCalls += 1;
      return loggedOutSession;
    },
    getAccountState: async (sessionOverride) => {
      stateOverrides.push(sessionOverride);
      return loggedOutState;
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/account/logout", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, loggedOutState);
  });

  assert.equal(logoutCalls, 1);
  assert.deepEqual(stateOverrides, [loggedOutSession]);
});

test("QQ status and profile preserve 200 responses and profile failures remain 401", timeout, async () => {
  let statusCalls = 0;
  let profileCalls = 0;
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    getQqMusicAccountStatus: async () => {
      statusCalls += 1;
      return qqStatus;
    },
    getQqMusicUserProfile: async () => {
      profileCalls += 1;
      if (profileCalls === 2) {
        throw new Error("QQ session expired");
      }
      return qqProfile;
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ request }) => {
    const status = await request("/api/account/qqmusic");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, qqStatus);

    const profile = await request("/api/account/qqmusic/profile");
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body, { profile: qqProfile });

    const unauthorized = await request("/api/account/qqmusic/profile");
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(unauthorized.body, { message: "QQ session expired" });
  });

  assert.equal(statusCalls, 1);
  assert.equal(profileCalls, 2);
});

test("QQ QR start and check preserve success mapping and 500 failures", timeout, async () => {
  let startCalls = 0;
  const checkedKeys: string[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    startQqMusicQrLogin: async () => {
      startCalls += 1;
      if (startCalls === 2) {
        throw new Error("QQ QR start failed");
      }
      return { key: "qq-key", qrImage: "data:image/png;base64,qq" };
    },
    checkQqMusicQrLogin: async (key) => {
      checkedKeys.push(key);
      if (key === "bad") {
        throw new Error("QQ QR check failed");
      }
      return { code: 66, message: "waiting" };
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ request, requestJson }) => {
    const started = await requestJson("POST", "/api/account/qqmusic/qr/start", {});
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { key: "qq-key", qrImage: "data:image/png;base64,qq" });

    const startFailure = await requestJson("POST", "/api/account/qqmusic/qr/start", {});
    assert.equal(startFailure.status, 500);
    assert.deepEqual(startFailure.body, { message: "QQ QR start failed" });

    const checked = await request("/api/account/qqmusic/qr/check?key=qq-key");
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body, { code: 66, message: "waiting" });

    const checkFailure = await request("/api/account/qqmusic/qr/check?key=bad");
    assert.equal(checkFailure.status, 500);
    assert.deepEqual(checkFailure.body, { message: "QQ QR check failed" });
  });

  assert.equal(startCalls, 2);
  assert.deepEqual(checkedKeys, ["qq-key", "bad"]);
});

test("QQ logout invokes only the QQ cleanup dependency", timeout, async () => {
  let qqLogoutCalls = 0;
  const loggedOutQq: QqMusicAccountStatus = {
    ok: false,
    uin: null,
    displayName: null,
    vipEnabled: false,
    message: "已退出 QQ 音乐账号"
  };
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    logoutQqMusicSession: async () => {
      qqLogoutCalls += 1;
      return loggedOutQq;
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/account/qqmusic/logout", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, loggedOutQq);
  });

  assert.equal(qqLogoutCalls, 1);
});

test("Netease QR start and check preserve success mapping and 500 failures", timeout, async () => {
  let startCalls = 0;
  const checkedKeys: string[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    startNeteaseQrLogin: async () => {
      startCalls += 1;
      if (startCalls === 2) {
        throw { reason: "not-an-error" };
      }
      return { key: "netease-key", qrImage: "data:image/png;base64,netease", qrUrl: "https://example.invalid/qr" };
    },
    checkNeteaseQrLogin: async (key) => {
      checkedKeys.push(key);
      if (key === "bad") {
        throw new Error("Netease QR check failed");
      }
      return { code: 801, message: "waiting" };
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ request, requestJson }) => {
    const started = await requestJson("POST", "/api/account/netease/qr/start", {});
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, {
      key: "netease-key",
      qrImage: "data:image/png;base64,netease",
      qrUrl: "https://example.invalid/qr"
    });

    const startFailure = await requestJson("POST", "/api/account/netease/qr/start", {});
    assert.equal(startFailure.status, 500);
    assert.deepEqual(startFailure.body, { message: "二维码登录初始化失败" });

    const checked = await request("/api/account/netease/qr/check?key=netease-key");
    assert.equal(checked.status, 200);
    assert.deepEqual(checked.body, { code: 801, message: "waiting" });

    const checkFailure = await request("/api/account/netease/qr/check?key=bad");
    assert.equal(checkFailure.status, 500);
    assert.deepEqual(checkFailure.body, { message: "Netease QR check failed" });
  });

  assert.equal(startCalls, 2);
  assert.deepEqual(checkedKeys, ["netease-key", "bad"]);
});

test("captcha send maps default and explicit country codes and retains the 500 fallback", timeout, async () => {
  const calls: { phone: string; countryCode: string | undefined }[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    sendNeteaseCaptcha: async (phone, countryCode) => {
      calls.push({ phone, countryCode });
      if (phone === "fail") {
        throw { reason: "not-an-error" };
      }
      return { code: 200, message: "sent", sent: true };
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ requestJson }) => {
    const defaultCountry = await requestJson("POST", "/api/account/netease/captcha/send", { phone: "13000000000" });
    assert.equal(defaultCountry.status, 200);

    const explicitCountry = await requestJson("POST", "/api/account/netease/captcha/send", {
      phone: "2025550100",
      countryCode: "1"
    });
    assert.equal(explicitCountry.status, 200);

    const failure = await requestJson("POST", "/api/account/netease/captcha/send", { phone: "fail" });
    assert.equal(failure.status, 500);
    assert.deepEqual(failure.body, { message: "验证码发送失败" });
  });

  assert.deepEqual(calls, [
    { phone: "13000000000", countryCode: "86" },
    { phone: "2025550100", countryCode: "1" },
    { phone: "fail", countryCode: "86" }
  ]);
});

test("cellphone login maps parameters and default country code and retains the 500 fallback", timeout, async () => {
  const calls: { phone: string; captcha: string; countryCode: string | undefined }[] = [];
  const dependencies: AccountRouterDependencies = {
    ...createFailingDependencies(),
    loginWithNeteaseCellphone: async (phone, captcha, countryCode) => {
      calls.push({ phone, captcha, countryCode });
      if (phone === "fail") {
        throw { reason: "not-an-error" };
      }
      return { code: 200, message: "logged in", session: demoSession };
    }
  };

  await withTestRouter([createAccountRouter(dependencies)], async ({ requestJson }) => {
    const defaultCountry = await requestJson("POST", "/api/account/netease/cellphone/login", {
      phone: "13000000000",
      captcha: "1234"
    });
    assert.equal(defaultCountry.status, 200);
    assert.deepEqual(defaultCountry.body, { code: 200, message: "logged in", session: demoSession });

    const explicitCountry = await requestJson("POST", "/api/account/netease/cellphone/login", {
      phone: "2025550100",
      captcha: "5678",
      countryCode: "1"
    });
    assert.equal(explicitCountry.status, 200);

    const failure = await requestJson("POST", "/api/account/netease/cellphone/login", { phone: "fail", captcha: "0000" });
    assert.equal(failure.status, 500);
    assert.deepEqual(failure.body, { message: "手机号登录失败" });
  });

  assert.deepEqual(calls, [
    { phone: "13000000000", captcha: "1234", countryCode: "86" },
    { phone: "2025550100", captcha: "5678", countryCode: "1" },
    { phone: "fail", captcha: "0000", countryCode: "86" }
  ]);
});

test("unknown account paths fall through to the downstream 404 without invoking dependencies", timeout, async () => {
  await withTestRouter([createAccountRouter(createFailingDependencies())], async ({ request }) => {
    const response = await request("/api/account/not-a-route");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { message: "test fallback" });
  });
});
