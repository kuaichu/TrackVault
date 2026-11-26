import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Duplex } from "node:stream";
import test from "node:test";
import { AppError } from "../../../domain/errors.js";
import {
  type MusicProviderAdapter,
  type ProviderAuthContext,
  supportsPlaylistMutation,
} from "../../../domain/ports/music-provider.js";
import { SafeHttpClient } from "../../security/safe-http-client.js";
import { QqMusicAdapter } from "./qq-adapter.js";
import { computeQqGtk, extractEssentialQqCookie, hash33, parseQqCookie } from "./qq-cookie.js";

const qqAuth: ProviderAuthContext = {
  platform: "qq",
  cookie: "uin=123456; qm_keyst=Q_H_L_TOKEN; p_skey=PSK",
  scopeKey: "user-1",
  accountUid: "123456",
};

test("parseQqCookie strips Cookie: prefix, supports multiline paste, preserves Base64 '=' padding (C041)", () => {
  const raw = "Cookie: uin=o12345678;\nCookie: qm_keyst=Q_H_L_abc==; p_skey=xyz123=;\r\ntracking_junk=dropme";
  const parsed = parseQqCookie(raw);
  assert.equal(parsed.uin, "12345678");
  assert.equal(parsed.qm_keyst, "Q_H_L_abc==");
  assert.equal(parsed.p_skey, "xyz123=");

  const essential = extractEssentialQqCookie(raw);
  assert.equal(essential.tracking_junk, undefined);
  assert.equal(essential.qm_keyst, "Q_H_L_abc==");
  assert.equal(computeQqGtk(essential), hash33("Q_H_L_abc==", 5381));
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

test("QqMusicAdapter.getLyrics prefers non-numeric songId (songmid) over mediaId (BUG-13)", async () => {
  const seenSongMids: string[] = [];
  const http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      seenSongMids.push(parsed.searchParams.get("songmid") ?? "");
      return new Response(
        JSON.stringify({ lyric: Buffer.from("[00:01.00]故事的小黄花", "utf8").toString("base64") }),
        { status: 200 },
      );
    },
  });

  const adapter = new QqMusicAdapter(http);
  const lyrics1 = await adapter.getLyrics("0039MnYb0qxYhV", "0025NhlN2yWrP4", qqAuth);
  assert.equal(seenSongMids[0], "0039MnYb0qxYhV");
  assert.equal(lyrics1.lines[0]?.text, "故事的小黄花");

  // When songId is purely numeric, fall back to non-numeric mediaId
  await adapter.getLyrics("97773", "0044OtherMid", qqAuth);
  assert.equal(seenSongMids[1], "0044OtherMid");
});

function wrapServerWsFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  const head = Buffer.allocUnsafe(4);
  head[0] = 0x80 | opcode;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function encodeMqttUtf8(str: string): Buffer {
  const b = Buffer.from(str, "utf8");
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function encodeMqttVarInt(val: number): Buffer {
  const out: number[] = [];
  let n = val;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

function createInMemoryDuplexPair(): { clientSide: Duplex; serverSide: Duplex; destroyed: () => boolean } {
  let isDestroyed = false;
  const holder: { client?: Duplex } = {};
  const serverSide = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      holder.client?.push(chunk);
      cb();
    },
  });
  const clientSide = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      serverSide.push(chunk);
      cb();
    },
    destroy(err, cb) {
      isDestroyed = true;
      serverSide.destroy();
      cb(err);
    },
  });
  holder.client = clientSide;
  return { clientSide, serverSide, destroyed: () => isDestroyed };
}

