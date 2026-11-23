import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MusicPlatform, Song } from "#shared";
import { buildServer } from "../../app.js";
import { loadServerConfig } from "../../config/env.js";
import type { ActorContext } from "../../domain/context.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { JobRepository, toJobView } from "../../infrastructure/db/repositories/job-repository.js";
import { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import {
  MediaService,
  hasValidAudioSignature,
  isAcceptableAudioContentType,
  isBetterResolvedAudio,
} from "./media-service.js";

const testActor: ActorContext = {
  userId: "user-1",
  username: "alice",
  role: "admin",
  trustedFallback: true,
};

function seedTestUser(sqlite: SqliteClient, userId = testActor.userId): void {
  const now = Date.now();
  sqlite.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
       VALUES (?, ?, ?, 'admin', 1, ?)`,
    )
    .run(userId, `u-${userId}`, "hash", now);
}

function makeSong(platform: MusicPlatform, id: string, title = "晴天"): Song {
  return {
    id,
    platform,
    title,
    artist: "周杰伦",
    artists: [{ name: "周杰伦" }],
    album: "叶惠美",
    durationSeconds: 240,
    duration: "04:00",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
  };
}

test("J01 magic-byte signature validation blocks fake MP3/text and accepts MP3, FLAC, M4A (QQ C400), WAV, OGG, AAC", () => {
  // Valid formats
  const mp3TenBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  const flacBytes = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  const m4aBytes = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  const wavBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
  const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);
  const aacAdtsBytes = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x02]);

  assert.equal(hasValidAudioSignature(mp3TenBytes), true);
  assert.equal(hasValidAudioSignature(flacBytes), true);
  assert.equal(hasValidAudioSignature(m4aBytes), true);
  assert.equal(hasValidAudioSignature(wavBytes), true);
  assert.equal(hasValidAudioSignature(oggBytes), true);
  assert.equal(hasValidAudioSignature(aacAdtsBytes), true);

  // Invalid / error text payloads
  assert.equal(hasValidAudioSignature(new TextEncoder().encode("Temporarily unavailable")), false);
  assert.equal(hasValidAudioSignature(new TextEncoder().encode("<html>403 Forbidden</html>")), false);
  assert.equal(hasValidAudioSignature(new Uint8Array([0x00, 0x01])), false);

  // Content-Type gate
  assert.equal(isAcceptableAudioContentType("text/plain; charset=utf-8"), false);
  assert.equal(isAcceptableAudioContentType("text/html"), false);
  assert.equal(isAcceptableAudioContentType("application/json"), false);
  assert.equal(isAcceptableAudioContentType("audio/mpeg"), true);
  assert.equal(isAcceptableAudioContentType("audio/mp4"), true);
  assert.equal(isAcceptableAudioContentType("application/octet-stream"), true);
});

test("J01 + BUG-25 + J07 + B35 + C017: MediaService rejects fake MP3, allows valid M4A, uses fallback scope/lyrics, handles writeStream errors cleanly without listener leak", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-media-p2-"));
  const sqlite = new SqliteClient(":memory:");
  seedTestUser(sqlite);
  const repo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo,
    tmpDownloadsDir: tmpDir,
    globalMaxConcurrentDownloads: 4,
    globalMaxConcurrentJobs: 4,
  });

  const observedAuths: Array<{ fn: string; cookie: string | null; scopeKey: string }> = [];
  let nextFormat = "mp3";
  let nextResponseFactory: () => Response = () =>
    new Response("Temporarily unavailable", { status: 200, headers: { "content-type": "text/plain" } });

  const providers = new ProviderRegistry();
  const mockAdapter: MusicProviderAdapter = {
    platform: "qq",
    capabilities: {
      platform: "qq",
      canLikeSong: false,
      canManagePlaylistTracks: false,
      canCreatePlaylist: false,
      canLoadCloudDisk: false,
      canReadComments: true,
      canLikeComments: true,
      canQrLogin: true,
      shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
    },
    verifyCredential: async () => ({
      ok: true,
      accountUid: "1",
      displayName: "U",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
      message: "ok",
    }),
    searchTracks: async () => [],
    getDiscoverTracks: async () => [],
    getUserPlaylists: async () => [],
    getPlaylistTracks: async () => ({
      playlist: { id: "1", platform: "qq", name: "P", trackCount: 0, creatorName: "U", owned: false },
      songs: [],
      total: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [],
    getLyrics: async (songId, _mediaId, auth) => {
      observedAuths.push({ fn: "getLyrics", cookie: auth.cookie, scopeKey: auth.scopeKey });
      return { songId, platform: "qq", lines: [{ time: 1, text: "L" }], source: "qqmusic" };
    },
    resolveAudio: async (_t, level, _m, auth) => {
      observedAuths.push({ fn: "resolveAudio", cookie: auth.cookie, scopeKey: auth.scopeKey });
      return {
        url: `https://dl.stream.qqmusic.qq.com/track.${nextFormat}`,
        format: nextFormat,
        bitrate: 128_000,
        level,
        durationSeconds: 180.4,
        trial: false,
        downgraded: false,
      };
    },
  };
  providers.register(mockAdapter);

  const httpClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => nextResponseFactory(),
  });

  const media = new MediaService({
    providers,
    credentials: {
      getDecryptedCookie: () => null,
      getDecryptedSystemFallbackCookie: () => "FALLBACK_COOKIE",
    } as never,
    userState: {
      getSettings: () => ({ maxConcurrentDownloads: 2 }),
    } as never,
    http: httpClient,
    jobs,
    maxCoverBytes: 1024 * 1024,
    maxAudioBytes: 50 * 1024 * 1024,
  });

  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 60; i += 1) {
      const rec = repo.findById(jobId);
      if (rec && (rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled")) {
        return rec;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("Job timed out");
  };

  try {
    // 1. C031: probeAudio rounds fractional durationSeconds cleanly
    const probe = await media.probeAudio(testActor, "qq", { id: "s1" }, "standard", "playback");
    assert.equal(probe.actualDuration, "03:00");
    // C017: system fallback uses isolated "system-fallback" scopeKey
    assert.equal(observedAuths[0]?.scopeKey, "system-fallback");

    // 2. J01: text/plain 200 response fails download and leaves no artifact
    nextFormat = "mp3";
    nextResponseFactory = () =>
      new Response("Temporarily unavailable", { status: 200, headers: { "content-type": "text/plain" } });
    const fakeJob = media.enqueueDownload(testActor, {
      song: makeSong("qq", "s1"),
      level: "standard",
      mode: "tagged_server",
    });
    const fakeDone = await waitJob(fakeJob.id);
    assert.equal(fakeDone.status, "failed");

    // 3. J01: application/octet-stream containing invalid magic bytes fails & deletes temp file
    nextResponseFactory = () =>
      new Response(new TextEncoder().encode("NOT AN AUDIO FILE AT ALL"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const badMagicJob = media.enqueueDownload(testActor, {
      song: makeSong("qq", "s2"),
      level: "standard",
      mode: "tagged_server",
    });
    const badMagicDone = await waitJob(badMagicJob.id);
    assert.equal(badMagicDone.status, "failed");

    // 4. J01: valid M4A (offset 4 'ftyp', 24-byte complete ftyp box, QQ C400) passes signature validation
    nextFormat = "m4a";
    const validM4a = new Uint8Array(24);
    validM4a.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    nextResponseFactory = () =>
      new Response(validM4a, {
        status: 200,
        headers: { "content-type": "audio/mp4", "content-length": String(validM4a.length) },
      });
    const m4aJob = media.enqueueDownload(testActor, {
      song: makeSong("qq", "s3"),
      level: "standard",
      mode: "tagged_server",
    });
    const m4aDone = await waitJob(m4aJob.id);
    assert.equal(m4aDone.status, "completed");

    // 5. J07 + B35: Multi-chunk MP3 download triggers 0 MaxListenersExceededWarning & passes fallback cookie to getLyrics
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on("warning", onWarning);
    try {
      nextFormat = "mp3";
      const chunkCount = 24;
      const chunkSize = 64 * 1024;
      const headerChunk = new Uint8Array(chunkSize);
      headerChunk.set([0xff, 0xfb, 0x90, 0x64]);
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(headerChunk);
          for (let i = 1; i < chunkCount; i += 1) {
            controller.enqueue(new Uint8Array(chunkSize).fill(0x22));
          }
          controller.close();
        },
      });
      nextResponseFactory = () =>
        new Response(bodyStream, {
          status: 200,
          headers: { "content-type": "audio/mpeg", "content-length": String(chunkCount * chunkSize) },
        });

      const bigJob = media.enqueueDownload(testActor, {
        song: makeSong("qq", "s4"),
        level: "standard",
        mode: "tagged_server",
      });
      const bigDone = await waitJob(bigJob.id);
      assert.equal(bigDone.status, "completed");
      assert.equal(
        warnings.some((w) => w.name === "MaxListenersExceededWarning"),
        false,
      );
      // B35: getLyrics received the fallback cookie
      const lyricCall = observedAuths.find((a) => a.fn === "getLyrics");
      assert.equal(lyricCall?.cookie, "FALLBACK_COOKIE");
      assert.equal(lyricCall?.scopeKey, "system-fallback");
    } finally {
      process.off("warning", onWarning);
    }

    // 6. BUG-25: writeStream error fails job cleanly with zero unhandled error crash
    const brokenDir = path.join(tmpDir, "unwritable-as-file");
    await fs.writeFile(brokenDir, "not a directory");
    const brokenJobs = new BackgroundJobManager({
      repo,
      tmpDownloadsDir: brokenDir,
      globalMaxConcurrentDownloads: 2,
      globalMaxConcurrentJobs: 2,
    });
    const brokenMedia = new MediaService({
      providers,
      credentials: {
        getDecryptedCookie: () => "OWN",
        getDecryptedSystemFallbackCookie: () => null,
      } as never,
      userState: { getSettings: () => ({ maxConcurrentDownloads: 2 }) } as never,
      http: httpClient,
      jobs: brokenJobs,
      maxCoverBytes: 1024,
      maxAudioBytes: 1024 * 1024,
    });
    const mp3Sample = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02]);
    nextResponseFactory = () =>
      new Response(mp3Sample, { status: 200, headers: { "content-type": "audio/mpeg" } });
    const errJob = brokenMedia.enqueueDownload(testActor, {
      song: makeSong("qq", "s5"),
      level: "standard",
      mode: "tagged_server",
    });
    const errDone = await waitJob(errJob.id);
    assert.equal(errDone.status, "failed");
    brokenJobs.stop();
  } finally {
    jobs.stop();
    httpClient.close();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("J02 isBetterResolvedAudio strictly prefers full audio over trial", () => {
  const fullDowngraded = {
    url: "https://m7.music.126.net/a.mp3",
    format: "mp3",
    bitrate: 320_000,
    level: "exhigh" as const,
    durationSeconds: 200,
    trial: false,
    downgraded: true,
  };
  const trialLossless = {
    url: "https://m7.music.126.net/b.flac",
    format: "flac",
    bitrate: 900_000,
    level: "lossless" as const,
    durationSeconds: 30,
    trial: true,
    downgraded: false,
  };
  assert.equal(isBetterResolvedAudio(trialLossless, fullDowngraded), false);
  assert.equal(isBetterResolvedAudio(fullDowngraded, trialLossless), true);
});

test("J03 SafeHttpClient allows active slow streams past header timeout while aborting genuinely stalled streams", async () => {
  // Active slow stream: headers immediate, 5 chunks spaced 45ms apart (total ~225ms > 120ms timeoutMs)
  const slowActiveHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 5; i += 1) {
            await new Promise((r) => setTimeout(r, 45));
            controller.enqueue(new Uint8Array([i + 1]));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  const activeRes = await slowActiveHttp.fetchBoundedBytes("https://m7.music.126.net/slow.mp3", {
    allowedHostSuffixes: ["music.126.net"],
    timeoutMs: 120,
    idleTimeoutMs: 150,
    maxBytes: 1024,
  });
  assert.equal(activeRes.bytes.length, 5);
  slowActiveHttp.close();

  // Genuinely stalled stream: pauses 250ms (> 80ms idleTimeoutMs)
  const stalledHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array([1]));
          await new Promise((r) => setTimeout(r, 250));
          try {
            controller.enqueue(new Uint8Array([2]));
            controller.close();
          } catch {
            // already cancelled
          }
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "audio/mpeg" } });
    },
  });

  await assert.rejects(
    () =>
      stalledHttp.fetchBoundedBytes("https://m7.music.126.net/stalled.mp3", {
        allowedHostSuffixes: ["music.126.net"],
        timeoutMs: 120,
        idleTimeoutMs: 80,
        maxBytes: 1024,
      }),
    (err: unknown) => err instanceof Error && err.message.includes("超时"),
  );
  stalledHttp.close();
});

