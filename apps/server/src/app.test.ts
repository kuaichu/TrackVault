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

  // Fake valid MPEG1 Layer3 bytes + JPEG cover
  const fakeMp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
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
