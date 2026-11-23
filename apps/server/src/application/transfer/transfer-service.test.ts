import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ImportAuditResult, JobEvent, JobView, MusicPlatform, Song, TransferResult } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { JobRepository, toJobView } from "../../infrastructure/db/repositories/job-repository.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { TransferService } from "./transfer-service.js";

const actor: ActorContext = {
  userId: "u-transfer-1",
  username: "tester",
  role: "admin",
  trustedFallback: true,
};

function makeSong(
  platform: MusicPlatform,
  id: string,
  title: string,
  artist = "周杰伦",
  availability?: Song["availability"],
): Song {
  return {
    id,
    mediaId: platform === "qq" ? `mid-${id}` : undefined,
    platform,
    title,
    artist,
    artists: [{ name: artist }],
    album: "专辑A",
    durationSeconds: 240,
    duration: "04:00",
    quality: "320K",
    availableQualities: [],
    availability,
  };
}

async function waitForJobDone(jobs: BackgroundJobManager, jobId: string): Promise<JobView> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const view = toJobView(jobs.getOwnedJob(actor, jobId));
    if (view.status === "completed" || view.status === "failed" || view.status === "cancelled") {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function withTransferHarness(
  adapters: {
    netease?: Partial<MusicProviderAdapter>;
    qq?: Partial<MusicProviderAdapter>;
  },
  fn: (ctx: {
    service: TransferService;
    jobs: BackgroundJobManager;
    events: JobEvent[];
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv-transfer-test-"));
  const sqlite = new SqliteClient(path.join(tmpDir, "test.db"));
  sqlite.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
       VALUES (?, ?, 'hash', 'admin', 1, ?)`,
    )
    .run(actor.userId, actor.username, Date.now());

  const jobRepo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: path.join(tmpDir, "downloads"),
    globalMaxConcurrentDownloads: 2,
    globalMaxConcurrentJobs: 2,
  });

  const events: JobEvent[] = [];
  const unsubscribe = jobs.subscribe(actor.userId, (evt) => events.push(evt));

  const baseNetease: Partial<MusicProviderAdapter> = {
    platform: "netease",
    getAllPlaylistTracks: async () => [],
    searchTracks: async () => [],
    ...adapters.netease,
  };
  const baseQq: Partial<MusicProviderAdapter> = {
    platform: "qq",
    getAllPlaylistTracks: async () => [],
    searchTracks: async () => [],
    ...adapters.qq,
  };

  const providers = new ProviderRegistry();
  providers.register(baseNetease as MusicProviderAdapter);
  providers.register(baseQq as MusicProviderAdapter);
  const credentials = {
    getDecryptedCookie: () => "MUSIC_U=mock-cookie",
    getBindingView: () => ({
      platform: "netease",
      bound: true,
      accountUid: "1001",
    }),
    getDecryptedSystemFallbackCookie: () => null,
  } as unknown as CredentialRepository;

  const service = new TransferService({ providers, credentials, jobs });

  try {
    await fn({ service, jobs, events });
  } finally {
    unsubscribe();
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("startImportAuditJob respects unlocked VIP tracks (T04), preserves paid_album/restricted categories (B27), and reports truncation (T11)", async () => {
  const playlistSongs: Song[] = [
    makeSong("netease", "1", "VIP可播曲", "歌手A", {
      playback: { status: "vip", locked: false, label: "VIP", reason: "VIP账号可播" },
      download: { status: "vip", locked: false, label: "VIP", reason: "VIP账号可下" },
    }),
    makeSong("netease", "2", "付费数字专辑曲", "歌手B", {
      playback: { status: "paid_album", locked: true, label: "数字专辑", reason: "需购买数字专辑" },
      download: { status: "paid_album", locked: true, label: "数字专辑", reason: "需购买数字专辑" },
    }),
    makeSong("netease", "3", "地区受限曲", "歌手C", {
      playback: { status: "restricted", locked: true, label: "受限", reason: "当前区域不可播放" },
      download: { status: "restricted", locked: true, label: "受限", reason: "当前区域不可下载" },
    }),
    makeSong("netease", "4", "超限未扫描曲", "歌手D"),
  ];

  await withTransferHarness(
    {
      netease: {
        getAllPlaylistTracks: async (_id, _auth, limit) => playlistSongs.slice(0, limit),
        getPlaylistTracks: async () => ({
          playlist: {
            id: "pl-1",
            platform: "netease",
            name: "测试歌单",
            trackCount: 10,
            creatorName: "Tester",
            owned: true,
          },
          songs: playlistSongs.slice(0, 1),
          total: 10,
          page: 1,
          limit: 1,
          hasMore: true,
        }),
        searchTracks: async () => [],
      },
    },
    async ({ service, jobs }) => {
      const queued = service.startImportAuditJob(actor, {
        playlistId: "pl-1",
        maxTracks: 3,
        candidateLimit: 3,
        checkAvailability: false,
      });
      const done = await waitForJobDone(jobs, queued.id);
      assert.equal(done.status, "completed");

      const result = done.result as ImportAuditResult;
      assert.equal(result.scannedCount, 3);
      assert.equal(result.playableCount, 1);
      assert.deepEqual(result.playableTrackIds, ["1"]);
      assert.equal(result.issueCount, 2);
      assert.equal(result.issues[0]?.issueType, "paid_album");
      assert.equal(result.issues[1]?.issueType, "restricted");
      // T11 truncation metadata
      assert.equal(result.sourceTotal, 10);
      assert.equal(result.unprocessedCount, 7);
      assert.equal(result.truncated, true);
    },
  );
});

test("checkAvailability: true actively probes resolveAudio in transfer and audit, while false skips probing (T09)", async () => {
  let probeCalls = 0;

  await withTransferHarness(
    {
      netease: {
        getAllPlaylistTracks: async () => [makeSong("netease", "n-1", "晴天", "周杰伦")],
        resolveAudio: async () => {
          probeCalls += 1;
          return {
            url: "https://m7.music.126.net/trial.mp3",
            bitrate: 128000,
            format: "mp3",
            level: "standard",
            durationSeconds: 30,
            trial: true,
            downgraded: false,
          };
        },
        searchTracks: async () => [],
      },
      qq: {
        searchTracks: async () => [makeSong("qq", "q-1", "晴天", "周杰伦")],
        resolveAudio: async () => {
          probeCalls += 1;
          return {
            url: "https://isure.stream.qqmusic.qq.com/trial.m4a",
            bitrate: 128000,
            format: "m4a",
            level: "standard",
            durationSeconds: 30,
            trial: true,
            downgraded: false,
          };
        },
      },
    },
    async ({ service, jobs }) => {
      // 1) checkAvailability: false -> 0 probe calls
      const noProbeJob = service.startTransferJob(actor, {
        sourceProvider: "text",
        targetProvider: "qq",
        rawText: "晴天 - 周杰伦",
        checkAvailability: false,
      });
      const noProbeDone = await waitForJobDone(jobs, noProbeJob.id);
      assert.equal(probeCalls, 0);
      assert.equal((noProbeDone.result as TransferResult).results[0]?.status, "matched");

      // 2) checkAvailability: true on transfer -> detects trial_only
      const probeTransfer = service.startTransferJob(actor, {
        sourceProvider: "text",
        targetProvider: "qq",
        rawText: "晴天 - 周杰伦",
        checkAvailability: true,
      });
      const probeTransferDone = await waitForJobDone(jobs, probeTransfer.id);
      assert.equal(probeCalls, 1);
      assert.equal((probeTransferDone.result as TransferResult).results[0]?.status, "trial_only");

      // 3) checkAvailability: true on import_audit -> flags trial_only issue
      const probeAudit = service.startImportAuditJob(actor, {
        playlistId: "pl-trial",
        maxTracks: 10,
        candidateLimit: 3,
        checkAvailability: true,
      });
      const probeAuditDone = await waitForJobDone(jobs, probeAudit.id);
      assert.equal(probeCalls, 2);
      const auditResult = probeAuditDone.result as ImportAuditResult;
      assert.equal(auditResult.playableCount, 0);
      assert.equal(auditResult.issues[0]?.issueType, "trial_only");
    },
  );
});

test("updateTransferTrackSelection persists select/skip/reset, emits SSE, and feeds importTransferResultToPlatform (F15/T10/B28)", async () => {
  let createdPlaylistTracks: string[] = [];
  let appendedPlaylist: { playlistId: string; trackIds: string[] } | null = null;

  await withTransferHarness(
    {
      netease: {
        searchTracks: async () => [
          // Partial/ambiguous candidates so initial status is manual_review
          makeSong("netease", "cand-1", "晴天 (Acoustic)", "周杰伦"),
          makeSong("netease", "cand-2", "晴天 (Live)", "周杰伦"),
        ],
        createPlaylistWithTracks: async (name, trackIds) => {
          createdPlaylistTracks = trackIds;
          // Simulate only 1 of 2 added to verify B28 skippedCount
          return {
            playlistId: "new-pl-1",
            playlistName: name,
            playlistUrl: "https://music.163.com/#/playlist?id=new-pl-1",
            addedCount: trackIds.length,
          };
        },
        addTracksToPlaylist: async (playlistId, trackIds) => {
          appendedPlaylist = { playlistId, trackIds };
          return { addedCount: Math.max(0, trackIds.length - 1) };
        },
        getAllPlaylistTracks: async () => [
          makeSong("netease", "a-1", "可播曲1", "歌手A"),
          makeSong("netease", "a-2", "可播曲2", "歌手B"),
        ],
      },
      qq: {
        searchTracks: async () => [makeSong("qq", "qq-1", "晴天", "周杰伦")],
        createPlaylistWithTracks: async () => {
          throw new Error("Should never fall back to creating a new playlist when existingPlaylistId is set");
        },
        // QQ deliberately omits addTracksToPlaylist (T10)
        addTracksToPlaylist: undefined,
      },
    },
    async ({ service, jobs, events }) => {
      // 1) Transfer producing manual_review
      const queued = service.startTransferJob(actor, {
        sourceProvider: "text",
        targetProvider: "netease",
        rawText: "晴天 - 周杰伦",
        checkAvailability: false,
      });
      const done = await waitForJobDone(jobs, queued.id);
      const initial = done.result as TransferResult;
      assert.equal(initial.results[0]?.status, "manual_review");
      assert.equal(initial.summary.matched, 0);
      assert.equal(initial.summary.manualReview, 1);

      // 2) Manual select cand-2 (F15)
      const selectedJob = service.updateTransferTrackSelection(actor, queued.id, {
        index: 0,
        action: "select",
        targetTrackId: "cand-2",
      });
      const afterSelect = selectedJob.result as TransferResult;
      assert.equal(afterSelect.results[0]?.status, "matched");
      assert.equal(afterSelect.results[0]?.selectedCandidate?.targetTrackId, "cand-2");
      assert.equal(afterSelect.summary.matched, 1);
      assert.equal(afterSelect.summary.manualReview, 0);
      assert.ok(events.some((e) => e.type === "job_updated" && e.job?.id === queued.id));

      // 3) Import uses the manually selected track cand-2
      const imported = await service.importTransferResultToPlatform(actor, queued.id, {
        name: "人工确认歌单",
      });
      assert.deepEqual(createdPlaylistTracks, ["cand-2"]);
      assert.equal(imported.addedCount, 1);
      assert.equal(imported.skippedCount, 0);

      // 4) Manual skip and reset round-trip
      const skippedJob = service.updateTransferTrackSelection(actor, queued.id, {
        index: 0,
        action: "skip",
      });
      assert.equal((skippedJob.result as TransferResult).results[0]?.status, "skipped");
      assert.equal((skippedJob.result as TransferResult).summary.skipped, 1);

      const resetJob = service.updateTransferTrackSelection(actor, queued.id, {
        index: 0,
        action: "reset",
      });
      assert.equal((resetJob.result as TransferResult).results[0]?.status, "manual_review");
      assert.equal((resetJob.result as TransferResult).summary.manualReview, 1);

      // 5) T10 + B28: import_audit supports existingPlaylistId append and reports skippedCount = attempted - added
      const auditJob = service.startImportAuditJob(actor, {
        playlistId: "pl-audit",
        maxTracks: 10,
        candidateLimit: 3,
        checkAvailability: false,
      });
      await waitForJobDone(jobs, auditJob.id);
      const auditImport = await service.importTransferResultToPlatform(actor, auditJob.id, {
        existingPlaylistId: "existing-999",
      });
      assert.deepEqual(appendedPlaylist, {
        playlistId: "existing-999",
        trackIds: ["a-1", "a-2"],
      });
      assert.equal(auditImport.addedCount, 1);
      assert.equal(auditImport.skippedCount, 1);

      // 6) T10: specifying existingPlaylistId on QQ (no addTracksToPlaylist) MUST throw FEATURE_UNSUPPORTED
      const qqTransfer = service.startTransferJob(actor, {
        sourceProvider: "text",
        targetProvider: "qq",
        rawText: "晴天 - 周杰伦",
        checkAvailability: false,
      });
      await waitForJobDone(jobs, qqTransfer.id);
      await assert.rejects(
        () =>
          service.importTransferResultToPlatform(actor, qqTransfer.id, {
            existingPlaylistId: "qq-existing-1",
          }),
        (err: unknown) => err instanceof AppError && err.code === "FEATURE_UNSUPPORTED",
      );
    },
  );
});