test("J04 + J06 + C020 + C021: direct_link/expired downloadReady separation, progress throttling, eviction & startup orphan cleanup", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-jobs-p2-"));
  const sqlite = new SqliteClient(":memory:");
  seedTestUser(sqlite);
  const repo = new JobRepository(sqlite);

  // C021: Pre-insert an interrupted running job with an orphan .bin file -> constructor recovery must delete it
  const orphanJobId = "interrupted-job-1";
  const orphanPath = path.join(tmpDir, testActor.userId, `${orphanJobId}.bin`);
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.writeFile(orphanPath, "partial");
  repo.insert({
    id: orphanJobId,
    userId: testActor.userId,
    kind: "download",
    status: "running",
    progress: 50,
    title: "Interrupted",
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 10_000,
  });

  const jobs = new BackgroundJobManager({
    repo,
    tmpDownloadsDir: tmpDir,
    globalMaxConcurrentDownloads: 2,
    globalMaxConcurrentJobs: 2,
  });

  try {
    // Wait briefly for async unlink of recovered orphan
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => fs.stat(orphanPath));

    // J04: direct_link job has downloadReady === false even when artifactFilename is set
    const directJobView = toJobView({
      id: "dl-direct",
      userId: testActor.userId,
      kind: "download",
      status: "completed",
      progress: 100,
      title: "Direct",
      artifactFilename: "Direct.mp3",
      directUrl: "https://m7.music.126.net/direct.mp3",
      metadata: { mode: "direct_link" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    assert.equal(directJobView.downloadReady, false);

    // J04: cleanupExpiredArtifacts removes expired .bin, marks artifactExpired: true, and emits job_updated
    const expiredJobId = "expired-job-1";
    const expiredFile = path.join(tmpDir, testActor.userId, `${expiredJobId}.bin`);
    await fs.writeFile(expiredFile, "audio");
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await fs.utimes(expiredFile, oldTime, oldTime);
    repo.insert({
      id: expiredJobId,
      userId: testActor.userId,
      kind: "download",
      status: "completed",
      progress: 100,
      title: "Expired",
      artifactFilename: "Expired.mp3",
      metadata: { mode: "tagged_server" },
      createdAt: Date.now() - 3 * 60 * 60 * 1000,
      updatedAt: Date.now() - 3 * 60 * 60 * 1000,
    });

    const events: Array<{
      type: string;
      jobId?: string;
      downloadReady?: boolean;
      artifactExpired?: boolean;
    }> = [];
    const unsub = jobs.subscribe(testActor.userId, (ev) => {
      events.push({
        type: ev.type,
        jobId: ev.job?.id ?? ev.jobId,
        downloadReady: ev.job?.downloadReady,
        artifactExpired: ev.job?.artifactExpired,
      });
    });

    await jobs.cleanupExpiredArtifacts();
    const afterCleanup = repo.findById(expiredJobId);
    assert.ok(afterCleanup);
    assert.equal(toJobView(afterCleanup).downloadReady, false);
    assert.equal(toJobView(afterCleanup).artifactExpired, true);
    assert.ok(
      events.some((e) => e.jobId === expiredJobId && e.downloadReady === false && e.artifactExpired === true),
    );

    // J06: 64 identical progress + subtitle updates emit only ONCE
    events.length = 0;
    const throttleJob = jobs.enqueue({
      actor: testActor,
      kind: "download",
      title: "Throttle Test",
      runner: async (handle) => {
        for (let i = 0; i < 64; i += 1) {
          handle.updateProgress(40, "下载中 1.0 MB");
        }
        return { subtitle: "完成" };
      },
    });
    for (let i = 0; i < 40; i += 1) {
      if (repo.findById(throttleJob.id)?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const progress40Events = events.filter((e) => e.jobId === throttleJob.id && e.type === "job_updated");
    // Expect queued(1) + running(1) + single throttled 40%(1) + completed(1) = 4 total (NOT 67!)
    assert.ok(progress40Events.length <= 5, `expected <= 5 events, got ${progress40Events.length}`);

    unsub();
  } finally {
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("J05 + C015 + C029 + C030: SSE does not hang app.close(), trustedFallback isolates private APIs, aggregate discover merges both, empty keyword DELETE does not wipe search history", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p2-int-"));
  const seenCookies = new Map<string, string | null>();

  const makeTrackingAdapter = (platform: MusicPlatform): MusicProviderAdapter => ({
    platform,
    capabilities: {
      platform,
      canLikeSong: platform === "netease",
      canManagePlaylistTracks: platform === "netease",
      canCreatePlaylist: platform === "netease",
      canLoadCloudDisk: platform === "netease",
      canReadComments: true,
      canLikeComments: true,
      canQrLogin: true,
      shareUrlTemplate: "https://example.com/{id}",
    },
    verifyCredential: async (cookie) => ({
      ok: cookie.includes("VALID"),
      accountUid: "888",
      displayName: "Admin",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
      normalizedCookie: cookie,
      message: "ok",
    }),
    searchTracks: async (_q, auth) => {
      seenCookies.set(`${platform}:search`, auth.cookie);
      return [makeSong(platform, `${platform}-search-1`, `${platform} Search`)];
    },
    getDiscoverTracks: async (auth) => {
      seenCookies.set(`${platform}:discover`, auth.cookie);
      return [makeSong(platform, `${platform}-disc-1`, `${platform} Discover`)];
    },
    getUserPlaylists: async (auth) => {
      seenCookies.set(`${platform}:playlists`, auth.cookie);
      return [];
    },
    getCloudTracksPage: async (auth) => {
      seenCookies.set(`${platform}:cloud`, auth.cookie);
      return { songs: [], total: 0, offset: 0, limit: 100, hasMore: false };
    },
    getPersonalFm: async (auth) => {
      seenCookies.set(`${platform}:fm`, auth.cookie);
      return [];
    },
    getDailyRecommendTracks: async (auth) => {
      seenCookies.set(`${platform}:daily`, auth.cookie);
      return [];
    },
    toggleSongLike: async (_id, liked, auth) => {
      seenCookies.set(`${platform}:like`, auth.cookie);
      return { liked };
    },
    getPlaylistTracks: async (_id, q) => ({
      playlist: { id: "1", platform, name: "P", trackCount: 0, creatorName: "U", owned: false },
      songs: [],
      total: 0,
      page: q.page,
      limit: q.limit,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [],
    getLyrics: async (id, _m, auth) => {
      seenCookies.set(`${platform}:lyrics`, auth.cookie);
      return { songId: id, platform, lines: [], source: "none" };
    },
    resolveAudio: async () => ({
      url: "https://m7.music.126.net/a.mp3",
      format: "mp3",
      bitrate: 320_000,
      level: "exhigh",
      durationSeconds: 200,
      trial: false,
      downgraded: false,
    }),
  });

  const providers = new ProviderRegistry();
  providers.register(makeTrackingAdapter("netease"));
  providers.register(makeTrackingAdapter("qq"));

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
    disableRateLimit: true,
    serveStaticWeb: false,
  });

  const extractCookie = (h: string | string[] | undefined) =>
    (Array.isArray(h) ? h : h ? [h] : []).map((c) => c.split(";")[0]).join("; ");

  try {
    // Setup admin + configure fallback + create trustedFallback member without own cookie
    const adminSetup = await server.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "Password123!" },
    });
    const adminCookie = extractCookie(adminSetup.headers["set-cookie"]);

    await server.app.inject({
      method: "PUT",
      url: "/api/admin/fallbacks/netease",
      headers: { cookie: adminCookie },
      payload: { cookie: "MUSIC_U=ADMIN_FALLBACK_VALID", enabled: true },
    });

    await server.app.inject({
      method: "POST",
      url: "/api/admin/members",
      headers: { cookie: adminCookie },
      payload: { username: "member", password: "MemberPassword123!", role: "member", trustedFallback: true },
    });
    const memberLogin = await server.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "member", password: "MemberPassword123!" },
    });
    const memberCookie = extractCookie(memberLogin.headers["set-cookie"]);

    // C015: trustedFallback works for public read (search, lyrics)
    await server.app.inject({
      method: "GET",
      url: "/api/search?q=test&mode=netease",
      headers: { cookie: memberCookie },
    });
    assert.equal(seenCookies.get("netease:search"), "MUSIC_U=ADMIN_FALLBACK_VALID");

    // C015 GUARDRAIL: private read/write endpoints NEVER receive admin fallback cookie!
    await server.app.inject({
      method: "GET",
      url: "/api/playlists?platform=netease",
      headers: { cookie: memberCookie },
    });
    await server.app.inject({ method: "GET", url: "/api/cloud/songs", headers: { cookie: memberCookie } });
    await server.app.inject({ method: "GET", url: "/api/fm", headers: { cookie: memberCookie } });
    await server.app.inject({
      method: "GET",
      url: "/api/recommend/daily",
      headers: { cookie: memberCookie },
    });
    await server.app.inject({
      method: "POST",
      url: "/api/likes/netease/123",
      headers: { cookie: memberCookie },
      payload: { liked: true },
    });
    assert.equal(seenCookies.get("netease:playlists"), null);
    assert.equal(seenCookies.get("netease:cloud"), null);
    assert.equal(seenCookies.get("netease:fm"), null);
    assert.equal(seenCookies.get("netease:daily"), null);
    assert.equal(seenCookies.get("netease:like"), null);

    // C030: getDiscover in aggregate mode merges Netease & QQ songs
    await server.app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { cookie: memberCookie },
      payload: { providerMode: "aggregate" },
    });
    const discoverRes = await server.app.inject({
      method: "GET",
      url: "/api/discover",
      headers: { cookie: memberCookie },
    });
    assert.equal(discoverRes.statusCode, 200);
    const platforms = (discoverRes.json().songs as Song[]).map((s) => s.platform);
    assert.deepEqual(platforms, ["netease", "qq"]);

    // C029: DELETE /api/history/search?keyword= (empty string) must NOT wipe all search history
    await server.app.inject({
      method: "POST",
      url: "/api/history/search",
      headers: { cookie: memberCookie },
      payload: { keyword: "周杰伦" },
    });
    const emptyKwDel = await server.app.inject({
      method: "DELETE",
      url: "/api/history/search?keyword=",
      headers: { cookie: memberCookie },
    });
    assert.deepEqual(emptyKwDel.json().items, ["周杰伦"]);
    const clearAllDel = await server.app.inject({
      method: "DELETE",
      url: "/api/history/search",
      headers: { cookie: memberCookie },
    });
    assert.deepEqual(clearAllDel.json().items, []);

    // J05: Active SSE connection closes promptly on server.app.close() without hanging
    const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const sseReq = http.get(`${address}/api/events`, { headers: { cookie: adminCookie } });
    await new Promise<void>((resolve, reject) => {
      sseReq.on("response", (res) => {
        res.once("data", () => resolve());
      });
      sseReq.on("error", reject);
    });
    // Closing server while SSE client is still connected must resolve quickly (< 2s)
    const closeStart = Date.now();
    await server.close();
    assert.ok(Date.now() - closeStart < 2000, "server.close() must not hang on open SSE streams");
    sseReq.destroy();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
