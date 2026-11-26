import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { injectMp3Metadata } from "#audio-tags";
import type { JobDetailView, MusicPlatform, Song, TransferTrack } from "#shared";
import { BackgroundJobManager } from "../application/jobs/background-job-manager.js";
import type { ActorContext } from "../domain/context.js";
import { type MusicProviderAdapter, ProviderRegistry } from "../domain/ports/music-provider.js";
import { SqliteClient } from "../infrastructure/db/client.js";
import { CredentialRepository } from "../infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "../infrastructure/db/repositories/job-repository.js";
import { UserStateRepository } from "../infrastructure/db/repositories/user-state-repository.js";
import { AesGcmCredentialVault } from "../infrastructure/security/credential-vault.js";
import { SafeHttpClient } from "../infrastructure/security/safe-http-client.js";

export interface TestSongOptions {
  artist?: string;
  locked?: boolean;
  album?: string;
  durationSeconds?: number;
  mediaId?: string;
  coverUrl?: string;
  quality?: string;
  availableQualities?: Song["availableQualities"];
  availability?: Song["availability"];
}

export function makeTestActor(overrides?: Partial<ActorContext>): ActorContext {
  return {
    userId: "user-test-1",
    username: "tester",
    role: "admin",
    trustedFallback: false,
    ...overrides,
  };
}

export function makeTestSong(
  platform: MusicPlatform,
  id: string,
  title: string,
  options?: TestSongOptions,
): Song {
  const artist = options?.artist ?? "Artist";
  const locked = options?.locked ?? false;
  const durationSeconds = options?.durationSeconds ?? 180;
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  return {
    id,
    ...(options?.mediaId !== undefined ? { mediaId: options.mediaId } : {}),
    platform,
    title,
    artist,
    artists: [{ name: artist }],
    album: options?.album ?? "Album",
    ...(options?.coverUrl !== undefined ? { coverUrl: options.coverUrl } : {}),
    durationSeconds,
    duration: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    quality: options?.quality ?? "320K",
    availableQualities: options?.availableQualities ?? [
      { level: "standard", label: "128K" },
      { level: "exhigh", label: "320K" },
    ],
    availability: options?.availability ?? {
      playback: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
      download: { status: locked ? "vip" : "available", locked, label: locked ? "VIP" : "", reason: "" },
    },
  };
}

export function makeTransferTrack(
  id: string,
  title: string,
  artists: string[] = ["Artist"],
  options?: {
    source?: TransferTrack["source"];
    album?: string;
    durationSeconds?: number;
  },
): TransferTrack {
  return {
    source: options?.source ?? "netease",
    sourceTrackId: id,
    title,
    artists,
    ...(options?.album !== undefined ? { album: options.album } : {}),
    ...(options?.durationSeconds !== undefined ? { durationSeconds: options.durationSeconds } : {}),
  };
}

export function makeMinimalMp3Bytes(frameCount = 1): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  if (frameCount <= 1) return frame;
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

export function makeMinimalFlacBytes(): Buffer {
  const flac = Buffer.alloc(42);
  flac.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 34]);
  return flac;
}

