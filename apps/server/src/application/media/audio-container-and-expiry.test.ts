import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { JobRepository } from "../../infrastructure/db/repositories/job-repository.js";
import {
  createMockSafeHttp,
  createServerTestHarness,
  createStubProviderAdapter,
  insertTestUser,
  makeId3v2FakeAudioBytes,
  makeLargeCoverMp3Bytes,
  makeMinimalAacAdtsBytes,
  makeMinimalFlacBytes,
  makeMinimalM4aBytes,
  makeMinimalMp3Bytes,
  makeMinimalOggBytes,
  makeMinimalRf64WavBytes,
  makeMinimalWavBytes,
  makeTestActor,
  makeTestSong,
  waitForJobTerminal,
} from "../../test-utils/fixtures.js";
import { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { MediaService, verifyDownloadedAudioFile } from "./media-service.js";

async function withTempAudioDir(
  fn: (writeCheck: (name: string, bytes: Uint8Array) => Promise<boolean>, dir: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-audio-verify-"));
  const writeCheck = async (name: string, bytes: Uint8Array): Promise<boolean> => {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, bytes);
    return verifyDownloadedAudioFile(filePath);
  };
  try {
    await fn(writeCheck, tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test("verifyDownloadedAudioFile skips >4KB ID3v2 cover headers and rejects audio-less ID3v2 payloads", async () => {
  await withTempAudioDir(async (writeCheck) => {
    const bigCoverMp3 = makeLargeCoverMp3Bytes();
    assert.ok(bigCoverMp3.byteLength > 12_000);
    assert.equal(await writeCheck("valid-big-cover.mp3", bigCoverMp3), true);

    const fakeMp3 = makeId3v2FakeAudioBytes(5000, "Upstream error text");
    assert.equal(await writeCheck("fake-after-id3.mp3", fakeMp3), false);
  });
});

test("verifyDownloadedAudioFile validates complete MP3 and AAC ADTS frames and rejects truncated ones", async () => {
  await withTempAudioDir(async (writeCheck) => {
    const fullMp3Frame = makeMinimalMp3Bytes(1);
    assert.equal(await writeCheck("full.mp3", fullMp3Frame), true);
    assert.equal(await writeCheck("trunc-100.mp3", fullMp3Frame.subarray(0, 100)), false);
    assert.equal(await writeCheck("trunc-416.mp3", fullMp3Frame.subarray(0, 416)), false);

    const fullAac = makeMinimalAacAdtsBytes(64);
    assert.equal(await writeCheck("full.aac", fullAac), true);
    assert.equal(await writeCheck("trunc.aac", fullAac.subarray(0, 30)), false);
  });
});

test("verifyDownloadedAudioFile validates FLAC, OGG, and M4A container headers and rejects truncated files", async () => {
  await withTempAudioDir(async (writeCheck) => {
    const fullFlac = makeMinimalFlacBytes();
    assert.equal(await writeCheck("full.flac", fullFlac), true);
    assert.equal(await writeCheck("trunc.flac", fullFlac.subarray(0, 20)), false);

    const fullOgg = makeMinimalOggBytes();
    assert.equal(await writeCheck("full.ogg", fullOgg), true);
    assert.equal(await writeCheck("trunc.ogg", fullOgg.subarray(0, 12)), false);

    const fullM4a = makeMinimalM4aBytes();
    assert.equal(await writeCheck("full.m4a", fullM4a), true);
    assert.equal(await writeCheck("trunc.m4a", fullM4a.subarray(0, 12)), false);
  });
});

test("verifyDownloadedAudioFile validates RIFF WAV and RF64 ds64 chunk sizes and rejects truncated chunks", async () => {
  await withTempAudioDir(async (writeCheck) => {
    const fullWav = makeMinimalWavBytes({ junkBytes: 128, dataBytes: 32 });
    assert.equal(await writeCheck("full.wav", fullWav), true);
    assert.equal(await writeCheck("trunc-60.wav", fullWav.subarray(0, 60)), false);
    assert.equal(await writeCheck("trunc-mid-data.wav", fullWav.subarray(0, fullWav.length - 4)), false);
    assert.equal(await writeCheck("trunc.wav", fullWav.subarray(0, 16)), false);

    const fullRf64 = makeMinimalRf64WavBytes(32);
    assert.equal(await writeCheck("full.rf64.wav", fullRf64), true);
    assert.equal(await writeCheck("trunc.rf64.wav", fullRf64.subarray(0, fullRf64.length - 16)), false);
  });
});

test("BackgroundJobManager marks missing download temp files expired on startup and on read", async () => {
  const actor = makeTestActor({ userId: "user-expiry", username: "expiry" });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-expiry-"));
  const sqlite = new SqliteClient(":memory:");
  insertTestUser(sqlite, actor);
  const repo = new JobRepository(sqlite);
  const bigCoverMp3 = makeLargeCoverMp3Bytes();

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
    const staleView = jobs
      .listForActorWithRevision(actor, "download")
      .jobs.find((j) => j.id === "stale-missing-bin");
    assert.ok(staleView);
    assert.equal(staleView.downloadReady, false);
    assert.equal(staleView.artifactExpired, true);

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
    assert.equal(jobs.getOwnedJobView(actor, "live-del-1").downloadReady, true);

    await fs.unlink(livePath);
    const afterUnlink = jobs.getOwnedJobView(actor, "live-del-1");
    assert.equal(afterUnlink.downloadReady, false);
    assert.equal(afterUnlink.artifactExpired, true);
  } finally {
    jobs.stop();
    sqlite.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("MediaService tagged_server download accepts >12KB cover MP3 and preserves Netease vivid 384K label", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-media-vivid-" });
  const bigCoverMp3 = makeLargeCoverMp3Bytes();
  harness.providers.register(
    createStubProviderAdapter("netease", {
      resolveAudio: async () => ({
        url: "https://m7.music.126.net/vivid384.mp3",
        format: "mp3",
        bitrate: 384_000,
        level: "vivid",
        durationSeconds: 180,
        trial: false,
        downgraded: false,
      }),
    }),
  );
  const http = createMockSafeHttp(
    async () =>
      new Response(Buffer.from(bigCoverMp3), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      }),
  );

  try {
    const media = new MediaService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      userState: harness.userState,
      http,
      jobs: harness.jobs,
      maxCoverBytes: 100_000,
      maxAudioBytes: 2_000_000,
    });
    const enqueued = media.enqueueDownload(harness.actor, {
      song: makeTestSong("netease", "v1", "Vivid Song"),
      level: "exhigh",
      mode: "tagged_server",
    });
    const completed = await waitForJobTerminal(harness.jobs, harness.actor, enqueued.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.subtitle?.includes("臻音 384K"), `unexpected subtitle: ${completed.subtitle}`);
    assert.equal(completed.subtitle?.includes("320K"), false);
  } finally {
    http.close();
    await harness.cleanup();
  }
});

test("MediaService direct_link subtitle reflects resolved WAV and AAC formats instead of FLAC", async () => {
  const harness = await createServerTestHarness({ prefix: "tv2-media-direct-" });
  harness.providers.register(
    createStubProviderAdapter("netease", {
      resolveAudio: async (target) =>
        target.id === "wav"
          ? {
              url: "https://m7.music.126.net/a.wav",
              format: "wav",
              bitrate: 128_000,
              level: "lossless",
              durationSeconds: 10,
              trial: false,
              downgraded: false,
            }
          : {
              url: "https://m7.music.126.net/a.aac",
              format: "aac",
              bitrate: null,
              level: "lossless",
              durationSeconds: 10,
              trial: false,
              downgraded: true,
            },
    }),
  );
  const http = createMockSafeHttp(async () => new Response("unused", { status: 200 }));

  try {
    const media = new MediaService({
      providers: harness.providers,
      authResolver: new ProviderAuthResolver(harness.credentials),
      userState: harness.userState,
      http,
      jobs: harness.jobs,
      maxCoverBytes: 100_000,
      maxAudioBytes: 1_000_000,
    });
    const wavJob = media.enqueueDownload(harness.actor, {
      song: makeTestSong("netease", "wav", "Demo"),
      level: "lossless",
      mode: "direct_link",
    });
    const aacJob = media.enqueueDownload(harness.actor, {
      song: makeTestSong("netease", "aac", "Demo"),
      level: "lossless",
      mode: "direct_link",
    });

    const wavDone = await waitForJobTerminal(harness.jobs, harness.actor, wavJob.id);
    const aacDone = await waitForJobTerminal(harness.jobs, harness.actor, aacJob.id);
    assert.equal(wavDone.subtitle, "WAV 直链已就绪");
    assert.equal(aacDone.subtitle, "AAC 直链已就绪");
  } finally {
    http.close();
    await harness.cleanup();
  }
});
