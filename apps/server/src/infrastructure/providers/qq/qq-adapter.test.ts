import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { SafeHttpClient } from "../../security/safe-http-client.js";
import { QqMusicAdapter } from "./qq-adapter.js";
import { computeQqGtk, extractEssentialQqCookie, parseQqCookie } from "./qq-cookie.js";

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

test("QqMusicAdapter QR login handles 302 manual redirect chain + OAuth qm_keyst exchange and risk-control fallback (A01/C032)", async () => {
  const createQrHttp = (blockOAuth: boolean) =>
    new SafeHttpClient({
      resolveHost: async () => [{ address: "1.2.3.4" }],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes("/cgi-bin/xlogin")) {
          const h = new Headers();
          h.append("set-cookie", "pt_login_sig=SIG123; Path=/");
          return new Response("", { status: 200, headers: h });
        }
        if (u.includes("/ptqrshow")) {
          const h = new Headers();
          h.append("set-cookie", "qrsig=QRSIG456; Path=/");
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: h });
        }
        if (u.includes("/ptqrlogin")) {
          return new Response(
            "ptuiCB('0','0','https://ptlogin2.y.qq.com/check_sig?sig=1','0','登录成功','Tester')",
            { status: 200 },
          );
        }
        if (u.includes("check_sig")) {
          const h = new Headers({ location: "https://y.qq.com/portal/close.html" });
          h.append("set-cookie", "uin=o123456; Path=/");
          h.append("set-cookie", "p_skey=PSKEY789; Path=/");
          return new Response(null, { status: 302, headers: h });
        }
        if (u.includes("/portal/close.html")) {
          return new Response("ok", { status: 200 });
        }
        if (u.includes("graph.qq.com/oauth2.0/authorize")) {
          if (blockOAuth) {
            return new Response("blocked", { status: 200 });
          }
          return new Response(null, {
            status: 302,
            headers: { location: "https://y.qq.com/portal/wx_redirect.html?code=OAUTH_CODE_99" },
          });
        }
        if (u.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
          return new Response(
            JSON.stringify({ req: { data: { musickey: "Q_H_L_EXCHANGED_KEY", musicid: 123456 } } }),
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

  // Success path: 302 chain + OAuth qm_keyst exchange
  const okAdapter = new QqMusicAdapter(createQrHttp(false));
  const startOk = await okAdapter.startQrLogin("user-1");
  const checkOk = await okAdapter.checkQrLogin("user-1", startOk.key);
  assert.equal(checkOk.status, "confirmed");
  assert.ok(checkOk.rawCookie?.includes("qm_keyst=Q_H_L_EXCHANGED_KEY"));
  assert.equal(checkOk.verification?.ok, true);

  // Risk-control blocked path: guides user to safe Cookie import instead of broken bind
  const blockedAdapter = new QqMusicAdapter(createQrHttp(true));
  const startBlocked = await blockedAdapter.startQrLogin("user-1");
  const checkBlocked = await blockedAdapter.checkQrLogin("user-1", startBlocked.key);
  assert.equal(checkBlocked.status, "error");
  assert.ok(checkBlocked.message.includes("Cookie"));
});

test("QqMusicAdapter rejects code=1000 playlists, distinguishes 503 vs copyright, supports RS01/trial, resolves mid comments, disables createPlaylist, isolates cache (A11/A12/B12/C034/C037/C039)", async () => {
  // 1. B12 / C037: canCreatePlaylist is false & createPlaylistWithTracks throws FEATURE_UNSUPPORTED
  const dummyHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const baseAdapter = new QqMusicAdapter(dummyHttp);
  assert.equal(baseAdapter.capabilities.canCreatePlaylist, false);
  await assert.rejects(
    () => baseAdapter.createPlaylistWithTracks("My List", ["mid1"], qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "FEATURE_UNSUPPORTED",
  );

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
