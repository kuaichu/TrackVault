import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { injectMp3Metadata } from "#audio-tags";
import type { ImportAuditResult, MusicPlatform, Song, TransferResult, TransferTrack } from "#shared";
import { BackgroundJobManager } from "./application/jobs/background-job-manager.js";
import { MediaService, verifyDownloadedAudioFile } from "./application/media/media-service.js";
import { TransferService } from "./application/transfer/transfer-service.js";
import type { ActorContext } from "./domain/context.js";
import { AppError } from "./domain/errors.js";
import { ProviderRegistry } from "./domain/ports/music-provider.js";
import { comparePlaylistsAsync } from "./domain/transfer/matcher.js";
import { SqliteClient } from "./infrastructure/db/client.js";
import { JobRepository, toJobView } from "./infrastructure/db/repositories/job-repository.js";
import { NeteaseAdapter } from "./infrastructure/providers/netease/netease-adapter.js";
import { QqMusicAdapter } from "./infrastructure/providers/qq/qq-adapter.js";
import { SafeHttpClient } from "./infrastructure/security/safe-http-client.js";

const actor: ActorContext = {
  userId: "user-p7",
  username: "phase7",
  role: "admin",
  trustedFallback: false,
};

function makeSong(platform: MusicPlatform, id: string, title: string, locked = false): Song {
  return {
    id,
    platform,
    title,
    artist: "Artist",
    artists: [{ name: "Artist" }],
    album: "Album",
    durationSeconds: 180,
    duration: "03:00",
    quality: "320K",
    availableQualities: [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
    availability: {
      playback: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
      download: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
    },
  };
}

function makeLargeCoverMp3(): Uint8Array {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const plainMp3 = Buffer.concat(Array.from({ length: 8 }, () => frame));

  const pngChunk = (type: string, bytes: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    const lenBuf = Buffer.alloc(4);
    const crcBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(bytes.length);
    crcBuf.writeUInt32BE(crc32(payload));
    return Buffer.concat([lenBuf, payload, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  // ~12.5 KB uncompressed PNG (> 4096 byte initial read window)
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc((1 + 64 * 3) * 64), { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);

  return injectMp3Metadata(
    plainMp3,
    { title: "BigCover", artist: "Artist", album: "Album", source: "netease" },
    "",
    { mimeType: "image/png", bytes: png },
  );
}

test("Phase 7 · J01 + J04 + A14: >4KB ID3v2 cover MP3 accepted, audio-less ID3v2 rejected, vivid 384K preserved, missing temp files marked expired on startup/read", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p7-media-"));
  const sqlite = new SqliteClient(":memory:");
  sqlite.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at) VALUES (?, ?, 'h', 'admin', 0, ?)",
    )
    .run(actor.userId, actor.username, Date.now());

  try {
    // 1. J01: verifyDownloadedAudioFile accepts >12KB ID3v2 MP3 and rejects ID3v2 followed by plain text or truncated header
    const bigCoverMp3 = makeLargeCoverMp3();
    assert.ok(bigCoverMp3.byteLength > 12_000);
    const validPath = path.join(tmpDir, "valid-big-cover.mp3");
    await fs.writeFile(validPath, bigCoverMp3);
    assert.equal(await verifyDownloadedAudioFile(validPath), true);

    // ID3v2 header claiming 5,000 bytes followed by plain text "Upstream error" -> must be rejected
    const fakeBody = Buffer.alloc(5000, 0x20);
    const fakeHeader = Buffer.from([
      0x49,
      0x44,
      0x33,
      0x03,
      0x00,
      0x00,
      (5000 >>> 21) & 0x7f,
      (5000 >>> 14) & 0x7f,
      (5000 >>> 7) & 0x7f,
      5000 & 0x7f,
    ]);
    const fakeMp3Path = path.join(tmpDir, "fake-after-id3.mp3");
    await fs.writeFile(
      fakeMp3Path,
      Buffer.concat([fakeHeader, fakeBody, Buffer.from("Upstream error text")]),
    );
    assert.equal(await verifyDownloadedAudioFile(fakeMp3Path), false);

    // 2. J04: Pre-insert a completed local download record whose .bin file was ALREADY deleted before startup
    const repo = new JobRepository(sqlite, { tmpDownloadsDir: tmpDir });
    repo.insert({
      id: "stale-missing-bin",
      userId: actor.userId,
      kind: "download",
      status: "completed",
      progress: 100,
      title: "Old Deleted Song",
      artifactFilename: "Old Deleted Song.mp3",
      metadata: { mode: "tagged_server" },
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    });

    const jobs = new BackgroundJobManager({
      repo,
      tmpDownloadsDir: tmpDir,
      globalMaxConcurrentDownloads: 2,
      globalMaxConcurrentJobs: 2,
    });

    try {
      // Immediately after startup (without clicking Save or running periodic cleaner), downloadReady is false & artifactExpired is true
      const listed = jobs.listForActor(actor, "download");
      const staleView = listed.find((j) => j.id === "stale-missing-bin");
      assert.ok(staleView);
      assert.equal(staleView.downloadReady, false);
      assert.equal(staleView.artifactExpired, true);

      // Also verify external deletion after completion is caught immediately on read
      const livePath = path.join(tmpDir, actor.userId, "live-del-1.bin");
      await fs.mkdir(path.dirname(livePath), { recursive: true });
      await fs.writeFile(livePath, bigCoverMp3);
      repo.insert({
        id: "live-del-1",
        userId: actor.userId,
        kind: "download",
        status: "completed",
        progress: 100,
        title: "Externally Removed",
        artifactFilename: "Externally Removed.mp3",
        metadata: { mode: "tagged_server" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      assert.equal(toJobView(jobs.getOwnedJob(actor, "live-del-1")).downloadReady, true);
      await fs.unlink(livePath);
      const afterUnlink = toJobView(jobs.getOwnedJob(actor, "live-del-1"));
      assert.equal(afterUnlink.downloadReady, false);
      assert.equal(afterUnlink.artifactExpired, true);

      // 3. J01 + A14 end-to-end download: MP3 with >12KB cover & Netease vivid 384kbps succeeds and shows "臻音 384K"
      const providers = new ProviderRegistry();
      providers.register({
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
        resolveAudio: async () => ({
          url: "https://m7.music.126.net/vivid384.mp3",
          format: "mp3",
          bitrate: 384_000,
          level: "vivid",
          durationSeconds: 180,
          trial: false,
          downgraded: false,
        }),
      });

      const http = new SafeHttpClient({
        resolveHost: async () => [{ address: "1.2.3.4" }],
        fetchImpl: async () =>
          new Response(Buffer.from(bigCoverMp3), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      });

      const media = new MediaService({
        providers,
        credentials: {
          getDecryptedCookie: () => "MUSIC_U=ok",
          getDecryptedSystemFallbackCookie: () => null,
        } as never,
        userState: { getSettings: () => ({ maxConcurrentDownloads: 2 }) } as never,
        http,
        jobs,
        maxCoverBytes: 100_000,
        maxAudioBytes: 2_000_000,
      });

      const enqueued = media.enqueueDownload(actor, {
        song: makeSong("netease", "v1", "Vivid Song"),
        level: "exhigh",
        mode: "tagged_server",
      });
      for (let i = 0; i < 50; i += 1) {
        if (jobs.getOwnedJob(actor, enqueued.id).status === "completed") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const completed = toJobView(jobs.getOwnedJob(actor, enqueued.id));
      assert.equal(completed.status, "completed");
      assert.ok(completed.subtitle?.includes("臻音 384K"), `unexpected subtitle: ${completed.subtitle}`);
      assert.equal(completed.subtitle?.includes("320K"), false);
      http.close();
    } finally {
      jobs.stop();
    }
  } finally {
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Phase 7 · T06 + T09 + T11: order-independent duet/solo matching, Studio vs Live separation, locked track probing, and >1,000 selected IDs accounting", async () => {
  // 1. T06: Duet + Solo reordering yields [2, 2], and Studio vs Live is similar_title (NOT exact)
  const mkTrack = (id: string, title: string, artists: string[]): TransferTrack => ({
    source: "netease",
    sourceTrackId: id,
    title,
    artists,
  });
  const duet = mkTrack("duet", "Echo", ["One", "Two"]);
  const one = mkTrack("one", "Echo", ["One"]);
  const two = mkTrack("two", "Echo", ["Two"]);

  const cmp1 = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: [duet, one] },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: [one, two] },
  });
  const cmp2 = await comparePlaylistsAsync({
    left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: [one, duet] },
    right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: [one, two] },
  });
  assert.deepEqual([cmp1.summary.exact, cmp2.summary.exact], [2, 2]);

  const studioVsLive = await comparePlaylistsAsync({
    left: {
      provider: "netease",
      playlistId: "L",
      playlistName: "L",
      tracks: [mkTrack("1", "晴天", ["周杰伦"])],
    },
    right: {
      provider: "qq",
      playlistId: "R",
      playlistName: "R",
      tracks: [mkTrack("2", "晴天 (Live)", ["周杰伦"])],
    },
  });
  assert.equal(studioVsLive.summary.exact, 0);
  assert.equal(studioVsLive.summary.similarTitle, 1);

  // 2. T09: Statically locked song is actively probed in BOTH audit and transfer when checkAvailability: true
  const probedIds: string[] = [];
  const lockedSong = makeSong("netease", "vip-1", "VIP Locked Song", true);
  const largePlaylist = Array.from({ length: 12_005 }, (_, idx) =>
    makeSong("netease", String(idx + 1), `Track ${idx + 1}`, false),
  );

  let currentPlaylist = [lockedSong];
  const provider = {
    getAllPlaylistTracks: async (_id: string, _auth: unknown, max = 2000) => currentPlaylist.slice(0, max),
    getPlaylistTracks: async () => ({ total: currentPlaylist.length }),
    searchTracks: async () => [makeSong("qq", "qq-vip-1", "VIP Locked Song", true)],
    resolveAudio: async ({ id }: { id: string }) => {
      probedIds.push(id);
      return {
        url: "https://m7.music.126.net/unlocked.mp3",
        format: "mp3",
        bitrate: 320_000,
        level: "exhigh" as const,
        durationSeconds: 180,
        trial: false,
        downgraded: false,
      };
    },
  };

  const syncRuntime = { signal: new AbortController().signal, updateProgress() {} };
  const service = new TransferService({
    providers: { get: () => provider } as never,
    credentials: { getDecryptedCookie: () => "COOKIE" } as never,
    jobs: { enqueue: ({ runner }: { runner: (h: unknown) => unknown }) => runner(syncRuntime) } as never,
  });

  const auditOutcome = (await (service.startImportAuditJob(actor, {
    playlistId: "demo",
    maxTracks: 10,
    candidateLimit: 2,
    checkAvailability: true,
  }) as unknown as Promise<{ result: ImportAuditResult }>)) as { result: ImportAuditResult };
  assert.equal(auditOutcome.result.playableCount, 1);
  assert.deepEqual(probedIds, ["vip-1"]);

  probedIds.length = 0;
  const transferOutcome = (await (service.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "qq",
    playlistId: "demo",
    checkAvailability: true,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.equal(transferOutcome.result.summary.matched, 1);
  assert.deepEqual(probedIds, ["qq-vip-1"]);

  // 3. T11: Selected IDs ["1", "1001"] both found via deep scan; ["1", "12005"] beyond 10,000 ceiling explicitly disclosed
  currentPlaylist = largePlaylist.slice(0, 1001);
  const selected1001 = (await (service.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "netease",
    playlistId: "pl-1001",
    selectedSourceTrackIds: ["1", "1001"],
    checkAvailability: false,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.deepEqual(
    selected1001.result.results.map((r) => r.sourceTrack.sourceTrackId),
    ["1", "1001"],
  );
  assert.equal(selected1001.result.sourceTotal, 2);
  assert.equal(selected1001.result.unprocessedCount, 0);
  assert.equal(selected1001.result.truncated, false);

  currentPlaylist = largePlaylist;
  const selectedBeyondCap = (await (service.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "netease",
    playlistId: "pl-12005",
    selectedSourceTrackIds: ["1", "12005"],
    checkAvailability: false,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.deepEqual(
    selectedBeyondCap.result.results.map((r) => r.sourceTrack.sourceTrackId),
    ["1"],
  );
  assert.equal(selectedBeyondCap.result.sourceTotal, 2);
  assert.equal(selectedBeyondCap.result.unprocessedCount, 1);
  assert.equal(selectedBeyondCap.result.truncated, true);
});

test("Phase 7 · A02 + A10 + A11 + A12: Netease partial batch invalidates cache, cloud nextOffset uses raw rows, QQ 401/503 sub-requests propagate accurately", async () => {
  const neAuth = { platform: "netease" as const, cookie: "MUSIC_U=valid", scopeKey: "u1", accountUid: "99" };

  // 1. A02: 51-track delete where first 50 succeed and remaining 1 fails invalidates cached playlist detail
  let upstreamTrackIds = Array.from({ length: 51 }, (_, i) => String(i + 1));
  const neAdapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 888,
            name: "Batch List",
            trackCount: upstreamTrackIds.length,
            tracks: upstreamTrackIds.map((id) => ({
              id: Number(id),
              name: `Song ${id}`,
              ar: [{ name: "Singer" }],
              al: { name: "Album" },
              dt: 180_000,
            })),
            trackIds: upstreamTrackIds.map((id) => ({ id: Number(id) })),
          },
          privileges: [],
        },
      }),
      playlist_tracks: async (params) => {
        const batch = String(params.tracks ?? "")
          .split(",")
          .filter(Boolean);
        if (batch.length === 50) {
          const removeSet = new Set(batch);
          upstreamTrackIds = upstreamTrackIds.filter((id) => !removeSet.has(id));
          return { body: { code: 200, body: { code: 200 } } };
        }
        return { body: { code: 200, body: { code: 500, message: "第二批写入失败" } } };
      },
      user_cloud: async () => ({
        body: {
          code: 200,
          count: 205,
          // 100 raw rows, 1 row missing id/name so mapped songs.length === 99 while raw consumed === 100
          data: Array.from({ length: 100 }, (_, i) =>
            i === 50
              ? { simpleSong: {} }
              : { songId: i + 1, songName: `Cloud ${i + 1}`, artist: "U", album: "A" },
          ),
        },
      }),
      song_url_v1: async () => ({
        body: {
          data: [
            {
              url: "http://m7.music.126.net/v.mp4",
              type: "mp4",
              br: 384_000,
              level: "vivid",
              time: 180_000,
            },
          ],
        },
      }),
    },
  });

  // Prime playlist detail cache with 51 tracks
  const beforeDel = await neAdapter.getPlaylistTracks("888", { page: 1, limit: 100 }, neAuth);
  assert.equal(beforeDel.total, 51);

  const all51 = Array.from({ length: 51 }, (_, i) => String(i + 1));
  await assert.rejects(
    () => neAdapter.removeTracksFromPlaylist("888", all51, neAuth),
    (err: unknown) => err instanceof AppError && err.message.includes("50/51"),
  );

  // Cache MUST have been invalidated so subsequent read reflects the 1 remaining song on upstream!
  const afterPartialDel = await neAdapter.getPlaylistTracks("888", { page: 1, limit: 100 }, neAuth);
  assert.equal(afterPartialDel.total, 1);

  // 2. A10: nextOffset equals 100 (raw consumed rows) even when 1 unmappable entry made songs.length === 99
  const cloudPage = await neAdapter.getCloudTracksPage(neAuth, { offset: 0, limit: 100 });
  assert.equal(cloudPage.songs.length, 99);
  assert.equal(cloudPage.nextOffset, 100);
  assert.equal(cloudPage.hasMore, true);

  // 3. A14: NeteaseAdapter.resolveAudio preserves level === "vivid"
  const vividResolved = await neAdapter.resolveAudio({ id: "1" }, "exhigh", "playback", neAuth);
  assert.equal(vividResolved.level, "vivid");
  assert.equal(vividResolved.bitrate, 384_000);

  // 4. A11: QQ HTTP 401 on collected playlists sub-request (while created playlists returns empty 200) & detail HTTP 401 -> CREDENTIAL_INVALID
  const qqAuth = { platform: "qq" as const, cookie: "uin=123456; qm_keyst=expired", scopeKey: "u1" };
  const partial401Http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async (url) => {
      if (String(url).includes("fcg_user_created_diss")) {
        return new Response(JSON.stringify({ code: 0, data: { disslist: [] } }), { status: 200 });
      }
      return new Response("Unauthorized", { status: 401 });
    },
  });
  const qq401Adapter = new QqMusicAdapter(partial401Http);
  await assert.rejects(
    () => qq401Adapter.getUserPlaylists(qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  await assert.rejects(
    () => qq401Adapter.getPlaylistTracks("1001", { page: 1, limit: 20 }, qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );
  partial401Http.close();

  // 5. A12: QQ resolveAudio with HTTP 200 inner { code: 503 } OR tier-1 empty purl + tier-2 HTTP 503 throws UPSTREAM_ERROR
  const inner503Http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response(JSON.stringify({ code: 503, req_0: { code: 503 } }), { status: 200 }),
  });
  const inner503Adapter = new QqMusicAdapter(inner503Http);
  await assert.rejects(
    () => inner503Adapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "standard", "playback", qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  inner503Http.close();

  let callCount = 0;
  const mixed503Http = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        // First tier (F000 lossless) returns HTTP 200 with empty purl
        return new Response(
          JSON.stringify({
            code: 0,
            req_0: {
              code: 0,
              data: { sip: ["https://ws.stream.qqmusic.qq.com/"], midurlinfo: [{ purl: "" }] },
            },
          }),
          { status: 200 },
        );
      }
      // Subsequent fallback tiers fail with HTTP 503
      return new Response("Service Unavailable", { status: 503 });
    },
  });
  const mixed503Adapter = new QqMusicAdapter(mixed503Http);
  await assert.rejects(
    () => mixed503Adapter.resolveAudio({ id: "0039MnYb0qxYhV" }, "lossless", "playback", qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  mixed503Http.close();
});
