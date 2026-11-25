import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { TransferTrack } from "#shared";
import { AppError } from "../../domain/errors.js";
import {
  type ProviderAuthContext,
  ProviderRegistry,
  supportsCloudDisk,
  supportsPlaylistMutation,
  supportsSongLike,
} from "../../domain/ports/music-provider.js";
import { comparePlaylistsAsync } from "../../domain/transfer/playlist-comparator.js";
import { SafeHttpClient } from "../security/safe-http-client.js";
import { parseCookieEntries } from "./common/cookie-parser.js";
import { NeteaseAdapter, normalizeNeteaseCookie } from "./netease/netease-adapter.js";
import { QqMusicAdapter } from "./qq/qq-adapter.js";
import { parseQqCookie } from "./qq/qq-cookie.js";
import { mapQqComment, mapQqSong } from "./qq/qq-mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("qq-mapper has zero netease references and cookie-parser strips Set-Cookie attributes", async () => {
  const qqMapperSource = await fs.readFile(path.join(__dirname, "qq", "qq-mapper.ts"), "utf8");
  assert.equal(/netease/i.test(qqMapperSource), false);

  const rawSetCookie =
    "Cookie: uin=o123456;\nExpires=Thu, 20 Nov 2036 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600;\r\nCookie: qm_keyst=Q_H_L_abc==; p_skey=xyz=";

  const entries = parseCookieEntries(rawSetCookie, { allowColonSeparator: true, stripQuotes: true });
  assert.equal(entries.get("qm_keyst"), "Q_H_L_abc==");
  assert.equal(entries.has("Expires"), false);
  assert.equal(entries.has("Path"), false);
  assert.equal(entries.has("HttpOnly"), false);
  assert.equal(entries.has("Max-Age"), false);
  assert.equal(entries.has("Secure"), false);
  assert.equal(entries.has("SameSite"), false);

  const parsedQq = parseQqCookie(rawSetCookie);
  assert.equal(parsedQq.uin, "123456");
  assert.equal(parsedQq.qm_keyst, "Q_H_L_abc==");
  assert.equal(parsedQq.Expires, undefined);
  assert.equal(parsedQq.Path, undefined);
  assert.equal(parsedQq.HttpOnly, undefined);

  const normalizedNe = normalizeNeteaseCookie(
    "Cookie: MUSIC_U=token123; Expires=Thu, 20 Nov 2036 00:00:00 GMT; Path=/; HttpOnly; os=pc",
  );
  assert.ok(normalizedNe.includes("MUSIC_U=token123"));
  assert.ok(normalizedNe.includes("os=android"));
  assert.equal(normalizedNe.includes("Expires="), false);
  assert.equal(normalizedNe.includes("HttpOnly"), false);

  const mappedSong = mapQqSong({
    mid: "001",
    title: "🎵".repeat(520),
    singer: [{ name: "Singer" }],
    interval: 3665,
  });
  assert.ok(mappedSong);
  assert.equal(Array.from(mappedSong.title).length, 500);
  assert.equal(mappedSong.duration, "01:01:05");

  const mappedComment = mapQqComment({
    rootcommentid: "c1",
    rootcommentcontent: "hello",
    time: 1_704_038_400, // 2024-01-01 00:00 +08:00
  });
  assert.ok(mappedComment);
  assert.equal(mappedComment.timeText, "2024-01-01 00:00");

  // ProviderRegistry.listCapabilities dynamically reflects registered adapters & port guards
  const dummyHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const neAdapter = new NeteaseAdapter();
  const qqAdapter = new QqMusicAdapter(dummyHttp);
  assert.equal(supportsPlaylistMutation(neAdapter), true);
  assert.equal(supportsCloudDisk(neAdapter), true);
  assert.equal(supportsSongLike(neAdapter), true);
  assert.equal(supportsPlaylistMutation(qqAdapter), false);
  assert.equal(supportsCloudDisk(qqAdapter), false);
  assert.equal(supportsSongLike(qqAdapter), false);

  const registry = new ProviderRegistry();
  registry.register(qqAdapter);
  const caps = registry.listCapabilities();
  assert.equal(caps.qq.canCreatePlaylist, false);
  assert.equal((caps as Partial<typeof caps>).netease, undefined);
  neAdapter.close();
  dummyHttp.close();
});

