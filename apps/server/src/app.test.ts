import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMp3Bytes } from "#audio-tags";
import type { MusicPlatform, Song } from "#shared";
import { buildServer } from "./app.js";
import { loadServerConfig } from "./config/env.js";
import { type MusicProviderAdapter, ProviderRegistry } from "./domain/ports/music-provider.js";
import { SafeHttpClient } from "./infrastructure/security/safe-http-client.js";

function extractCookieHeader(setCookies: string | string[] | undefined): string {
  const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

function makeMockSong(platform: MusicPlatform, id: string, title: string): Song {
  return {
    id,
    platform,
    title,
    artist: "周杰伦",
    artists: [{ name: "周杰伦" }],
    album: "叶惠美",
    coverUrl: "https://p1.music.126.net/cover.jpg",
    durationSeconds: 240,
    duration: "04:00",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
  };
}

function createMockAdapter(platform: MusicPlatform): MusicProviderAdapter {
  const song = makeMockSong(platform, platform === "netease" ? "186016" : "0039MnYb0qxYhV", "晴天");
  return {
    platform,
    capabilities: {
      platform,
      canLikeSong: platform === "netease",
      canManagePlaylistTracks: platform === "netease",
      canCreatePlaylist: true,
      canLoadCloudDisk: platform === "netease",
      canReadComments: true,
      canLikeComments: true,
      canQrLogin: true,
      shareUrlTemplate:
        platform === "netease"
          ? "https://music.163.com/#/song?id={id}"
          : "https://y.qq.com/n/ryqq/songDetail/{id}",
    },
    async verifyCredential(cookie) {
      if (cookie.includes("VALID")) {
        return {
          ok: true,
          accountUid: platform === "netease" ? "998877" : "123456",
          displayName: `${platform}-vip`,
          avatarUrl: null,
          vipEnabled: true,
          vipExpireAt: Date.now() + 86_400_000,
          normalizedCookie: cookie,
          message: "验证通过",
        };
      }
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "无效凭证",
      };
    },
    async searchTracks() {
      return [song];
    },
    async getDiscoverTracks() {
      return [song];
    },
    async getUserPlaylists() {
      return [
        {
          id: "pl-1",
          platform,
          name: "测试歌单",
          trackCount: 1,
          creatorName: "Tester",
          owned: true,
        },
      ];
    },
    async getPlaylistTracks(_id, query) {
      return {
        playlist: {
          id: "pl-1",
          platform,
          name: "测试歌单",
          trackCount: 1,
          creatorName: "Tester",
          owned: true,
        },
        songs: [song],
        total: 1,
        page: query.page,
        limit: query.limit,
        hasMore: false,
      };
    },
    async getAllPlaylistTracks() {
      return [song];
    },
    async getLyrics(songId) {
      return {
        songId,
        platform,
        lines: [{ time: 1, text: "故事的小黄花" }],
        source: platform === "netease" ? "netease_new" : "qqmusic",
      };
    },
    async resolveAudio(_target, level, _mode, auth) {
      if (!auth.cookie) {
        throw new Error("no cookie");
      }
      return {
        url: "https://m7.music.126.net/fake-track.mp3",
        format: "mp3",
        bitrate: 320_000,
        level,
        durationSeconds: 240,
        trial: false,
        downgraded: false,
      };
    },
  };
}

