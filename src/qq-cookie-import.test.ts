import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { QQ_COOKIE_EXTRACT_SCRIPT, validateQqCookieInput } from "./qq-cookie-import";

test("QQ cookie preflight accepts normal and WeChat login cookies with statistics fields", () => {
  assert.deepEqual(validateQqCookieInput("uin=12345; qm_keyst=key; pgv_pvid=statistics-cookie").missingFields, []);
  assert.deepEqual(validateQqCookieInput("login_type=2; wxuin=o24680; qqmusic_key=key; pgv_pvid=statistics-cookie").missingFields, []);
});

test("QQ cookie preflight returns only missing field names", () => {
  assert.deepEqual(validateQqCookieInput("qm_keyst=secret-value; pgv_pvid=statistics-cookie").missingFields, ["uin/wxuin"]);
  assert.deepEqual(validateQqCookieInput("uin=12345; pgv_pvid=statistics-cookie").missingFields, ["qm_keyst/qqmusic_key"]);
});

test("QQ extraction script does not copy incomplete cookies and directs users to Cookies panel", async () => {
  let copied = "";
  let promptMessage = "";
  const context = {
    document: { cookie: "pgv_pvid=statistics-cookie; qm_keyst=secret-value" },
    navigator: { clipboard: { writeText: async (value: string) => { copied = value; } } },
    alert: () => undefined,
    window: { prompt: (message: string) => { promptMessage = message; return null; } }
  };
  vm.runInNewContext(QQ_COOKIE_EXTRACT_SCRIPT, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(copied, "");
  assert.match(promptMessage, /uin\/wxuin/);
  assert.match(promptMessage, /Cookies 面板/);
  assert.doesNotMatch(promptMessage, /secret-value|statistics-cookie/);
});
