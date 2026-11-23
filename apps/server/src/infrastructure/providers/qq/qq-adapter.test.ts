import assert from "node:assert/strict";
import test from "node:test";
import { SafeHttpClient } from "../../security/safe-http-client.js";
import { QqMusicAdapter } from "./qq-adapter.js";
import { computeQqGtk, extractEssentialQqCookie, parseQqCookie } from "./qq-cookie.js";

test("parseQqCookie preserves Base64 '=' padding and extracts essential keys", () => {
  const raw = "uin=o12345678; qm_keyst=Q_H_L_abc==; p_skey=xyz123=; tracking_junk=dropme";
  const parsed = parseQqCookie(raw);
  assert.equal(parsed.uin, "12345678");
  assert.equal(parsed.qm_keyst, "Q_H_L_abc==");
  assert.equal(parsed.p_skey, "xyz123=");

  const essential = extractEssentialQqCookie(raw);
  assert.equal(essential.tracking_junk, undefined);
  assert.equal(essential.qm_keyst, "Q_H_L_abc==");
  assert.notEqual(computeQqGtk(essential), 5381);
});

test("QqMusicAdapter.verifyCredential returns ok:false on upstream error and keeps concurrent cookies isolated", async () => {
  const seenCookies: string[] = [];
  const failingHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get("cookie") ?? "");
      return new Response(JSON.stringify({ code: 1000, msg: "not logged in" }), { status: 200 });
    },
  });

  const adapter = new QqMusicAdapter(failingHttp);
  const bad = await adapter.verifyCredential("uin=11111; qm_keyst=expired_token");
  assert.equal(bad.ok, false);

  // Verify concurrent requests for two users carry strictly separate cookies
  const observedByUin = new Map<string, string>();
  const concurrentHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (_url, init) => {
      const headers = new Headers(init?.headers);
      const cookie = headers.get("cookie") ?? "";
      const uin = /uin=(\d+)/.exec(cookie)?.[1] ?? "none";
      observedByUin.set(uin, cookie);
      await new Promise((r) => setTimeout(r, uin === "1001" ? 20 : 5));
      return new Response(
        JSON.stringify({
          code: 0,
          data: { creator: { nick: `User-${uin}` }, vip: { greenvip: uin === "1001" ? 1 : 0 } },
        }),
        { status: 200 },
      );
    },
  });

  const concurrentAdapter = new QqMusicAdapter(concurrentHttp);
  const [resA, resB] = await Promise.all([
    concurrentAdapter.verifyCredential("uin=1001; qm_keyst=KEY_A"),
    concurrentAdapter.verifyCredential("uin=2002; qm_keyst=KEY_B"),
  ]);

  assert.equal(resA.ok, true);
  assert.equal(resA.vipEnabled, true);
  assert.equal(resB.ok, true);
  assert.equal(resB.vipEnabled, false);
  assert.ok(observedByUin.get("1001")?.includes("KEY_A"));
  assert.ok(!observedByUin.get("1001")?.includes("KEY_B"));
  assert.ok(observedByUin.get("2002")?.includes("KEY_B"));
  assert.ok(!observedByUin.get("2002")?.includes("KEY_A"));
});
