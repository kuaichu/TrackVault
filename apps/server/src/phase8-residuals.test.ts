import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ImportAuditResult, MusicPlatform, Song, TransferResult, TransferTrack } from "#shared";
import { verifyDownloadedAudioFile } from "./application/media/media-service.js";
import { TransferService } from "./application/transfer/transfer-service.js";
import type { ActorContext } from "./domain/context.js";
import { AppError } from "./domain/errors.js";
import { comparePlaylistsAsync } from "./domain/transfer/matcher.js";
import { NeteaseAdapter } from "./infrastructure/providers/netease/netease-adapter.js";
import { QqMusicAdapter } from "./infrastructure/providers/qq/qq-adapter.js";
import { SafeHttpClient } from "./infrastructure/security/safe-http-client.js";

const actor: ActorContext = {
  userId: "user-p8",
  username: "phase8",
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
    availableQualities: [{ level: "standard", label: "128K" }],
    availability: {
      playback: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
      download: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
    },
  };
}

test("Phase 8 · J01: verifyDownloadedAudioFile requires complete first frame / container header across MP3, AAC, FLAC, WAV, OGG, and M4A", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-p8-j01-"));
  const writeCheck = async (name: string, bytes: Uint8Array) => {
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, bytes);
    return verifyDownloadedAudioFile(file);
  };

  try {
    // 1. MP3: 417-byte frame passes; 100-byte or 416-byte truncated first frame fails
    const fullMp3Frame = Buffer.alloc(417);
    fullMp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
    assert.equal(await writeCheck("full.mp3", fullMp3Frame), true);
    assert.equal(await writeCheck("trunc-100.mp3", fullMp3Frame.subarray(0, 100)), false);
    assert.equal(await writeCheck("trunc-416.mp3", fullMp3Frame.subarray(0, 416)), false);

    // 2. AAC ADTS: 7-byte header declaring aac_frame_length = 64
    const aacLen = 64;
    const fullAac = Buffer.alloc(aacLen);
    fullAac[0] = 0xff;
    fullAac[1] = 0xf1;
    fullAac[2] = 0x50;
    fullAac[3] = 0x80 | ((aacLen >>> 11) & 0x03);
    fullAac[4] = (aacLen >>> 3) & 0xff;
    fullAac[5] = ((aacLen & 0x07) << 5) | 0x1f;
    fullAac[6] = 0xfc;
    assert.equal(await writeCheck("full.aac", fullAac), true);
    assert.equal(await writeCheck("trunc.aac", fullAac.subarray(0, 30)), false);

    // 3. FLAC: 42-byte STREAMINFO container passes; 20-byte truncated fails
    const fullFlac = Buffer.alloc(42);
    fullFlac.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
    assert.equal(await writeCheck("full.flac", fullFlac), true);
    assert.equal(await writeCheck("trunc.flac", fullFlac.subarray(0, 20)), false);

    // 4. WAV: >= 44 bytes passes; 16 bytes fails
    const fullWav = Buffer.alloc(44);
    fullWav.set([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    assert.equal(await writeCheck("full.wav", fullWav), true);
    assert.equal(await writeCheck("trunc.wav", fullWav.subarray(0, 16)), false);

    // 5. OGG: >= 27-byte page header + segment table passes; 12 bytes fails
    const fullOgg = Buffer.alloc(28);
    fullOgg.set([0x4f, 0x67, 0x67, 0x53]);
    fullOgg[26] = 1;
    assert.equal(await writeCheck("full.ogg", fullOgg), true);
    assert.equal(await writeCheck("trunc.ogg", fullOgg.subarray(0, 12)), false);

    // 6. M4A: declared 32-byte ftyp box passes at 32 bytes, fails when truncated at 12 bytes
    const fullM4a = Buffer.alloc(32);
    fullM4a.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    assert.equal(await writeCheck("full.m4a", fullM4a), true);
    assert.equal(await writeCheck("trunc.m4a", fullM4a.subarray(0, 12)), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Phase 8 · A09 + P06 + T11 + A12: Netease scannedTotal=10,000, in-flight likelist vs toggleSongLike cache safety, solo #2001/#12005 selection, and QQ missing data vs empty purl", async () => {
  const neAuth = {
    platform: "netease" as const,
    cookie: "MUSIC_U=valid",
    scopeKey: "u-p8",
    accountUid: "77",
  };

  // 1. A09 + T11: 12,005 tracks where track #500 is unmappable (missing name) -> scannedTotal MUST be 10,000 (not 9,999),
  //    selecting ["2001"] succeeds, and selecting ["12005"] returns truncated empty result without throwing VALIDATION_ERROR
  const all12005Ids = Array.from({ length: 12_005 }, (_, i) => i + 1);
  let resolveSlowLikelist!: (val: { body: Record<string, unknown> }) => void;
  let likelistCalls = 0;

  const neAdapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 901,
            name: "Huge Playlist",
            trackCount: all12005Ids.length,
            trackIds: all12005Ids.map((id) => ({ id })),
          },
        },
      }),
      song_detail: async ({ ids }) => ({
        body: {
          code: 200,
          songs: String(ids)
            .split(",")
            .map(Number)
            .map((id) =>
              id === 500
                ? { id } // Unmappable slot inside first 10,000
                : { id, name: `Track ${id}`, ar: [{ name: "Artist" }], dt: 180_000, al: { name: "Album" } },
            ),
        },
      }),
      likelist: async () => {
        likelistCalls += 1;
        return new Promise((resolve) => {
          resolveSlowLikelist = resolve;
        });
      },
      like: async () => ({ body: { code: 200 } }),
    },
  });

  const searchPage = await neAdapter.getPlaylistTracks(
    "901",
    { page: 1, limit: 20, keyword: "Track 2001" },
    neAuth,
  );
  assert.equal(searchPage.truncated, true);
  assert.equal(searchPage.scannedTotal, 10_000);
  assert.equal(searchPage.songs[0]?.id, "2001");

  // 2. P06: Slow likelist GET started BEFORE toggleSongLike("new-heart", true) resolves AFTER toggleSongLike
  //    and MUST NOT overwrite the 2-minute cache with stale ["old-heart"]!
  const slowGetPromise = neAdapter.getLikedSongIds(neAuth);
  await neAdapter.toggleSongLike("new-heart", true, neAuth);
  resolveSlowLikelist({ body: { code: 200, ids: ["old-heart"] } });
  const initialIds = await slowGetPromise;
  assert.deepEqual(initialIds.sort(), ["new-heart", "old-heart"]);

  // Subsequent read within 2-minute cache window hits cache (likelistCalls remains 1) and still has "new-heart"
  const cachedIds = await neAdapter.getLikedSongIds(neAuth);
  assert.equal(likelistCalls, 1);
  assert.deepEqual(cachedIds.sort(), ["new-heart", "old-heart"]);

  // 3. T11: TransferService solo ["2001"] hits via 10,000 deep scan; solo ["12005"] beyond 10,000 discloses truncation cleanly
  const syncRuntime = { signal: new AbortController().signal, updateProgress() {} };
  const transfer = new TransferService({
    providers: { get: () => neAdapter } as never,
    credentials: { getDecryptedCookie: () => "MUSIC_U=valid" } as never,
    jobs: { enqueue: ({ runner }: { runner: (h: unknown) => unknown }) => runner(syncRuntime) } as never,
  });

  const solo2001 = (await (transfer.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "netease",
    playlistId: "901",
    selectedSourceTrackIds: ["2001"],
    checkAvailability: false,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.deepEqual(
    solo2001.result.results.map((r) => r.sourceTrack.sourceTrackId),
    ["2001"],
  );
  assert.equal(solo2001.result.truncated, false);

  const solo12005 = (await (transfer.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "netease",
    playlistId: "901",
    selectedSourceTrackIds: ["12005"],
    checkAvailability: false,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.deepEqual(solo12005.result.results, []);
  assert.equal(solo12005.result.sourceTotal, 1);
  assert.equal(solo12005.result.unprocessedCount, 1);
  assert.equal(solo12005.result.truncated, true);

  // 4. A12: QQ code=0 missing req_0.data/midurlinfo -> UPSTREAM_ERROR; intact structure with empty purl -> COPYRIGHT_UNAVAILABLE
  const qqAuth = { platform: "qq" as const, cookie: "uin=10001; qm_keyst=ok", scopeKey: "u-p8" };
  const missingStructHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, req_0: { code: 0 } }), { status: 200 }),
  });
  const missingStructQq = new QqMusicAdapter(missingStructHttp);
  await assert.rejects(
    () => missingStructQq.resolveAudio({ id: "001" }, "standard", "playback", qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
  missingStructHttp.close();

  const emptyPurlHttp = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          code: 0,
          req_0: {
            code: 0,
            data: { sip: ["https://ws.stream.qqmusic.qq.com/"], midurlinfo: [{ purl: "" }] },
          },
        }),
        { status: 200 },
      ),
  });
  const emptyPurlQq = new QqMusicAdapter(emptyPurlHttp);
  await assert.rejects(
    () => emptyPurlQq.resolveAudio({ id: "001" }, "standard", "playback", qqAuth),
    (err: unknown) => err instanceof AppError && err.code === "COPYRIGHT_UNAVAILABLE",
  );
  emptyPurlHttp.close();
});