test("PP-08: Netease hydrates privileges in getArtistDetail/getPersonalFm & aborts batch hydration; QQ propagates AbortSignal & QR timeout", async () => {
  const neAuth: ProviderAuthContext = {
    platform: "netease",
    cookie: "MUSIC_U=valid",
    scopeKey: "u-pp08",
    accountUid: "101",
  };

  // 1) Netease getArtistDetail & getPersonalFm hydrate missing privileges (preventing false lock when cp===0 & pl missing)
  const privAdapter = new NeteaseAdapter({
    apiOverride: {
      artists: async () => ({
        body: {
          artist: { id: 10, name: "Artist A" },
          hotSongs: [{ id: 1001, name: "Hot Free Song", fee: 0, cp: 0, dt: 180_000 }],
        },
      }),
      artist_album: async () => ({ body: { hotAlbums: [] } }),
      artist_detail: async () => ({ body: { data: { artist: {} } } }),
      personal_fm: async () => ({
        body: {
          code: 200,
          data: [{ id: 1002, name: "FM Free Song", fee: 0, cp: 0, dt: 180_000 }],
        },
      }),
      song_detail: async ({ ids }) => {
        const list = String(ids)
          .split(",")
          .filter(Boolean)
          .map((id) => ({ id: Number(id), fee: 0, pl: 128_000, dl: 128_000, st: 0, cp: 1 }));
        return { body: { code: 200, privileges: list } };
      },
    },
  });

  try {
    const artist = await privAdapter.getArtistDetail("10", neAuth);
    assert.equal(artist.hotSongs[0]?.availability?.playback.locked, false);
    assert.equal(artist.hotSongs[0]?.availability?.playback.status, "available");

    const fm = await privAdapter.getPersonalFm(neAuth);
    assert.equal(fm[0]?.availability?.playback.locked, false);
    assert.equal(fm[0]?.availability?.playback.status, "available");
  } finally {
    privAdapter.close();
  }

  // 2) Netease inspectPlaylistTracks stops subsequent song_detail batches immediately on AbortSignal
  const ac = new AbortController();
  let batchCalls = 0;
  const abortAdapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 5000,
            name: "Huge List",
            trackCount: 3000,
            trackIds: Array.from({ length: 3000 }, (_, i) => ({ id: i + 1 })),
          },
        },
      }),
      song_detail: async ({ ids }) => {
        batchCalls += 1;
        // Abort during first concurrency wave (batches 1..4); wave 2 (batches 5..6) must never run
        if (batchCalls === 2) {
          ac.abort();
        }
        return {
          body: {
            code: 200,
            songs: String(ids)
              .split(",")
              .map((id) => ({ id: Number(id), name: `S${id}`, ar: [{ name: "A" }], dt: 180_000 })),
          },
        };
      },
    },
  });

  try {
    await assert.rejects(
      () => abortAdapter.inspectPlaylistTracks("5000", 3000, { ...neAuth, signal: ac.signal }),
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
    );
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(batchCalls <= 4, `expected <= 4 batch calls before abort stopped wave 2, got ${batchCalls}`);
  } finally {
    abortAdapter.close();
  }

  // 3) QQ getLyrics propagates AbortSignal / UPSTREAM_TIMEOUT instead of returning empty lyrics
  const lyricController = new AbortController();
  lyricController.abort();
  const qqLyricHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const qqLyricAdapter = new QqMusicAdapter(qqLyricHttp);
  await assert.rejects(
    () =>
      qqLyricAdapter.getLyrics("0039MnYb0qxYhV", undefined, {
        platform: "qq",
        cookie: null,
        scopeKey: "public",
        signal: lyricController.signal,
      }),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
  );
  qqLyricHttp.close();

  // 4) QQ QR #exchangeMusicKey propagates network timeout instead of misreporting as risk-control
  const timeoutQrHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/cgi-bin/xlogin")) {
        const h = new Headers();
        h.append("set-cookie", "pt_login_sig=SIG1; Path=/");
        return new Response("", { status: 200, headers: h });
      }
      if (u.includes("/ptqrshow")) {
        const h = new Headers();
        h.append("set-cookie", "qrsig=QRSIG1; Path=/");
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
        h.append("set-cookie", "p_skey=PSK1; Path=/");
        return new Response(null, { status: 302, headers: h });
      }
      if (u.includes("/portal/close.html")) {
        return new Response("ok", { status: 200 });
      }
      if (u.includes("graph.qq.com/oauth2.0/authorize")) {
        const abortErr = new Error("Request timed out");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      return new Response("not found", { status: 404 });
    },
  });
  const timeoutQrAdapter = new QqMusicAdapter(timeoutQrHttp);
  const started = await timeoutQrAdapter.startQrLogin("user-qr");
  await assert.rejects(
    () => timeoutQrAdapter.checkQrLogin("user-qr", started.key),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
  );
  timeoutQrHttp.close();
});

