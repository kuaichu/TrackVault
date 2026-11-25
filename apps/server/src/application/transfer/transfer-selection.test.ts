import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MusicPlatform, Song, TransferResult } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import { AesGcmCredentialVault } from "../../infrastructure/security/credential-vault.js";
import { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { TransferService } from "./transfer-service.js";

const actor: ActorContext = {
  userId: "u-sel-1",
  username: "selector",
  role: "admin",
  trustedFallback: false,
};

function makeSong(
  platform: MusicPlatform,
  id: string,
  title: string,
  artist: string,
  availability?: Song["availability"],
): Song {
  return {
    id,
    platform,
    title,
    artist,
    artists: [{ name: artist }],
    album: "专辑",
    durationSeconds: 210,
    duration: "03:30",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
    availability,
  };
}

test("updateTransferTrackSelection updates atomically without lost updates and losslessly resets matched/vip_only/duplicate items", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-selection-"));
  const sqlite = new SqliteClient(path.join(tmpDir, "test.db"));
  sqlite.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
       VALUES (?, ?, 'h', 'admin', 0, ?)`,
    )
    .run(actor.userId, actor.username, Date.now());

  const jobRepo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: path.join(tmpDir, "downloads"),
    globalMaxConcurrentDownloads: 2,
    globalMaxConcurrentJobs: 2,
  });

  const credentials = new CredentialRepository(sqlite, new AesGcmCredentialVault(Buffer.alloc(32, 7)));
  const providers = new ProviderRegistry();
  const neteaseAdapter: MusicProviderAdapter = {
    platform: "netease",
    capabilities: {
      platform: "netease",
      canLikeSong: true,
      canManagePlaylistTracks: true,
      canCreatePlaylist: true,
      canLoadCloudDisk: true,
      canReadComments: true,
      canLikeComments: true,
      canQrLogin: true,
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
    searchTracks: async (q) => {
      if (q.includes("SongMatched")) {
        return [
          makeSong("netease", "m-exact", "SongMatched", "歌手甲"),
          makeSong("netease", "m-alt", "SongMatched (Live)", "歌手甲"),
        ];
      }
      if (q.includes("SongVip")) {
        return [
          makeSong("netease", "v-exact", "SongVip", "歌手乙", {
            playback: { status: "vip", locked: true, label: "VIP", reason: "需VIP" },
            download: { status: "vip", locked: true, label: "VIP", reason: "需VIP" },
          }),
          makeSong("netease", "v-alt", "SongVip (Acoustic)", "歌手乙"),
        ];
      }
      return [];
    },
    getDiscoverTracks: async () => [],
    getUserPlaylists: async () => [],
    getPlaylistTracks: async (_id, q) => ({
      playlist: { id: "1", platform: "netease", name: "P", trackCount: 0, creatorName: "U", owned: true },
      songs: [],
      total: 0,
      page: q.page,
      limit: q.limit,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [],
    getLyrics: async (id) => ({ songId: id, platform: "netease", lines: [], source: "none" }),
    resolveAudio: async () => ({
      url: "https://m7.music.126.net/a.mp3",
      format: "mp3",
      bitrate: 320_000,
      level: "exhigh",
      durationSeconds: 210,
      trial: false,
      downgraded: false,
    }),
  };
  providers.register(neteaseAdapter);
  providers.register({ ...neteaseAdapter, platform: "qq" });

  const service = new TransferService({
    providers,
    authResolver: new ProviderAuthResolver(credentials),
    jobs,
  });

  try {
    const queued = service.startTransferJob(actor, {
      sourceProvider: "text",
      targetProvider: "netease",
      rawText: ["SongMatched - 歌手甲", "SongVip - 歌手乙", "SongMatched - 歌手甲"].join("\n"),
      checkAvailability: false,
    });

    for (let i = 0; i < 40; i += 1) {
      if (jobs.getOwnedJob(actor, queued.id).status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const initial = jobs.getOwnedJob(actor, queued.id).result as TransferResult;
    assert.equal(initial.results[0]?.status, "matched");
    assert.equal(initial.results[0]?.selectedCandidate?.targetTrackId, "m-exact");
    assert.equal(initial.results[1]?.status, "vip_only");
    assert.equal(initial.results[1]?.selectedCandidate?.targetTrackId, "v-exact");
    assert.equal(initial.results[2]?.status, "duplicate");

    // Verify concurrent/back-to-back updates on different track indices retain ALL edits (no lost update)
    const [r0, r1, r2] = await Promise.all([
      Promise.resolve().then(() =>
        service.updateTransferTrackSelection(actor, queued.id, {
          index: 0,
          action: "select",
          targetTrackId: "m-alt",
        }),
      ),
      Promise.resolve().then(() =>
        service.updateTransferTrackSelection(actor, queued.id, {
          index: 1,
          action: "select",
          targetTrackId: "v-alt",
        }),
      ),
      Promise.resolve().then(() =>
        service.updateTransferTrackSelection(actor, queued.id, {
          index: 2,
          action: "skip",
        }),
      ),
    ]);
    assert.ok(r0 && r1 && r2);

    const afterConcurrent = jobs.getOwnedJob(actor, queued.id).result as TransferResult;
    assert.equal(afterConcurrent.results[0]?.status, "matched");
    assert.equal(afterConcurrent.results[0]?.selectedCandidate?.targetTrackId, "m-alt");
    assert.equal(afterConcurrent.results[0]?.manualDecision?.action, "select");
    assert.equal(afterConcurrent.results[1]?.status, "matched");
    assert.equal(afterConcurrent.results[1]?.selectedCandidate?.targetTrackId, "v-alt");
    assert.equal(afterConcurrent.results[1]?.manualDecision?.action, "select");
    assert.equal(afterConcurrent.results[2]?.status, "skipped");
    assert.equal(afterConcurrent.results[2]?.manualDecision?.action, "skip");
    assert.equal(afterConcurrent.summary.matched, 2);
    assert.equal(afterConcurrent.summary.skipped, 1);

    // Lossless reset restores initial matched, vip_only (with selectedCandidate!), and duplicate
    service.updateTransferTrackSelection(actor, queued.id, { index: 0, action: "reset" });
    service.updateTransferTrackSelection(actor, queued.id, { index: 1, action: "reset" });
    const finalJob = service.updateTransferTrackSelection(actor, queued.id, { index: 2, action: "reset" });
    const afterReset = finalJob.result as TransferResult;

    assert.equal(afterReset.results[0]?.status, "matched");
    assert.equal(afterReset.results[0]?.selectedCandidate?.targetTrackId, "m-exact");
    assert.equal(afterReset.results[0]?.manualDecision, undefined);

    assert.equal(afterReset.results[1]?.status, "vip_only");
    assert.equal(afterReset.results[1]?.selectedCandidate?.targetTrackId, "v-exact");
    assert.equal(afterReset.results[1]?.manualDecision, undefined);

    assert.equal(afterReset.results[2]?.status, "duplicate");
    assert.equal(afterReset.results[2]?.reason, "重复曲目已跳过");
    assert.equal(afterReset.results[2]?.manualDecision, undefined);
    assert.deepEqual(afterReset.summary, initial.summary);
  } finally {
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