export function makeMinimalPngBytes(width = 1, height = 1): Buffer {
  const pngChunk = (type: string, bytes: Buffer): Buffer => {
    const payload = Buffer.concat([Buffer.from(type), bytes]);
    const lenBuf = Buffer.alloc(4);
    const crcBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(bytes.length);
    crcBuf.writeUInt32BE(crc32(payload));
    return Buffer.concat([lenBuf, payload, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc((1 + width * 3) * height), { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function makeLargeCoverMp3Bytes(): Uint8Array {
  const plainMp3 = makeMinimalMp3Bytes(8);
  const png = makeMinimalPngBytes(64, 64);
  return injectMp3Metadata(
    plainMp3,
    { title: "BigCover", artist: "Artist", album: "Album", source: "netease" },
    "",
    { mimeType: "image/png", bytes: png },
  );
}

export function makeId3v2FakeAudioBytes(declaredPayloadBytes: number, trailingText: string): Buffer {
  const body = Buffer.alloc(declaredPayloadBytes, 0x20);
  const header = Buffer.from([
    0x49,
    0x44,
    0x33,
    0x03,
    0x00,
    0x00,
    (declaredPayloadBytes >>> 21) & 0x7f,
    (declaredPayloadBytes >>> 14) & 0x7f,
    (declaredPayloadBytes >>> 7) & 0x7f,
    declaredPayloadBytes & 0x7f,
  ]);
  return Buffer.concat([header, body, Buffer.from(trailingText)]);
}

export function makeMinimalAacAdtsBytes(frameLength = 64): Buffer {
  const buf = Buffer.alloc(frameLength);
  buf[0] = 0xff;
  buf[1] = 0xf1;
  buf[2] = 0x50;
  buf[3] = 0x80 | ((frameLength >>> 11) & 0x03);
  buf[4] = (frameLength >>> 3) & 0xff;
  buf[5] = ((frameLength & 0x07) << 5) | 0x1f;
  buf[6] = 0xfc;
  return buf;
}

function makeRiffChunk(type: string, body: Buffer): Buffer {
  const hdr = Buffer.alloc(8);
  hdr.write(type, 0, "ascii");
  hdr.writeUInt32LE(body.length, 4);
  return Buffer.concat([hdr, body]);
}

function makeWavFmtBody(): Buffer {
  const wavFmt = Buffer.alloc(16);
  wavFmt.writeUInt16LE(1, 0);
  wavFmt.writeUInt16LE(1, 2);
  wavFmt.writeUInt32LE(8000, 4);
  wavFmt.writeUInt32LE(16000, 8);
  wavFmt.writeUInt16LE(2, 12);
  wavFmt.writeUInt16LE(16, 14);
  return wavFmt;
}

export function makeMinimalWavBytes(options?: { junkBytes?: number; dataBytes?: number }): Buffer {
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    makeRiffChunk("JUNK", Buffer.alloc(options?.junkBytes ?? 128)),
    makeRiffChunk("fmt ", makeWavFmtBody()),
    makeRiffChunk("data", Buffer.alloc(options?.dataBytes ?? 32)),
  ]);
  return makeRiffChunk("RIFF", body);
}

export function makeMinimalRf64WavBytes(pcmBytes = 32): Buffer {
  const header = Buffer.alloc(12);
  header.write("RF64", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVE", 8, "ascii");
  const ds64 = Buffer.alloc(36);
  ds64.write("ds64", 0, "ascii");
  ds64.writeUInt32LE(28, 4);
  const fmtChunk = makeRiffChunk("fmt ", makeWavFmtBody());
  const dataHdr = Buffer.alloc(8);
  dataHdr.write("data", 0, "ascii");
  dataHdr.writeUInt32LE(0xffffffff, 4);
  const pcm = Buffer.alloc(pcmBytes);
  const fullLen = header.length + ds64.length + fmtChunk.length + dataHdr.length + pcm.length;
  ds64.writeBigUInt64LE(BigInt(fullLen - 8), 8);
  ds64.writeBigUInt64LE(BigInt(pcm.length), 16);
  ds64.writeBigUInt64LE(16n, 24);
  return Buffer.concat([header, ds64, fmtChunk, dataHdr, pcm]);
}

export function makeMinimalOggBytes(): Buffer {
  const ogg = Buffer.alloc(28);
  ogg.set([0x4f, 0x67, 0x67, 0x53]);
  ogg[26] = 1;
  return ogg;
}

export function makeMinimalM4aBytes(): Buffer {
  const m4a = Buffer.alloc(32);
  m4a.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return m4a;
}

export function createStubProviderAdapter(
  platform: MusicPlatform,
  overrides?: Partial<MusicProviderAdapter>,
): MusicProviderAdapter {
  const base: MusicProviderAdapter = {
    platform,
    capabilities: {
      platform,
      canLikeSong: platform === "netease",
      canManagePlaylistTracks: platform === "netease" || platform === "kugou",
      canCreatePlaylist: platform === "netease" || platform === "kugou",
      canLoadCloudDisk: platform === "netease",
      canReadComments: true,
      canLikeComments: platform !== "kugou",
      canQrLogin: true,
      shareUrlTemplate:
        platform === "netease"
          ? "https://music.163.com/#/song?id={id}"
          : platform === "qq"
            ? "https://y.qq.com/n/ryqq/songDetail/{id}"
            : "https://www.kugou.com/song/#hash={id}",
    },
    verifyCredential: async () => ({
      ok: true,
      accountUid: "1",
      displayName: "Test User",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
      message: "ok",
    }),
    searchTracks: async () => [],
    getDiscoverTracks: async () => [],
    getUserPlaylists: async () => [],
    getPlaylistTracks: async (playlistId) => ({
      playlist: {
        id: playlistId,
        platform,
        name: "Playlist",
        trackCount: 0,
        creatorName: "Test User",
        owned: true,
      },
      songs: [],
      total: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    }),
    getAllPlaylistTracks: async () => [],
    getLyrics: async (songId) => ({ songId, platform, lines: [], source: "none" }),
    resolveAudio: async () => ({
      url: "https://m7.music.126.net/default.mp3",
      format: "mp3",
      bitrate: 320_000,
      level: "exhigh",
      durationSeconds: 180,
      trial: false,
      downgraded: false,
    }),
  };

  return {
    ...base,
    ...overrides,
    platform,
    capabilities: overrides?.capabilities ?? base.capabilities,
  };
}

export function createMockSafeHttp(
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): SafeHttpClient {
  return new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl,
  });
}

export function insertTestUser(sqlite: SqliteClient, actor: ActorContext): void {
  sqlite.db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
       VALUES (?, ?, 'hash', ?, ?, ?)`,
    )
    .run(actor.userId, actor.username, actor.role, actor.trustedFallback ? 1 : 0, Date.now());
}

export interface ServerTestHarness {
  readonly actor: ActorContext;
  readonly tmpDir: string;
  readonly tmpDownloadsDir: string;
  readonly sqlite: SqliteClient;
  readonly jobRepo: JobRepository;
  readonly jobs: BackgroundJobManager;
  readonly credentials: CredentialRepository;
  readonly userState: UserStateRepository;
  readonly providers: ProviderRegistry;
  cleanup(): Promise<void>;
}

export async function createServerTestHarness(options?: {
  actor?: ActorContext;
  prefix?: string;
  inMemoryDb?: boolean;
  seedBindings?: boolean;
  globalMaxConcurrentDownloads?: number;
  globalMaxConcurrentJobs?: number;
}): Promise<ServerTestHarness> {
  const actor = options?.actor ?? makeTestActor();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), options?.prefix ?? "tv2-test-"));
  const tmpDownloadsDir = path.join(tmpDir, "downloads");
  const sqlite = new SqliteClient(options?.inMemoryDb ? ":memory:" : path.join(tmpDir, "test.db"));
  insertTestUser(sqlite, actor);

  const jobRepo = new JobRepository(sqlite);
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir,
    globalMaxConcurrentDownloads: options?.globalMaxConcurrentDownloads ?? 2,
    globalMaxConcurrentJobs: options?.globalMaxConcurrentJobs ?? 2,
  });
  const vault = new AesGcmCredentialVault(Buffer.alloc(32, 7));
  const credentials = new CredentialRepository(sqlite, vault);

  if (options?.seedBindings !== false) {
    credentials.saveBinding(actor.userId, {
      platform: "netease",
      cookie: "MUSIC_U=test-cookie",
      accountUid: "1001",
      displayName: "Test Netease",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
    });
    credentials.saveBinding(actor.userId, {
      platform: "qq",
      cookie: "uin=1001; qm_keyst=test-key",
      accountUid: "1001",
      displayName: "Test QQ",
      avatarUrl: null,
      vipEnabled: true,
      vipExpireAt: null,
    });
  }

  const userState = new UserStateRepository(sqlite);
  const providers = new ProviderRegistry();

  return {
    actor,
    tmpDir,
    tmpDownloadsDir,
    sqlite,
    jobRepo,
    jobs,
    credentials,
    userState,
    providers,
    cleanup: async () => {
      jobs.stop();
      sqlite.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

export async function waitForJobTerminal(
  jobs: BackgroundJobManager,
  actor: ActorContext,
  jobId: string,
  timeoutMs = 5000,
): Promise<JobDetailView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = jobs.getOwnedJobView(actor, jobId);
    if (view.status === "completed" || view.status === "failed" || view.status === "cancelled") {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}