test("SM-05: comparePlaylistsAsync runs exact max-weight matching on 200 Pass 3 tracks without greedy cliff and stays permutation invariant", async () => {
  const leftTracks: TransferTrack[] = [];
  const rightTracks: TransferTrack[] = [];

  // 198 cross-artist similar-title pairs (none share exact normalized title -> all go to Pass 3)
  for (let i = 0; i < 198; i += 1) {
    const artist = `CrossArtist${i}`;
    leftTracks.push({
      source: "netease",
      sourceTrackId: `l-${i}`,
      title: `Ballad Number ${i}`,
      artists: [artist],
    });
    rightTracks.push({
      source: "qq",
      sourceTrackId: `r-${i}`,
      title: `Ballad Number ${i} Acoustic`,
      artists: [artist],
    });
  }

  // 2 competing tracks within "Artist-Opt" where greedy matching would match only 1 pair,
  // while exact Kuhn-Munkres bipartite matching matches both (2 pairs) -> total 200.
  leftTracks.push(
    {
      source: "netease",
      sourceTrackId: "opt-l-a",
      title: "Moonlight",
      artists: ["Artist-Opt"],
    },
    {
      source: "netease",
      sourceTrackId: "opt-l-b",
      title: "Moonlight Shadow",
      artists: ["Artist-Opt"],
    },
  );
  rightTracks.push(
    {
      source: "qq",
      sourceTrackId: "opt-r-y",
      title: "Moonlight Shadowing",
      artists: ["Artist-Opt"],
    },
    {
      source: "qq",
      sourceTrackId: "opt-r-x",
      title: "Moonlight Shadow Extended",
      artists: ["Artist-Opt"],
    },
  );

  const baseline = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: leftTracks },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: rightTracks },
  });

  assert.equal(baseline.summary.leftTotal, 200);
  assert.equal(baseline.summary.rightTotal, 200);
  assert.equal(baseline.summary.similarTitle, 200);
  assert.equal(baseline.summary.leftOnly, 0);
  assert.equal(baseline.summary.rightOnly, 0);

  // Shuffle both sides (deterministic rotation + reversal) and verify 100% invariance
  const shuffledLeft = [...leftTracks.slice(77), ...leftTracks.slice(0, 77)].reverse();
  const shuffledRight = [...rightTracks.slice(123), ...rightTracks.slice(0, 123)].reverse();

  const permuted = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: shuffledLeft },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: shuffledRight },
  });

  assert.deepEqual(permuted.summary, baseline.summary);
});