test("QqMusicAdapter multi-channel QR login: QQ OAuth 716027609, WeChat 64-bit uin, and Mobile App MQTT 5.0", async () => {
  // 1) Channel "qq": QQ Connect OAuth (appid=716027609, daid=383, pt_3rd_aid=100497308) + QQConnectLogin
  const seenQrUrls: string[] = [];
  const createQqOAuthHttp = (blockOAuth: boolean) =>
    new SafeHttpClient({
      resolveHost: async () => [{ address: "1.2.3.4" }],
      fetchImpl: async (url, init) => {
        const u = String(url);
        seenQrUrls.push(u);
        if (u.includes("/ptqrshow")) {
          const h = new Headers();
          h.append("set-cookie", "qrsig=QRSIG456; Path=/");
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: h });
        }
        if (u.includes("/ptqrlogin")) {
          return new Response(
            "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?sig=1','0','登录成功','Tester')",
            { status: 200 },
          );
        }
        if (u.includes("check_sig")) {
          const h = new Headers({ location: "https://graph.qq.com/oauth2.0/login_jump" });
          h.append("set-cookie", "uin=o123456; Path=/");
          h.append("set-cookie", "p_skey=GRAPH_PSKEY_789; Path=/; Domain=graph.qq.com");
          h.append("set-cookie", "p_skey=; Path=/; Domain=ptlogin2.qq.com");
          return new Response(null, { status: 302, headers: h });
        }
        if (u.includes("graph.qq.com/oauth2.0/authorize")) {
          if (blockOAuth) {
            return new Response("blocked", { status: 200 });
          }
          return new Response(null, {
            status: 302,
            headers: { location: "https://y.qq.com/portal/wx_redirect.html?code=OAUTH_CODE_99&state=state" },
          });
        }
        if (u.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            req?: { module?: string; method?: string };
          };
          assert.equal(body.req?.module, "QQConnectLogin.LoginServer");
          assert.equal(body.req?.method, "QQLogin");
          return new Response(
            JSON.stringify({
              code: 0,
              req: {
                code: 0,
                data: { musickey: "Q_H_L_EXCHANGED_KEY", musicid: 123456, str_musicid: "123456" },
              },
            }),
            { status: 200 },
          );
        }
        if (u.includes("fcg_get_profile_homepage.fcg")) {
          return new Response(JSON.stringify({ code: 0, data: { creator: { nick: "Tester" } } }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

  const okAdapter = new QqMusicAdapter(createQqOAuthHttp(false));
  assert.deepEqual(okAdapter.capabilities.qrLoginChannels, ["mobile", "qq", "wx"]);
  const startOk = await okAdapter.startQrLogin("user-1", { channel: "qq" });
  assert.equal(startOk.channel, "qq");
  assert.ok(seenQrUrls[0]?.includes("appid=716027609"));
  assert.ok(seenQrUrls[0]?.includes("pt_3rd_aid=100497308"));
  const checkOk = await okAdapter.checkQrLogin("user-1", startOk.key);
  assert.equal(checkOk.status, "confirmed");
  assert.ok(checkOk.rawCookie?.includes("qm_keyst=Q_H_L_EXCHANGED_KEY"));
  assert.equal(checkOk.verification?.ok, true);

  const blockedAdapter = new QqMusicAdapter(createQqOAuthHttp(true));
  const startBlocked = await blockedAdapter.startQrLogin("user-1", { channel: "qq" });
  const checkBlocked = await blockedAdapter.checkQrLogin("user-1", startBlocked.key);
  assert.equal(checkBlocked.status, "error");
  assert.ok(checkBlocked.message.includes("Cookie") || checkBlocked.message.includes("QQ 音乐 App"));

  // 2) Channel "wx": WeChat QR handles long-poll timeout as waiting + preserves 64-bit str_musicid
  let wxPollCount = 0;
  const wx64BitId = "1152921504606846977";
  let seenMusicuCommLoginType: number | undefined;
  const wxHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("open.weixin.qq.com/connect/qrconnect")) {
        return new Response('<img src="/connect/qrcode/WX_UUID_01" />', { status: 200 });
      }
      if (u.includes("open.weixin.qq.com/connect/qrcode/WX_UUID_01")) {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      if (u.includes("lp.open.weixin.qq.com/connect/l/qrconnect")) {
        wxPollCount += 1;
        if (wxPollCount === 1) {
          const err = new Error("poll timeout");
          err.name = "TimeoutError";
          throw err;
        }
        if (wxPollCount === 2) {
          return new Response("window.wx_errcode=404;window.wx_code='';", { status: 200 });
        }
        return new Response("window.wx_errcode=405;window.wx_code='WX_CODE_OK';", { status: 200 });
      }
      if (u.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
        const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
          comm?: { tmeLoginType?: string | number };
          req?: { module?: string };
        };
        if (parsedBody.req?.module === "music.login.LoginServer") {
          return new Response(
            `{"code":0,"req":{"code":0,"data":{"musicid":1152921504606846977,"str_musicid":"${wx64BitId}","musickey":"W_X_TOKEN_88","loginType":1,"nick":"WeChatListener"}}}`,
            { status: 200 },
          );
        }
        seenMusicuCommLoginType = Number(parsedBody.comm?.tmeLoginType);
        return new Response(JSON.stringify({ new_song: { data: { songlist: [] } } }), { status: 200 });
      }
      if (u.includes("fcg_get_profile_homepage.fcg")) {
        return new Response(JSON.stringify({ code: 0, data: { creator: { nick: "" } } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const wxAdapter = new QqMusicAdapter(wxHttp);
  const wxStart = await wxAdapter.startQrLogin("user-wx", { channel: "wx" });
  assert.equal(wxStart.channel, "wx");
  assert.ok(wxStart.qrImage.startsWith("data:image/jpeg;base64,"));

  const wxWait = await wxAdapter.checkQrLogin("user-wx", wxStart.key);
  assert.equal(wxWait.status, "waiting");

  const wxScan = await wxAdapter.checkQrLogin("user-wx", wxStart.key);
  assert.equal(wxScan.status, "scanned");

  const wxDone = await wxAdapter.checkQrLogin("user-wx", wxStart.key);
  assert.equal(wxDone.status, "confirmed");
  assert.equal(wxDone.verification?.accountUid, wx64BitId);
  assert.equal(wxDone.verification?.displayName, "WeChatListener");
  await wxAdapter.getDiscoverTracks({
    platform: "qq",
    cookie: wxDone.verification?.normalizedCookie ?? null,
    scopeKey: "user-wx",
  });
  assert.equal(seenMusicuCommLoginType, 1);

  // 3) Channel "mobile": CreateQRCode + MQTT 5.0 0x9D redirect + real-time scan/cookies + 64-bit musicid
  const mobileUin = "1152921504606846979";
  const wsPathsSeen: string[] = [];
  const mqttHarness: { publish?: (eventType: string, jsonPayload: unknown) => void } = {};
  const sockets: Array<{ destroyed: () => boolean }> = [];
  let seenMobileLoginBody = "";

  const mobileHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
        const rawBody = String(init?.body ?? "{}");
        const parsed = JSON.parse(rawBody) as { req?: { method?: string } };
        if (parsed.req?.method === "CreateQRCode") {
          return new Response(
            JSON.stringify({
              code: 0,
              req: { code: 0, data: { qrcode: "iVBORw0KGgo=", qrcodeID: "QRCODE_ID_77" } },
            }),
            { status: 200 },
          );
        }
        seenMobileLoginBody = rawBody;
        return new Response(
          `{"code":0,"req":{"code":0,"data":{"musicid":1152921504606846979,"str_musicid":"${mobileUin}","musickey":"W_X_MOBILE_OK","loginType":1,"nick":"AppUser"}}}`,
          { status: 200 },
        );
      }
      if (u.includes("fcg_get_profile_homepage.fcg")) {
        return new Response(JSON.stringify({ code: 0, data: { creator: { nick: "AppUser" } } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const mobileAdapter = new QqMusicAdapter(mobileHttp, {
    mqttResolveHost: async () => [{ address: "1.2.3.4", family: 4 }],
    mqttSocketFactory: () => {
      const pair = createInMemoryDuplexPair();
      sockets.push({ destroyed: pair.destroyed });
      let upgraded = false;
      let connectAttempt = wsPathsSeen.length;

      pair.serverSide.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (!upgraded && text.startsWith("GET ")) {
          upgraded = true;
          const reqPath = /^GET\s+(\S+)/.exec(text)?.[1] ?? "";
          wsPathsSeen.push(reqPath);
          connectAttempt = wsPathsSeen.length;
          const wsKey = /Sec-WebSocket-Key:\s*(\S+)/i.exec(text)?.[1] ?? "";
          const accept = crypto
            .createHash("sha1")
            .update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          pair.serverSide.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`,
          );
          return;
        }

        // Unmask client WebSocket frame
        if (chunk.length < 6) return;
        let offset = 2;
        let len = (chunk[1] ?? 0) & 0x7f;
        if (len === 126) {
          len = chunk.readUInt16BE(2);
          offset = 4;
        }
        const mask = chunk.subarray(offset, offset + 4);
        const mqttFrame = Buffer.from(chunk.subarray(offset + 4, offset + 4 + len));
        for (let i = 0; i < mqttFrame.length; i += 1) {
          mqttFrame[i] = (mqttFrame[i] ?? 0) ^ (mask[i & 3] ?? 0);
        }
        const packetType = (mqttFrame[0] ?? 0) >> 4;

        if (packetType === 1) {
          if (connectAttempt === 1) {
            // 1st hop returns CONNACK 0x9d (Use another server) + SERVER_REFERENCE (0x1c)
            const refProp = Buffer.concat([Buffer.from([0x1c]), encodeMqttUtf8("10.8.8.8:8080")]);
            const connackBody = Buffer.concat([
              Buffer.from([0x00, 0x9d]),
              encodeMqttVarInt(refProp.length),
              refProp,
            ]);
            const connack = Buffer.concat([
              Buffer.from([0x20]),
              encodeMqttVarInt(connackBody.length),
              connackBody,
            ]);
            pair.serverSide.write(wrapServerWsFrame(0x02, connack));
          } else {
            // 2nd hop succeeds with CONNACK 0x00
            pair.serverSide.write(wrapServerWsFrame(0x02, Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00])));
          }
        } else if (packetType === 8) {
          // SUBSCRIBE -> SUBACK packetId=1, reasonCode=0x00
          pair.serverSide.write(wrapServerWsFrame(0x02, Buffer.from([0x90, 0x04, 0x00, 0x01, 0x00, 0x00])));
          mqttHarness.publish = (eventType, jsonPayload) => {
            const topicBuf = encodeMqttUtf8("management.qrcode_login/QRCODE_ID_77");
            const propBody = Buffer.concat([
              Buffer.from([0x26]),
              encodeMqttUtf8("type"),
              encodeMqttUtf8(eventType),
            ]);
            const propsBuf = Buffer.concat([encodeMqttVarInt(propBody.length), propBody]);
            const payloadBuf = Buffer.from(JSON.stringify(jsonPayload), "utf8");
            const pubBody = Buffer.concat([topicBuf, propsBuf, payloadBuf]);
            const pubPkt = Buffer.concat([Buffer.from([0x30]), encodeMqttVarInt(pubBody.length), pubBody]);
            pair.serverSide.write(wrapServerWsFrame(0x02, pubPkt));
          };
        }
      });

      return pair.clientSide;
    },
  });

  const mobileStart = await mobileAdapter.startQrLogin("user-mobile", { channel: "mobile" });
  assert.equal(mobileStart.channel, "mobile");
  assert.deepEqual(wsPathsSeen, ["/ws/handshake", "/ws/handshake/10.8.8.8:8080"]);

  const mWait = await mobileAdapter.checkQrLogin("user-mobile", mobileStart.key);
  assert.equal(mWait.status, "waiting");

  mqttHarness.publish?.("scanned", {});
  const mScanned = await mobileAdapter.checkQrLogin("user-mobile", mobileStart.key);
  assert.equal(mScanned.status, "scanned");

  mqttHarness.publish?.("cookies", {
    cookies: {
      qqmusic_uin: { value: mobileUin },
      qqmusic_key: { value: "W_X_TEMP_TOKEN" },
    },
  });
  const mConfirmed = await mobileAdapter.checkQrLogin("user-mobile", mobileStart.key);
  assert.equal(mConfirmed.status, "confirmed");
  assert.ok(seenMobileLoginBody.includes(`"musicid":${mobileUin}`));
  assert.equal(mConfirmed.verification?.accountUid, mobileUin);
  assert.equal(
    sockets.every((s) => s.destroyed()),
    true,
  );

  // SSRF guard: private IP on MQTT host resolution is rejected with UNSAFE_URL
  const ssrfAdapter = new QqMusicAdapter(mobileHttp, {
    mqttResolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  await assert.rejects(
    () => ssrfAdapter.startQrLogin("user-ssrf", { channel: "mobile" }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_URL",
  );
  mobileAdapter.close();
});

test("QqMusicAdapter rejects code=1000 playlists, distinguishes 503 vs copyright, supports RS01/trial, resolves mid comments, disables createPlaylist, isolates cache (A11/A12/B12/C034/C037/C039)", async () => {
  // 1. SM-01 / C037: canCreatePlaylist is false & QqMusicAdapter omits unsupported PlaylistMutationPort methods
  const dummyHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const baseAdapter: MusicProviderAdapter = new QqMusicAdapter(dummyHttp);
  assert.equal(baseAdapter.capabilities.canCreatePlaylist, false);
  assert.equal(baseAdapter.createPlaylistWithTracks, undefined);
  assert.equal(supportsPlaylistMutation(baseAdapter), false);

  // 2. A11: code=1000 throws CREDENTIAL_INVALID and is NEVER cached as empty playlist
  let detailCalls = 0;
  const expiredHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => {
      detailCalls += 1;
      return new Response(JSON.stringify({ code: 1000, msg: "not logged in" }), { status: 200 });
    },
  });
  const expiredAdapter = new QqMusicAdapter(expiredHttp);
  await assert.rejects(
    () => expiredAdapter.getUserPlaylists(qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  await assert.rejects(
    () => expiredAdapter.getPlaylistTracks("999", { page: 1, limit: 20 }, qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  const callsBeforeRetry = detailCalls;
  await assert.rejects(
    () => expiredAdapter.getPlaylistTracks("999", { page: 1, limit: 20 }, qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  assert.equal(detailCalls, callsBeforeRetry + 1, "code=1000 failure must not be cached");

  // 3. A12: HTTP 503 throws UPSTREAM_ERROR instead of COPYRIGHT_UNAVAILABLE
  const downHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response("Service Unavailable", { status: 503 }),
  });
  const downAdapter = new QqMusicAdapter(downHttp);
  await assert.rejects(
    () => downAdapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "lossless", "playback", qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );

  // 4. B15/B16: RS01 tried for hires, O4M0 trial skipped in favor of full M500
  const requestedFilenames: string[] = [];
  const audioHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (_url, init) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        req_0?: { param?: { filename?: string[] } };
      };
      const fn = parsed.req_0?.param?.filename?.[0] ?? "";
      requestedFilenames.push(fn);
      if (fn.startsWith("RS01")) {
        return new Response(
          JSON.stringify({
            req_0: {
              data: {
                sip: ["https://ws.stream.qqmusic.qq.com/"],
                midurlinfo: [{ purl: "O4M00039MnYb0qxYhV.m4a", result: 0 }],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (fn.startsWith("F000")) {
        return new Response(
          JSON.stringify({
            req_0: {
              data: {
                sip: ["https://ws.stream.qqmusic.qq.com/"],
                midurlinfo: [{ purl: "F0000039MnYb0qxYhV.flac?vkey=ok", result: 0 }],
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ req_0: { data: { sip: [], midurlinfo: [] } } }), { status: 200 });
    },
  });
  const audioAdapter = new QqMusicAdapter(audioHttp);
  const resolved = await audioAdapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "hires", "download", qqAuth);
  assert.ok(requestedFilenames[0]?.startsWith("RS01"));
  assert.equal(resolved.level, "lossless");
  assert.equal(resolved.trial, false);
  assert.equal(resolved.downgraded, true); // A05: hires -> lossless FLAC is downgraded

  // 5. C034: getComments resolves songMid -> numeric songid, fixes hasMore, and setCommentLiked sends topid/biztype & checks code === 0
  const praiseQueries: URLSearchParams[] = [];
  const commentHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.pathname.includes("musicu.fcg")) {
        return new Response(JSON.stringify({ songinfo: { data: { track_info: { id: 97773 } } } }), {
          status: 200,
        });
      }
      if (u.pathname.includes("fcg_global_comment_h5.fcg")) {
        return new Response(
          JSON.stringify({
            code: 0,
            comment: {
              commenttotal: 2,
              commentlist: [
                { rootcommentid: "c1", rootcommentcontent: "赞", time: 1700000000 },
                { rootcommentid: "c2", rootcommentcontent: "好听", time: 1700000001 },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (u.pathname.includes("fcg_global_comment_praise_h5.fcg")) {
        praiseQueries.push(u.searchParams);
        return new Response(JSON.stringify({ msg: "missing code must fail" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  });
  const commentAdapter = new QqMusicAdapter(commentHttp);
  const commentsPage = await commentAdapter.getComments("0039MnYb0qxYhV", 1, 2, qqAuth);
  assert.equal(commentsPage.songId, "97773");
  assert.equal(commentsPage.hasMore, false); // total=2, offset=0, returned=2 -> hasMore MUST be false
  await assert.rejects(
    () => commentAdapter.setCommentLiked("0039MnYb0qxYhV", "c1", true, qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  assert.equal(praiseQueries[0]?.get("topid"), "97773");
  assert.equal(praiseQueries[0]?.get("biztype"), "1");

  // 6. C039: Authenticated QQ discover call must NOT pollute "public" cache seen by unauthenticated callers
  let discoverCalls = 0;
  const cacheHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (_url, init) => {
      discoverCalls += 1;
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      const title = cookie.includes("Q_H_L_TOKEN") ? "Authed Track" : "Public Track";
      return new Response(
        JSON.stringify({
          new_song: { data: { songlist: [{ mid: "m1", title, singer: [{ name: "S" }], interval: 180 }] } },
        }),
        { status: 200 },
      );
    },
  });
  const cacheAdapter = new QqMusicAdapter(cacheHttp);
  const authedDiscover = await cacheAdapter.getDiscoverTracks(qqAuth);
  const publicDiscover = await cacheAdapter.getDiscoverTracks({
    platform: "qq",
    cookie: null,
    scopeKey: "user-2",
  });
  assert.equal(discoverCalls, 2);
  assert.equal(authedDiscover[0]?.title, "Authed Track");
  assert.equal(publicDiscover[0]?.title, "Public Track");
});
