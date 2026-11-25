import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MusicPlatform, Song, TransferResult, TransferTrack } from "#shared";
import { ProviderAuthResolver } from "../../application/auth/provider-auth-resolver.js";
import { BackgroundJobManager } from "../../application/jobs/background-job-manager.js";
import { TransferService } from "../../application/transfer/transfer-service.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import { UserRepository } from "../../infrastructure/db/repositories/user-repository.js";
import { AesGcmCredentialVault } from "../../infrastructure/security/credential-vault.js";
import type { ActorContext } from "../context.js";
import { AppError } from "../errors.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../ports/music-provider.js";
import { type ProviderCandidateTrack, matchTransferTrack } from "./track-matcher.js";

const sourceTrack: TransferTrack = {
  source: "qq",
  sourceTrackId: "src-1",
  title: "Echo",
  artists: ["Artist"],
  album: "Main Album",
  durationSeconds: 180,
};

function makeCandidate(id: string, overrides: Partial<ProviderCandidateTrack> = {}): ProviderCandidateTrack {
  return {
    provider: "netease",
    id,
    title: "Echo",
    artists: ["Artist"],
    album: "Main Album",
    durationSeconds: 180,
    availability: "playable",
    ...overrides,
  };
}

test("matchTransferTrack with checkAvailability promotes 6th verified_playable candidate over top-5 probe_error candidates and merges it into Top-5", () => {
  const candidates: ProviderCandidateTrack[] = [
    ...Array.from({ length: 5 }, (_, idx) =>
      makeCandidate(`err-${idx + 1}`, {
        availability: "playable",
        probeStatus: "probe_error",
        probeError: "音源网关超时",
      }),
    ),
    makeCandidate("ed-6", {
      album: "Compilation",
      availability: "playable",
      probeStatus: "verified_playable",
    }),
  ];

  const result = matchTransferTrack(sourceTrack, candidates, { checkAvailability: true });
  assert.equal(result.status, "matched");
  assert.equal(result.selectedCandidate?.targetTrackId, "ed-6");
  assert.equal(result.candidates.length, 5);
  assert.ok(result.candidates.some((c) => c.targetTrackId === "ed-6"));
});

test("matchTransferTrack with checkAvailability never returns matched for unprobed/probe_error candidates and discloses probe_error on restricted tracks", () => {
  const unprobed = matchTransferTrack(
    sourceTrack,
    [makeCandidate("u-1", { availability: "playable", probeStatus: "unprobed" })],
    { checkAvailability: true },
  );
  assert.equal(unprobed.status, "manual_review");
  assert.ok(unprobed.reason?.includes("未经音源实测"));

  const errored = matchTransferTrack(
    sourceTrack,
    [
      makeCandidate("e-1", {
        availability: "playable",
        probeStatus: "probe_error",
        probeError: "上游超时",
      }),
    ],
    { checkAvailability: true },
  );
  assert.equal(errored.status, "manual_review");
  assert.ok(errored.reason?.includes("音源实测未完成（上游超时）"));

  const restrictedErrored = matchTransferTrack(
    sourceTrack,
    [
      makeCandidate("vip-1", {
        availability: "vip_only",
        probeStatus: "probe_error",
        probeError: "VIP 探测超时",
      }),
    ],
    { checkAvailability: true },
  );
  assert.equal(restrictedErrored.status, "vip_only");
  assert.equal(restrictedErrored.reason, "音源实测未完成（VIP 探测超时）：目标平台曲目为 VIP 专享");
});

test("TransferService end-to-end checkAvailability rescues 6th playable candidate when top 5 time out", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-pp01-"));
  const sqlite = new SqliteClient(":memory:");
  const userRepo = new UserRepository(sqlite);
  const user = userRepo.createUser({
    username: "pp01-user",
    passwordHash: "hash",
    role: "admin",
    trustedFallback: false,
  });
  const actor: ActorContext = {
    userId: user.id,
    username: user.username,
    role: user.role,
    trustedFallback: user.trustedFallback,
  };
  const vault = new AesGcmCredentialVault(Buffer.alloc(32, 7));
  const credentials = new CredentialRepository(sqlite, vault);
  const jobRepo = new JobRepository(sqlite, { tmpDownloadsDir: tmpDir });
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: tmpDir,
    globalMaxConcurrentDownloads: 1,
    globalMaxConcurrentJobs: 2,
  });

  const mkSong = (platform: MusicPlatform, id: string, album: string): Song => ({
    id,
    platform,
    title: "Echo",
    artist: "Artist",
    artists: [{ name: "Artist" }],
    album,
    durationSeconds: 180,
    duration: "03:00",
    quality: "320K",
    availableQualities: [{ level: "standard", label: "128K" }],
  });

  const makeMockProvider = (platform: MusicPlatform): MusicProviderAdapter => ({
    platform,
    capabilities: {
      platform,
      canLikeSong: false,
      canManagePlaylistTracks: false,
      canCreatePlaylist: false,
      canLoadCloudDisk: false,
      canReadComments: false,
      canLikeComments: false,
      canQrLogin: false,
      shareUrlTemplate: "https://example.com/{id}",
    },
    verifyCredential: async () => ({
      ok: true,
      accountUid: "1",
      displayName: "u",
      avatarUrl: null,
      vipEnabled: false,
      vipExpireAt: null,
      message: "ok",
    }),
    searchTracks: async () => [
      ...Array.from({ length: 5 }, (_, idx) => mkSong("netease", `timeout-${idx + 1}`, "Main Album")),
      mkSong("netease", "sixth-ok", "Compilation"),
    ],
    getDiscoverTracks: async () => [],
    getUserPlaylists: async () => [],
    getPlaylistTracks: async () => ({
      playlist: { id: "1", platform, name: "P", trackCount: 1, creatorName: "u", owned: true },
      songs: [mkSong(platform, "src-1", "Main Album")],
      total: 1,
      page: 1,
      limit: 50,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [mkSong(platform, "src-1", "Main Album")],
    getLyrics: async (songId) => ({ songId, platform, lines: [], source: "none" }),
    resolveAudio: async (target) => {
      if (target.id.startsWith("timeout-")) {
        throw new AppError("UPSTREAM_TIMEOUT", "Probe timed out");
      }
      return {
        url: "https://m7.music.126.net/sixth-ok.mp3",
        format: "mp3",
        bitrate: 128_000,
        level: "standard",
        durationSeconds: 180,
        trial: false,
        downgraded: false,
      };
    },
  });

  const providers = new ProviderRegistry();
  providers.register(makeMockProvider("qq"));
  providers.register(makeMockProvider("netease"));

  const transferService = new TransferService({
    providers,
    authResolver: new ProviderAuthResolver(credentials),
    jobs,
  });

  try {
    const job = transferService.startTransferJob(actor, {
      sourceProvider: "qq",
      targetProvider: "netease",
      playlistId: "pl-1",
      checkAvailability: true,
    });

    for (let i = 0; i < 60; i += 1) {
      const current = jobs.getOwnedJob(actor, job.id);
      if (current.status === "completed" || current.status === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const finished = jobs.getOwnedJob(actor, job.id);
    assert.equal(finished.status, "completed");
    const result = finished.result as TransferResult;
    assert.equal(result.results[0]?.status, "matched");
    assert.equal(result.results[0]?.selectedCandidate?.targetTrackId, "sixth-ok");
    assert.ok(result.results[0]?.candidates.some((c) => c.targetTrackId === "sixth-ok"));
  } finally {
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
