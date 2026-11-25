import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JobEvent, MusicPlatform, Song } from "#shared";
import { buildServer } from "../../app.js";
import { loadServerConfig } from "../../config/env.js";
import type { ActorContext } from "../../domain/context.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import { BackgroundJobManager } from "./background-job-manager.js";

function extractCookieHeader(setCookies: string | string[] | undefined): string {
  const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

function makeSong(id: string, title: string, platform: MusicPlatform = "netease"): Song {
  return {
    id,
    platform,
    title,
    artist: "周杰伦",
    artists: [{ name: "周杰伦" }],
    album: "专辑",
    durationSeconds: 200,
    duration: "03:20",
    quality: "320K",
    availableQualities: [{ level: "exhigh", label: "320K" }],
  };
}

test("loadServerConfig normalizes SQLITE_JOURNAL_MODE and SqliteClient applies configured journal_mode on file DB", async () => {
  assert.equal(loadServerConfig({}).sqliteJournalMode, "WAL");
  const truncateConfig = loadServerConfig({ SQLITE_JOURNAL_MODE: "truncate" });
  assert.equal(truncateConfig.sqliteJournalMode, "TRUNCATE");
  assert.equal(loadServerConfig({ SQLITE_JOURNAL_MODE: " delete " }).sqliteJournalMode, "DELETE");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-journal-mode-"));
  const sqlite = new SqliteClient(path.join(tmpDir, "network-share.db"), {
    journalMode: truncateConfig.sqliteJournalMode,
  });
  try {
    const row = sqlite.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(row.journal_mode.toUpperCase(), "TRUNCATE");
  } finally {
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("SqliteClient supports nested SAVEPOINT transactions and case-insensitive unique usernames", () => {
  const sqlite = new SqliteClient(":memory:");
  try {
    const now = Date.now();
    sqlite.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
         VALUES ('u1', 'Alice', 'h', 'admin', 1, ?)`,
      )
      .run(now);

    assert.throws(() => {
      sqlite.db
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
           VALUES ('u2', 'alice', 'h', 'member', 0, ?)`,
        )
        .run(now);
    });

    sqlite.immediateTransaction(() => {
      sqlite.db
        .prepare("INSERT INTO search_history (user_id, keyword, updated_at) VALUES ('u1', 'outer', ?)")
        .run(now);

      assert.throws(() => {
        sqlite.transaction(() => {
          sqlite.db
            .prepare(
              "INSERT INTO search_history (user_id, keyword, updated_at) VALUES ('u1', 'inner-fail', ?)",
            )
            .run(now);
          throw new Error("inner rollback");
        });
      });

      sqlite.transaction(() => {
        sqlite.db
          .prepare("INSERT INTO search_history (user_id, keyword, updated_at) VALUES ('u1', 'inner-ok', ?)")
          .run(now);
      });
    });

    const keywords = sqlite.db
      .prepare("SELECT keyword FROM search_history WHERE user_id = 'u1' ORDER BY keyword ASC")
      .all() as Array<{ keyword: string }>;
    assert.deepEqual(
      keywords.map((k) => k.keyword),
      ["inner-ok", "outer"],
    );
  } finally {
    sqlite.close();
  }
});

test("BackgroundJobManager.stop() persists cancelled state and #execute CAS prevents cancelled jobs from becoming completed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p1-stop-cas-"));
  const sqlite = new SqliteClient(path.join(tmpDir, "test.db"));
  const actor: ActorContext = { userId: "u-cas", username: "cas", role: "admin", trustedFallback: false };
  sqlite.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
       VALUES (?, ?, 'h', 'admin', 0, ?)`,
    )
    .run(actor.userId, actor.username, Date.now());

  const repo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo,
    tmpDownloadsDir: path.join(tmpDir, "downloads"),
    globalMaxConcurrentDownloads: 1,
    globalMaxConcurrentJobs: 1,
  });

  try {
    let releaseRunner: () => void = () => undefined;
    const runnerGate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });

    const runningJob = jobs.enqueue({
      actor,
      kind: "transfer",
      title: "CAS Running Job",
      runner: async () => {
        await runnerGate;
        return { result: { ok: true }, subtitle: "should-not-overwrite" };
      },
    });
    const queuedJob = jobs.enqueue({
      actor,
      kind: "transfer",
      title: "CAS Queued Job",
      runner: async () => ({ result: { ok: true } }),
    });

    // Wait a tick so job 1 enters running
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(repo.findRawSummaryById(runningJob.id)?.status, "running");
    assert.equal(repo.findRawSummaryById(queuedJob.id)?.status, "queued");

    // Cancel running job, then let the runner resolve late -> CAS must preserve 'cancelled'
    jobs.cancelOwnedJob(actor, runningJob.id);
    assert.equal(repo.findRawSummaryById(runningJob.id)?.status, "cancelled");
    releaseRunner();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(repo.findRawSummaryById(runningJob.id)?.status, "cancelled");
    assert.equal(repo.findRawSummaryById(runningJob.id)?.hasResult, false);

    // Enqueue a running job + a queued job, then stop() -> both must be persisted as 'cancelled' (not 'running')
    let releaseStopRunner: () => void = () => undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStopRunner = resolve;
    });
    const stopRunning = jobs.enqueue({
      actor,
      kind: "transfer",
      title: "Stop Running Job",
      runner: async () => {
        await stopGate;
        return { result: { late: true } };
      },
    });
    const stopQueued = jobs.enqueue({
      actor,
      kind: "transfer",
      title: "Stop Queued Job",
      runner: async () => ({ result: { late: true } }),
    });
    await new Promise((r) => setTimeout(r, 20));

    jobs.stop();
    releaseStopRunner();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(repo.findRawSummaryById(stopRunning.id)?.status, "cancelled");
    assert.equal(repo.findRawSummaryById(stopQueued.id)?.status, "cancelled");
  } finally {
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("GET /api/jobs skips result_json deserialization and returns monotonic serverRevision/clearedBeforeRevision; /api/history/play returns monotonic revision", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p1-routes-"));
  const config = loadServerConfig({
    NODE_ENV: "test",
    DATA_DIR: tmpDir,
    ALLOWED_ORIGINS: "http://localhost:5173",
    COOKIE_SECURE: "false",
  });

  const providers = new ProviderRegistry();
  const stubAdapter: MusicProviderAdapter = {
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
    searchTracks: async () => [makeSong("1", "晴天")],
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
      durationSeconds: 200,
      trial: false,
      downgraded: false,
    }),
  };
  providers.register(stubAdapter);
  providers.register({ ...stubAdapter, platform: "qq" });

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
      payload: { username: "revuser", password: "Password123!" },
    });
    assert.equal(setupRes.statusCode, 201);
    const cookie = extractCookieHeader(setupRes.headers["set-cookie"]);
    const userId = setupRes.json().user.id as string;

    const sseEvents: JobEvent[] = [];
    const unsubscribe = server.jobs.subscribe(userId, (evt) => sseEvents.push(evt));

    // Create and complete a transfer job with a real result payload
    const startRes = await server.app.inject({
      method: "POST",
      url: "/api/transfer/jobs",
      headers: { cookie },
      payload: { sourceProvider: "text", targetProvider: "netease", rawText: "晴天 - 周杰伦" },
    });
    assert.equal(startRes.statusCode, 202);
    const jobId = startRes.json().job.id as string;

    for (let i = 0; i < 40; i += 1) {
      const detail = await server.app.inject({
        method: "GET",
        url: `/api/jobs/${jobId}`,
        headers: { cookie },
      });
      if (detail.json().job.status === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Inject a raw malformed result_json on another completed row to prove GET /api/jobs never parses result_json
    const now = Date.now();
    server.sqlite.db
      .prepare(
        `INSERT INTO background_jobs (
          id, user_id, kind, status, progress, title, result_json, revision, created_at, updated_at
        ) VALUES ('unparsed-summary-check', ?, 'transfer', 'completed', 100, 'Large Payload', '{NOT_JSON', 99, ?, ?)`,
      )
      .run(userId, now, now);

    const origJsonParse = JSON.parse;
    let listParseCalls = 0;
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      listParseCalls += 1;
      return origJsonParse(text, reviver);
    }) as typeof JSON.parse;

    let listRes: Awaited<ReturnType<typeof server.app.inject>> | undefined;
    try {
      listRes = await server.app.inject({
        method: "GET",
        url: "/api/jobs?kind=transfer",
        headers: { cookie },
      });
    } finally {
      JSON.parse = origJsonParse;
    }
    assert.ok(listRes);
    assert.equal(listRes.statusCode, 200);
    const listJson = listRes.json() as {
      jobs: Array<{ id: string; hasResult?: boolean; result?: unknown; revision?: number }>;
      serverRevision: number;
      clearedBeforeRevision: number;
    };

    assert.equal(listParseCalls, 0, "GET /api/jobs must not call JSON.parse on result_json");
    assert.ok(listJson.serverRevision >= 3);
    assert.equal(listJson.clearedBeforeRevision, 0);
    const summaryJob = listJson.jobs.find((j) => j.id === jobId);
    assert.ok(summaryJob);
    assert.equal(summaryJob.hasResult, true);
    assert.equal(summaryJob.result, undefined);
    assert.ok((summaryJob.revision ?? 0) > 0);

    const detailRes = await server.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { cookie },
    });
    assert.equal(detailRes.statusCode, 200);
    assert.ok(detailRes.json().job.result);

    // Clear finished transfer jobs -> increments serverRevision and updates clearedBeforeRevision
    const clearRes = await server.app.inject({
      method: "DELETE",
      url: "/api/jobs/finished?kind=transfer",
      headers: { cookie },
    });
    assert.equal(clearRes.statusCode, 200);
    const clearJson = clearRes.json();
    assert.equal(clearJson.removedCount, 2);
    assert.ok(clearJson.serverRevision > listJson.serverRevision);
    assert.equal(clearJson.clearedBeforeRevision, clearJson.serverRevision);

    const listAfterClear = await server.app.inject({
      method: "GET",
      url: "/api/jobs?kind=transfer",
      headers: { cookie },
    });
    assert.equal(listAfterClear.json().jobs.length, 0);
    assert.equal(listAfterClear.json().serverRevision, clearJson.serverRevision);
    assert.equal(listAfterClear.json().clearedBeforeRevision, clearJson.clearedBeforeRevision);

    assert.ok(
      sseEvents.some(
        (e) =>
          e.type === "job_updated" &&
          e.job?.id === jobId &&
          e.job.result === undefined &&
          (e.serverRevision ?? 0) > 0,
      ),
    );
    assert.ok(
      sseEvents.some(
        (e) => e.type === "jobs_cleared" && e.clearedBeforeRevision === clearJson.clearedBeforeRevision,
      ),
    );
    unsubscribe();

    // P1-3: /api/history/play monotonic revision across GET -> POST -> POST -> DELETE -> GET
    const h0 = await server.app.inject({ method: "GET", url: "/api/history/play", headers: { cookie } });
    assert.equal(h0.statusCode, 200);
    assert.deepEqual(h0.json(), { items: [], revision: 0 });

    const h1 = await server.app.inject({
      method: "POST",
      url: "/api/history/play",
      headers: { cookie },
      payload: { song: makeSong("s1", "七里香") },
    });
    assert.equal(h1.statusCode, 200);
    assert.equal(h1.json().revision, 1);
    assert.equal(h1.json().items.length, 1);

    const h2 = await server.app.inject({
      method: "POST",
      url: "/api/history/play",
      headers: { cookie },
      payload: { song: makeSong("s2", "稻香") },
    });
    assert.equal(h2.statusCode, 200);
    assert.equal(h2.json().revision, 2);
    assert.equal(h2.json().items[0].id, "s2");

    const hDel = await server.app.inject({ method: "DELETE", url: "/api/history/play", headers: { cookie } });
    assert.equal(hDel.statusCode, 200);
    assert.deepEqual(hDel.json(), { items: [], revision: 3 });

    const hGetAfter = await server.app.inject({
      method: "GET",
      url: "/api/history/play",
      headers: { cookie },
    });
    assert.deepEqual(hGetAfter.json(), { items: [], revision: 3 });
  } finally {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