test("Phase 8 · T06 + T09: bidirectional permutation invariance across all compare categories & probe timeout separation", async () => {
  // 1. T06: Permuting BOTH left and right playlists yields identical summary counts
  const mk = (id: string, title: string, artists: string[]): TransferTrack => ({
    source: "netease",
    sourceTrackId: id,
    title,
    artists,
    album: "Album",
    durationSeconds: 180,
  });
  const duet = mk("D", "Echo", ["甲", "乙"]);
  const live = mk("L", "Echo (Live)", ["甲"]);
  const other = mk("O", "Echo", ["丙"]);
  const rA = mk("a", "Echo", ["甲"]);
  const rB = mk("b", "Echo", ["乙"]);
  const rC = mk("c", "Echo", ["丁"]);

  const leftPerms = [
    [duet, live, other],
    [live, duet, other],
    [other, live, duet],
  ];
  const rightPerms = [
    [rA, rB, rC],
    [rB, rA, rC],
    [rC, rB, rA],
  ];

  let baseline: Awaited<ReturnType<typeof comparePlaylistsAsync>>["summary"] | null = null;
  for (const lTracks of leftPerms) {
    for (const rTracks of rightPerms) {
      const res = await comparePlaylistsAsync({
        left: { provider: "netease", playlistId: "L", playlistName: "L", tracks: lTracks },
        right: { provider: "qq", playlistId: "R", playlistName: "R", tracks: rTracks },
      });
      if (!baseline) {
        baseline = res.summary;
        assert.equal(baseline.exact, 1);
        assert.equal(baseline.similarTitle, 1);
        assert.equal(baseline.sameTitleDifferentArtist, 1);
      } else {
        assert.deepEqual(res.summary, baseline);
      }
    }
  }

  // 2. T09: When checkAvailability: true and resolveAudio throws UPSTREAM_TIMEOUT, neither transfer nor audit conflates it with verified playable
  const timeoutProvider = {
    getAllPlaylistTracks: async () => [makeSong("netease", "n-timeout", "Timeout Song", false)],
    searchTracks: async () => [makeSong("qq", "q-timeout", "Timeout Song", false)],
    resolveAudio: async () => {
      throw new AppError("UPSTREAM_TIMEOUT", "音源网关超时");
    },
  };
  const syncRuntime = { signal: new AbortController().signal, updateProgress() {} };
  const service = new TransferService({
    providers: { get: () => timeoutProvider } as never,
    credentials: { getDecryptedCookie: () => "COOKIE" } as never,
    jobs: { enqueue: ({ runner }: { runner: (h: unknown) => unknown }) => runner(syncRuntime) } as never,
  });

  const auditRes = (await (service.startImportAuditJob(actor, {
    playlistId: "pl-t09",
    maxTracks: 5,
    candidateLimit: 2,
    checkAvailability: true,
  }) as unknown as Promise<{ result: ImportAuditResult }>)) as { result: ImportAuditResult };
  assert.equal(auditRes.result.playableCount, 0);
  assert.equal(auditRes.result.issueCount, 1);
  assert.ok(auditRes.result.issues[0]?.reason.includes("音源实测未完成"));

  const transferRes = (await (service.startTransferJob(actor, {
    sourceProvider: "netease",
    targetProvider: "qq",
    playlistId: "pl-t09",
    checkAvailability: true,
  }) as unknown as Promise<{ result: TransferResult }>)) as { result: TransferResult };
  assert.equal(transferRes.result.summary.matched, 0);
  assert.equal(transferRes.result.summary.manualReview, 1);
  assert.ok(transferRes.result.results[0]?.reason?.includes("音源实测未完成"));
});
