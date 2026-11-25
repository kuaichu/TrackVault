import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Song } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import { UserRepository } from "../../infrastructure/db/repositories/user-repository.js";
import { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";
import { AesGcmCredentialVault } from "../../infrastructure/security/credential-vault.js";
import { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { MediaService, assertSafeDirectDownloadUrl } from "./media-service.js";

test("assertSafeDirectDownloadUrl enforces HTTPS and audio CDN host allowlist", () => {
  assert.equal(
    assertSafeDirectDownloadUrl("https://m7.music.126.net/track.flac"),
    "https://m7.music.126.net/track.flac",
  );
  assert.equal(
    assertSafeDirectDownloadUrl("https://ws.stream.qqmusic.qq.com/M800.mp3?vkey=1"),
    "https://ws.stream.qqmusic.qq.com/M800.mp3?vkey=1",
  );

  for (const unsafe of [
    "http://m7.music.126.net/track.mp3",
    "https://user:pass@m7.music.126.net/track.mp3",
    "https://127.0.0.1/track.mp3",
    "https://93.184.216.34/track.mp3",
    "https://localhost/track.mp3",
    "https://evil.example.com/track.mp3",
    "https://music.163.com/track.mp3",
  ]) {
    assert.throws(
      () => assertSafeDirectDownloadUrl(unsafe),
      (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
      `Expected rejection for unsafe URL: ${unsafe}`,
    );
  }
});

test("MediaService.enqueueDownload(direct_link) aborts job when upstream returns untrusted or HTTP URL", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-direct-guard-"));
  const sqlite = new SqliteClient(":memory:");
  const userRepo = new UserRepository(sqlite);
  const user = userRepo.createUser({
    username: "direct-guard",
    passwordHash: "hash",
    role: "admin",
    trustedFallback: false,
  });
  const actor: ActorContext = {
    userId: user.id,
    username: user.username,
    role: user.role,
    trustedFallback: false,
  };
  const vault = new AesGcmCredentialVault(Buffer.alloc(32, 3));
  const credentials = new CredentialRepository(sqlite, vault);
  credentials.saveBinding(user.id, {
    platform: "netease",
    cookie: "MUSIC_U=valid",
    accountUid: "1",
    displayName: "U",
    avatarUrl: null,
    vipEnabled: true,
    vipExpireAt: null,
  });
  const userState = new UserStateRepository(sqlite);
  const jobRepo = new JobRepository(sqlite, { tmpDownloadsDir: tmpDir });
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: tmpDir,
    globalMaxConcurrentDownloads: 2,
    globalMaxConcurrentJobs: 2,
  });
  const http = new SafeHttpClient({ resolveHost: async () => [{ address: "1.2.3.4" }] });

  const mockAdapter: MusicProviderAdapter = {
    platform: "netease",
    capabilities: {
      platform: "netease",
      canLikeSong: false,
      canManagePlaylistTracks: false,
      canCreatePlaylist: false,
      canLoadCloudDisk: false,
      canReadComments: false,
      canLikeComments: false,
      canQrLogin: false,
      shareUrlTemplate: "https://music.163.com/#/song?id={id}",
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
      playlist: { id: "1", platform: "netease", name: "P", trackCount: 0, creatorName: "U", owned: true },
      songs: [],
      total: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [],
    getLyrics: async (id) => ({ songId: id, platform: "netease", lines: [], source: "none" }),
    resolveAudio: async (target) => ({
      url:
        target.id === "bad-http"
          ? "http://m7.music.126.net/insecure.mp3"
          : target.id === "bad-host"
            ? "https://evil.example.com/phish.mp3"
            : "https://m7.music.126.net/good.mp3",
      format: "mp3",
      bitrate: 320_000,
      level: "exhigh",
      durationSeconds: 180,
      trial: false,
      downgraded: false,
    }),
  };

  const providers = new ProviderRegistry();
  providers.register(mockAdapter);

  const media = new MediaService({
    providers,
    authResolver: new ProviderAuthResolver(credentials),
    userState,
    http,
    jobs,
    maxCoverBytes: 100_000,
    maxAudioBytes: 1_000_000,
  });

  const makeSong = (id: string): Song => ({
    id,
    platform: "netease",
    title: "Song",
    artist: "Artist",
    artists: [{ name: "Artist" }],
    album: "Album",
    durationSeconds: 180,
    duration: "03:00",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
  });

  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 40; i += 1) {
      const current = jobs.getOwnedJob(actor, jobId);
      if (current.status === "completed" || current.status === "failed") return current;
      await new Promise((r) => setTimeout(r, 20));
    }
    return jobs.getOwnedJob(actor, jobId);
  };

  try {
    const httpJob = await waitJob(
      media.enqueueDownload(actor, { song: makeSong("bad-http"), level: "exhigh", mode: "direct_link" }).id,
    );
    assert.equal(httpJob.status, "failed");
    assert.equal(httpJob.errorCode, "UPSTREAM_ERROR");

    const hostJob = await waitJob(
      media.enqueueDownload(actor, { song: makeSong("bad-host"), level: "exhigh", mode: "direct_link" }).id,
    );
    assert.equal(hostJob.status, "failed");
    assert.equal(hostJob.errorCode, "UPSTREAM_ERROR");

    const okJob = await waitJob(
      media.enqueueDownload(actor, { song: makeSong("good"), level: "exhigh", mode: "direct_link" }).id,
    );
    assert.equal(okJob.status, "completed");
    assert.equal(okJob.directUrl, "https://m7.music.126.net/good.mp3");
  } finally {
    jobs.stop();
    http.close();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