test("TrackVault v2 end-to-end security, isolation, encryption, download tagging, and transfer suite", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-test-"));
  const providers = new ProviderRegistry();
  providers.register(createMockAdapter("netease"));
  providers.register(createMockAdapter("qq"));

  // Complete 417-byte MPEG1 Layer3 (128 kbps, 44.1 kHz) frame + JPEG cover
  const fakeMp3 = new Uint8Array(417);
  fakeMp3.set([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

  const mockHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (url) => {
      const str = String(url);
      if (str.endsWith(".jpg")) {
        return new Response(fakeJpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return new Response(fakeMp3, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": String(fakeMp3.length) },
      });
    },
  });

  const config = loadServerConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    ALLOWED_ORIGINS: "http://localhost:5173",
    COOKIE_SECURE: "false",
  });

  const server = await buildServer({
    config,
    dbPathOverride: ":memory:",
    providersOverride: providers,
    httpClientOverride: mockHttp,
    disableRateLimit: true,
    serveStaticWeb: false,
  });

  try {
    // 1. Unauthenticated requests are blocked; security headers present
    const status0 = await server.app.inject({ method: "GET", url: "/api/auth/status" });
    assert.equal(status0.statusCode, 200);
    assert.equal(status0.json().initialized, false);
    assert.equal(status0.headers["referrer-policy"], "no-referrer");

    const unauthSettings = await server.app.inject({ method: "GET", url: "/api/settings" });
    assert.equal(unauthSettings.statusCode, 401);
    assert.equal(unauthSettings.json().error.code, "UNAUTHORIZED");

    // 2. Setup initial admin & verify HttpOnly cookie + block duplicate setup
    const setupRes = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "alice", password: "Password123!" },
    });
    assert.equal(setupRes.statusCode, 201);
    const setCookieHeader = setupRes.headers["set-cookie"];
    const rawSetCookie = Array.isArray(setCookieHeader) ? setCookieHeader.join(";") : String(setCookieHeader);
    assert.ok(rawSetCookie.toLowerCase().includes("httponly"));
    const aliceCookie = extractCookieHeader(setCookieHeader);

    const dupSetup = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "hacker", password: "Password123!" },
    });
    assert.equal(dupSetup.statusCode, 409);

    // 3. Bind Netease cookie -> NEVER leaked back in HTTP JSON & stored encrypted in SQLite
    const secretCookie = "MUSIC_U=SUPER_SECRET_VALID_TOKEN_98765";
    const bindRes = await server.app.inject({
      method: "POST",
      url: "/api/bindings/netease/cookie",
      headers: { cookie: aliceCookie },
      payload: { cookie: secretCookie },
    });
    assert.equal(bindRes.statusCode, 200);
    assert.equal(bindRes.body.includes("SUPER_SECRET"), false);
    assert.equal(bindRes.json().binding.connected, true);

    const dbRow = server.sqlite.db
      .prepare("SELECT encrypted_cookie FROM platform_credentials WHERE platform = 'netease'")
      .get() as { encrypted_cookie: string };
    assert.ok(dbRow.encrypted_cookie.startsWith("v1:"));
    assert.equal(dbRow.encrypted_cookie.includes("SUPER_SECRET"), false);

    // 4. Admin creates member Bob (trustedFallback = false); Bob cannot access admin endpoints
    const createBob = await server.app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: aliceCookie },
      payload: { username: "bob", password: "BobPassword123!", role: "member", trustedFallback: false },
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().member.id as string;

    const bobLogin = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "bob", password: "BobPassword123!" },
    });
    assert.equal(bobLogin.statusCode, 200);
    const bobCookie = extractCookieHeader(bobLogin.headers["set-cookie"]);

    const bobAdminAttempt = await server.app.inject({
      method: "GET",
      url: "/api/admin/members",
      headers: { cookie: bobCookie },
    });
    assert.equal(bobAdminAttempt.statusCode, 403);

    // 5. Alice configures system fallback; Bob (untrusted) CANNOT use it, then trusted Bob CAN
    await server.app.inject({
      method: "PUT",
      url: "/api/admin/fallbacks/netease",
      headers: { cookie: aliceCookie },
      payload: { cookie: "MUSIC_U=FALLBACK_VALID", enabled: true },
    });

    const bobUntrustedProbe = await server.app.inject({
      method: "POST",
      url: "/api/media/probe",
      headers: { cookie: bobCookie },
      payload: { platform: "netease", id: "186016", level: "exhigh", mode: "playback" },
    });
    assert.equal(bobUntrustedProbe.statusCode, 403);
    assert.equal(bobUntrustedProbe.json().error.code, "CREDENTIAL_REQUIRED");

    await server.app.inject({
      method: "PATCH",
      url: `/api/admin/members/${bobId}`,
      headers: { cookie: aliceCookie },
      payload: { trustedFallback: true },
    });

    const bobTrustedProbe = await server.app.inject({
      method: "POST",
      url: "/api/media/probe",
      headers: { cookie: bobCookie },
      payload: { platform: "netease", id: "186016", level: "exhigh", mode: "playback" },
    });
    assert.equal(bobTrustedProbe.statusCode, 200);

    // 6. Alice triggers tagged_server download -> tags injected -> Bob blocked from IDOR access
    const dlStart = await server.app.inject({
      method: "POST",
      url: "/api/downloads",
      headers: { cookie: aliceCookie },
      payload: { song: makeMockSong("netease", "186016", "晴天"), level: "exhigh", mode: "tagged_server" },
    });
    assert.equal(dlStart.statusCode, 202);
    const jobId = dlStart.json().job.id as string;

    // Wait briefly for background download job to finish
    let jobStatus = "queued";
    for (let i = 0; i < 30; i += 1) {
      const poll = await server.app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
        headers: { cookie: aliceCookie },
      });
      jobStatus = poll.json().job.status;
      // Server file paths must NEVER appear in job JSON
      assert.equal(poll.body.includes(tmpDir), false);
      if (jobStatus === "completed" || jobStatus === "failed") break;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(jobStatus, "completed");

    // Bob tries IDOR read, cancel, and file download on Alice's job -> all 404
    for (const req of [
      { method: "GET" as const, url: `/api/jobs/${jobId}` },
      { method: "POST" as const, url: `/api/jobs/${jobId}/cancel` },
      { method: "GET" as const, url: `/api/jobs/${jobId}/file` },
    ]) {
      const idor = await server.app.inject({ ...req, headers: { cookie: bobCookie } });
      assert.equal(idor.statusCode, 404);
    }

    // Alice downloads the tagged MP3 file and verifies ID3v2 header + audio frames intact
    const fileRes = await server.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/file`,
      headers: { cookie: aliceCookie },
    });
    assert.equal(fileRes.statusCode, 200);
    const fileBytes = new Uint8Array(fileRes.rawPayload);
    assert.equal(fileBytes[0], 0x49); // I
    assert.equal(fileBytes[1], 0x44); // D
    assert.equal(fileBytes[2], 0x33); // 3
    assert.equal(isMp3Bytes(fileBytes), true);

    // 7. Transfer job + CSV export + IDOR check
    const transferStart = await server.app.inject({
      method: "POST",
      url: "/api/transfer/jobs",
      headers: { cookie: aliceCookie },
      payload: {
        sourceProvider: "text",
        targetProvider: "qq",
        playlistName: "My Export",
        rawText: "1. 晴天 - 周杰伦",
      },
    });
    assert.equal(transferStart.statusCode, 202);
    const transferJobId = transferStart.json().job.id as string;

    for (let i = 0; i < 30; i += 1) {
      const poll = await server.app.inject({
        method: "GET",
        url: `/api/jobs/${transferJobId}`,
        headers: { cookie: aliceCookie },
      });
      if (poll.json().job.status === "completed") break;
      await new Promise((r) => setTimeout(r, 30));
    }

    const bobExportIdor = await server.app.inject({
      method: "POST",
      url: `/api/transfer/jobs/${transferJobId}/export`,
      headers: { cookie: bobCookie },
      payload: { format: "csv" },
    });
    assert.equal(bobExportIdor.statusCode, 404);

    const aliceExport = await server.app.inject({
      method: "POST",
      url: `/api/transfer/jobs/${transferJobId}/export`,
      headers: { cookie: aliceCookie },
      payload: { format: "csv" },
    });
    assert.equal(aliceExport.statusCode, 200);
    assert.ok(aliceExport.json().content.includes("晴天"));

    // 8. CORS rejects unlisted origin & cover proxy blocks non-whitelist SSRF host
    const evilCors = await server.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(evilCors.headers["access-control-allow-origin"], undefined);

    const ssrfCover = await server.app.inject({
      method: "GET",
      url: "/api/media/cover?url=http://169.254.169.254/latest/meta-data/",
      headers: { cookie: aliceCookie },
    });
    assert.equal(ssrfCover.statusCode, 400);
    assert.equal(ssrfCover.json().error.code, "UNSAFE_URL");

    // 9. Logout revokes session immediately
    await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: aliceCookie },
    });
    const afterLogout = await server.app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: aliceCookie },
    });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Phase 1 security suite: 429 rate-limit, CSRF, SSE CORS, trustProxy cookies, fallback validation, cache invalidation, and member revocation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p1-test-"));
  const invalidatedScopes: string[] = [];

  const createTrackingAdapter = (platform: MusicPlatform): MusicProviderAdapter => {
    const base = createMockAdapter(platform);
    return {
      ...base,
      invalidateScope(scopeKey: string) {
        invalidatedScopes.push(`${platform}:${scopeKey}`);
      },
    };
  };

  const providers = new ProviderRegistry();
  providers.register(createTrackingAdapter("netease"));
  providers.register(createTrackingAdapter("qq"));

  const config = loadServerConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    ALLOWED_ORIGINS: "http://localhost:5173",
    COOKIE_SECURE: "auto",
    TRUST_PROXY: "true",
  });

  const server = await buildServer({
    config,
    dbPathOverride: ":memory:",
    providersOverride: providers,
    disableRateLimit: false,
    serveStaticWeb: false,
  });

  try {
    // 1. Helmet CORP + CSP qlogo.cn + structured API 404 (C007/C008/C013)
    const health = await server.app.inject({ method: "GET", url: "/api/health" });
    assert.equal(health.headers["cross-origin-resource-policy"], "cross-origin");
    assert.ok(String(health.headers["content-security-policy"] ?? "").includes("https://*.qlogo.cn"));

    const api404 = await server.app.inject({ method: "GET", url: "/api/does-not-exist" });
    assert.equal(api404.statusCode, 404);
    assert.equal(api404.json().error.code, "NOT_FOUND");

    const apiRoot404 = await server.app.inject({ method: "GET", url: "/api" });
    assert.equal(apiRoot404.statusCode, 404);
    assert.equal(apiRoot404.json().error.code, "NOT_FOUND");

    // 2. Concurrent setupInitialAdmin creates strictly 1 admin (C009/C010) + Secure cookie under TRUST_PROXY=true (C003/B26)
    const [s1, s2] = await Promise.all([
      server.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: { "x-forwarded-proto": "https" },
        payload: { username: "admin1", password: "Password123!" },
      }),
      server.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: { "x-forwarded-proto": "https" },
        payload: { username: "admin2", password: "Password123!" },
      }),
    ]);
    const codes = [s1.statusCode, s2.statusCode].sort();
    assert.deepEqual(codes, [201, 409]);
    const winner = s1.statusCode === 201 ? s1 : s2;
    const rawSetCookie = Array.isArray(winner.headers["set-cookie"])
      ? winner.headers["set-cookie"].join(";")
      : String(winner.headers["set-cookie"]);
    assert.ok(rawSetCookie.toLowerCase().includes("secure"));
    const adminCookie = extractCookieHeader(winner.headers["set-cookie"]);

    // 3. CSRF blocks cross-origin Origin, Sec-Fetch-Site: cross-site, and text/plain authenticated write (C002)
    const csrfOrigin = await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: adminCookie, origin: "https://evil.example.com" },
    });
    assert.equal(csrfOrigin.statusCode, 403);
    assert.equal(csrfOrigin.json().error.code, "FORBIDDEN");

    const csrfSecFetch = await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: adminCookie, "sec-fetch-site": "cross-site" },
    });
    assert.equal(csrfSecFetch.statusCode, 403);

    const csrfTextPlain = await server.app.inject({
      method: "POST",
      url: "/api/history/search",
      headers: { cookie: adminCookie, "content-type": "text/plain" },
      payload: "keyword=evil",
    });
    assert.equal(csrfTextPlain.statusCode, 403);

    // 4. SSE /api/events rejects unlisted Origin with 403 (B24/C001)
    const evilSse = await server.app.inject({
      method: "GET",
      url: "/api/events",
      headers: { cookie: adminCookie, origin: "https://evil.example.com" },
    });
    assert.equal(evilSse.statusCode, 403);
    assert.equal(evilSse.json().error.code, "FORBIDDEN");

    // 5. System fallback validates cookies and rejects empty unconfigured enable (C016)
    const emptyFallback = await server.app.inject({
      method: "PUT",
      url: "/api/admin/fallbacks/netease",
      headers: { cookie: adminCookie },
      payload: { enabled: true },
    });
    assert.equal(emptyFallback.statusCode, 400);
    assert.equal(emptyFallback.json().error.code, "VALIDATION_ERROR");

    const invalidFallback = await server.app.inject({
      method: "PUT",
      url: "/api/admin/fallbacks/netease",
      headers: { cookie: adminCookie },
      payload: { cookie: "BAD_COOKIE", enabled: true },
    });
    assert.equal(invalidFallback.statusCode, 401);
    assert.equal(invalidFallback.json().error.code, "CREDENTIAL_INVALID");

    // 6. Bind & unbind invalidate provider cache scopes (A03/C038)
    const bindOk = await server.app.inject({
      method: "POST",
      url: "/api/bindings/netease/cookie",
      headers: { cookie: adminCookie },
      payload: { cookie: "MUSIC_U=VALID_ACCOUNT_A" },
    });
    assert.equal(bindOk.statusCode, 200);
    assert.ok(invalidatedScopes.some((entry) => entry.startsWith("netease:")));

    // 7. Rate limit returns HTTP 429 RATE_LIMITED instead of 500 (A04)
    let hit429 = false;
    for (let i = 0; i < 18; i += 1) {
      const attempt = await server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin1", password: "wrong-password" },
      });
      if (attempt.statusCode === 429) {
        assert.equal(attempt.json().error.code, "RATE_LIMITED");
        hit429 = true;
        break;
      }
      assert.equal(attempt.statusCode, 401);
    }
    assert.equal(hit429, true);

    // 8. Deleting a member cancels their running/queued jobs (C022)
    const createBob = await server.app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: {
        username: "bob_revoked",
        password: "BobPassword123!",
        role: "member",
        trustedFallback: false,
      },
    });
    assert.equal(createBob.statusCode, 201);
    const bobId = createBob.json().member.id as string;
    let aborted = false;
    server.jobs.enqueue({
      actor: { userId: bobId, username: "bob_revoked", role: "member", trustedFallback: false },
      kind: "transfer",
      title: "long-running",
      runner: (handle) =>
        new Promise((_resolve, reject) => {
          handle.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const delBob = await server.app.inject({
      method: "DELETE",
      url: `/api/admin/members/${bobId}`,
      headers: { cookie: adminCookie },
    });
    assert.equal(delBob.statusCode, 200);
    assert.equal(aborted, true);

    // 9. Logout clears cookie with matching Secure attribute under TRUST_PROXY=true (B29/C012)
    const logoutRes = await server.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: adminCookie, "x-forwarded-proto": "https" },
    });
    assert.equal(logoutRes.statusCode, 200);
    const rawClearCookie = Array.isArray(logoutRes.headers["set-cookie"])
      ? logoutRes.headers["set-cookie"].join(";")
      : String(logoutRes.headers["set-cookie"]);
    assert.ok(rawClearCookie.toLowerCase().includes("secure"));
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("PATCH /api/transfer/jobs/:id/selection enforces ownership and persists selection updates (F15)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trackvault-v2-transfer-route-"));
  const config = loadServerConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    COOKIE_SECURE: "false",
  });

  const providers = new ProviderRegistry();
  providers.register(createMockAdapter("netease"));
  providers.register(createMockAdapter("qq"));

  const server = await buildServer({
    config,
    dbPathOverride: ":memory:",
    providersOverride: providers,
    disableRateLimit: true,
    serveStaticWeb: false,
  });

  try {
    const setupRes = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "owner", password: "OwnerPassword123!" },
    });
    assert.equal(setupRes.statusCode, 201);
    const ownerCookie = extractCookieHeader(setupRes.headers["set-cookie"]);

    const createOther = await server.app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: ownerCookie },
      payload: {
        username: "other",
        password: "OtherPassword123!",
        role: "member",
        trustedFallback: false,
      },
    });
    assert.equal(createOther.statusCode, 201);
    const otherLogin = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "other", password: "OtherPassword123!" },
    });
    const otherCookie = extractCookieHeader(otherLogin.headers["set-cookie"]);

    const startRes = await server.app.inject({
      method: "POST",
      url: "/api/transfer/jobs",
      headers: { cookie: ownerCookie },
      payload: {
        sourceProvider: "text",
        targetProvider: "netease",
        rawText: "晴天 - 周杰伦",
        checkAvailability: false,
      },
    });
    assert.equal(startRes.statusCode, 202);
    const jobId = startRes.json().job.id as string;

    for (let i = 0; i < 30; i += 1) {
      const poll = await server.app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
        headers: { cookie: ownerCookie },
      });
      if (poll.json().job.status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Owner skips item 0
    const skipRes = await server.app.inject({
      method: "PATCH",
      url: `/api/transfer/jobs/${jobId}/selection`,
      headers: { cookie: ownerCookie },
      payload: { index: 0, action: "skip" },
    });
    assert.equal(skipRes.statusCode, 200);
    assert.equal(skipRes.json().job.result.results[0].status, "skipped");
    assert.equal(skipRes.json().job.result.summary.skipped, 1);

    // Other user cannot modify owner's transfer job -> 404
    const idorRes = await server.app.inject({
      method: "PATCH",
      url: `/api/transfer/jobs/${jobId}/selection`,
      headers: { cookie: otherCookie },
      payload: { index: 0, action: "reset" },
    });
    assert.equal(idorRes.statusCode, 404);

    // Invalid payload -> 400
    const badRes = await server.app.inject({
      method: "PATCH",
      url: `/api/transfer/jobs/${jobId}/selection`,
      headers: { cookie: ownerCookie },
      payload: { index: -1, action: "skip" },
    });
    assert.equal(badRes.statusCode, 400);
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
