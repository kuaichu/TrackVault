import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { isFlacBytes, isMp3Bytes } from "#audio-tags";
import type { MusicPlatform, Song } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../../domain/ports/music-provider.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";
import { AesGcmCredentialVault } from "../../infrastructure/security/credential-vault.js";
import { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { MediaService } from "./media-service.js";

const actor: ActorContext = {
  userId: "user-stream-tag",
  username: "streamer",
  role: "admin",
  trustedFallback: false,
};

function makeSong(platform: MusicPlatform, id: string, title: string): Song {
  return {
    id,
    platform,
    title,
    artist: "周杰伦",
    artists: [{ name: "周杰伦" }],
    album: "范特西",
    coverUrl: "https://p1.music.126.net/cover.png",
    durationSeconds: 210,
    duration: "03:30",
    quality: "FLAC",
    availableQualities: [
      { level: "exhigh", label: "320K" },
      { level: "lossless", label: "无损" },
    ],
  };
}

function makeMinimalFlacPayload(): Uint8Array {
  // 4B "fLaC" + 4B last STREAMINFO header (0x80 | 0, len=34) + 34B STREAMINFO + 16B audio frame data
  const payload = new Uint8Array(4 + 4 + 34 + 16);
  payload.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34], 0);
  payload.set([0xff, 0xf8, 0x69, 0x18, 0x00, 0x00, 0x00, 0x01], 42);
  return payload;
}

function makeMinimalMp3Payload(): Uint8Array {
  // Two complete 417-byte MPEG1 Layer3 128kbps 44.1kHz frames
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
  const out = new Uint8Array(frame.length * 2);
  out.set(frame, 0);
  out.set(frame, frame.length);
  return out;
}

async function readFileViaHandle(filePath: string): Promise<Buffer> {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return buf;
  } finally {
    await handle.close();
  }
}

test("MediaService.enqueueDownload(tagged_server) streams FLAC and MP3 tag/cover injection without fsPromises.readFile", async () => {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "tv2-stream-tag-"));
  const sqlite = new SqliteClient(":memory:");
  sqlite.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at) VALUES (?, ?, 'hash', 'admin', 0, ?)",
    )
    .run(actor.userId, actor.username, Date.now());

  const vault = new AesGcmCredentialVault(crypto.randomBytes(32));
  const credentials = new CredentialRepository(sqlite, vault);
  credentials.saveBinding(actor.userId, {
    platform: "netease",
    cookie: "MUSIC_U=stream-tag-cookie",
    accountUid: "1001",
    displayName: "Streamer",
    avatarUrl: null,
    vipEnabled: true,
    vipExpireAt: null,
  });

  const userState = new UserStateRepository(sqlite);
  const jobRepo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: tmpDir,
    globalMaxConcurrentDownloads: 2,
    globalMaxConcurrentJobs: 2,
  });

  const flacBytes = makeMinimalFlacPayload();
  const mp3Bytes = makeMinimalMp3Payload();
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb, 0xcc]);

  let nextAudioFormat: "flac" | "mp3" = "flac";

  const providers = new ProviderRegistry();
  const mockAdapter: MusicProviderAdapter = {
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
    verifyCredential: async (cookie) => ({
      ok: true,
      accountUid: "1001",
      displayName: "Streamer",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
      normalizedCookie: cookie,
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
    getLyrics: async (songId) => ({
      songId,
      platform: "netease",
      lines: [{ time: 1, text: "流式注入歌词测试" }],
      source: "netease_new",
    }),
    resolveAudio: async (_target, level) => ({
      url: `https://m7.music.126.net/audio.${nextAudioFormat}`,
      format: nextAudioFormat,
      bitrate: nextAudioFormat === "flac" ? 960_000 : 320_000,
      level,
      durationSeconds: 210,
      trial: false,
      downgraded: false,
    }),
  };
  providers.register(mockAdapter);

  const httpClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async (url) => {
      const rawUrl = String(url);
      if (rawUrl.includes(".png")) {
        return new Response(Buffer.from(pngBytes), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(pngBytes.length) },
        });
      }
      if (rawUrl.endsWith(".flac")) {
        return new Response(Buffer.from(flacBytes), {
          status: 200,
          headers: { "content-type": "audio/flac", "content-length": String(flacBytes.length) },
        });
      }
      return new Response(Buffer.from(mp3Bytes), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": String(mp3Bytes.length) },
      });
    },
  });

  const media = new MediaService({
    providers,
    authResolver: new ProviderAuthResolver(credentials),
    userState,
    http: httpClient,
    jobs,
    maxCoverBytes: 1024 * 1024,
    maxAudioBytes: 50 * 1024 * 1024,
  });

  const waitJob = async (jobId: string) => {
    for (let i = 0; i < 80; i += 1) {
      const rec = jobRepo.findById(jobId);
      if (rec && (rec.status === "completed" || rec.status === "failed" || rec.status === "cancelled")) {
        return rec;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Job ${jobId} timed out`);
  };

  const readFileSpy = mock.method(fsPromises, "readFile");

  try {
    // 1. FLAC tagged_server download
    nextAudioFormat = "flac";
    const flacJob = media.enqueueDownload(actor, {
      song: makeSong("netease", "flac-1", "七里香"),
      level: "lossless",
      mode: "tagged_server",
    });
    const flacDone = await waitJob(flacJob.id);
    assert.equal(flacDone.status, "completed");

    // 2. MP3 tagged_server download
    nextAudioFormat = "mp3";
    const mp3Job = media.enqueueDownload(actor, {
      song: makeSong("netease", "mp3-1", "晴天"),
      level: "exhigh",
      mode: "tagged_server",
    });
    const mp3Done = await waitJob(mp3Job.id);
    assert.equal(mp3Done.status, "completed");

    // Verify streaming tag injection NEVER invoked fsPromises.readFile
    assert.equal(readFileSpy.mock.callCount(), 0);

    // Verify FLAC output contains Vorbis comment metadata, lyrics, cover block, and intact audio frames
    const flacArtifact = await readFileViaHandle(path.join(tmpDir, actor.userId, `${flacJob.id}.bin`));
    assert.equal(isFlacBytes(flacArtifact), true);
    assert.equal(flacArtifact.includes(Buffer.from("TITLE=七里香")), true);
    assert.equal(flacArtifact.includes(Buffer.from("LYRICS=[00:01.00]流式注入歌词测试")), true);
    assert.equal(flacArtifact.includes(Buffer.from("image/png")), true);
    assert.equal(flacArtifact.includes(Buffer.from(pngBytes)), true);
    assert.equal(flacArtifact.subarray(-16).equals(Buffer.from(flacBytes.subarray(42))), true);

    // Verify MP3 output contains ID3v2 header, cover APIC, lyrics, and intact MPEG audio frames
    const mp3Artifact = await readFileViaHandle(path.join(tmpDir, actor.userId, `${mp3Job.id}.bin`));
    assert.equal(isMp3Bytes(mp3Artifact), true);
    assert.equal(mp3Artifact.subarray(0, 3).toString("ascii"), "ID3");
    assert.equal(mp3Artifact.includes(Buffer.from("APIC")), true);
    assert.equal(mp3Artifact.includes(Buffer.from("USLT")), true);
    assert.equal(mp3Artifact.includes(Buffer.from("image/png")), true);
    assert.equal(mp3Artifact.includes(Buffer.from(pngBytes)), true);
    assert.equal(mp3Artifact.subarray(-mp3Bytes.length).equals(Buffer.from(mp3Bytes)), true);
  } finally {
    readFileSpy.mock.restore();
    jobs.stop();
    httpClient.close();
    sqlite.close();
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  }
});
