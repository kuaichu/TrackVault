import assert from "node:assert/strict";
import test from "node:test";
import { cancelNeteaseImportAuditJob, formatNeteaseImportAuditJobExport, getNeteaseImportAuditJob, startNeteaseImportAuditJob } from "./netease-import-audit-job.js";
import { assertPublicDtoSafe } from "./assert-public-dto-safe.js";
import type { PublicNeteaseImportAuditJob } from "./netease-import-audit-public-dto.js";

type IsExact<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type AssertTrue<Value extends true> = Value;
type StartReturnsPublicAuditJob = AssertTrue<IsExact<
  ReturnType<typeof startNeteaseImportAuditJob>,
  PublicNeteaseImportAuditJob
>>;
type GetReturnsPublicAuditJob = AssertTrue<IsExact<
  ReturnType<typeof getNeteaseImportAuditJob>,
  PublicNeteaseImportAuditJob | null
>>;
type CancelReturnsPublicAuditJob = AssertTrue<IsExact<
  ReturnType<typeof cancelNeteaseImportAuditJob>,
  PublicNeteaseImportAuditJob | null
>>;

const publicAccessorTypesCompile: [StartReturnsPublicAuditJob, GetReturnsPublicAuditJob, CancelReturnsPublicAuditJob] = [
  true,
  true,
  true
];

const unavailableTrack = {
  id: "song-1",
  name: "缺音源",
  ar: [{ name: "原歌手" }],
  noCopyrightRcmd: {
    typeDesc: "其它版本可播"
  }
};

async function waitForJob(ownerKey: string, id: string, status: "completed" | "cancelled" | "failed") {
  for (let index = 0; index < 20; index += 1) {
    const job = getNeteaseImportAuditJob(ownerKey, id);
    if (job?.status === status) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`job did not reach ${status}`);
}

test("startNeteaseImportAuditJob runs in background and stores completed result", async () => {
  assert.deepEqual(publicAccessorTypesCompile, [true, true, true]);
  const job = startNeteaseImportAuditJob(
    "owner-a",
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      maxTracks: 10,
      candidateLimit: 3,
      checkAvailability: false
    },
    {
      loadEntries: async () => [
        {
          track: unavailableTrack,
          privilege: {
            id: "song-1",
            st: -200,
            pl: 0,
            dl: 0
          }
        }
      ],
      searchCandidates: async () => [
        {
          provider: "netease",
          id: "replacement",
          title: "缺音源",
          artists: ["替代歌手"]
        }
      ]
    }
  );

  assert.equal(job.status, "queued");
  const completed = await waitForJob("owner-a", job.id, "completed");

  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.scanned, 1);
  assert.equal(completed.result?.summary.replaceable, 1);
});

test("cancelNeteaseImportAuditJob marks running jobs for cancellation", async () => {
  const job = startNeteaseImportAuditJob(
    "owner-a",
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      maxTracks: 10,
      candidateLimit: 3,
      checkAvailability: false
    },
    {
      loadEntries: async () => [
        {
          track: unavailableTrack,
          privilege: {
            id: "song-1",
            st: -200,
            pl: 0,
            dl: 0
          }
        }
      ],
      searchCandidates: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [];
      }
    }
  );

  const cancelling = cancelNeteaseImportAuditJob("owner-a", job.id);
  assert.equal(cancelling?.status, "cancelling");

  const cancelled = await waitForJob("owner-a", job.id, "cancelled");
  assert.equal(cancelled.status, "cancelled");
});

test("jobs keep their creation owner private and reject cross-owner reads and cancellation", async () => {
  let signalLoadStarted: (() => void) | undefined;
  let releaseLoad: (() => void) | undefined;
  const loadStarted = new Promise<void>((resolve) => {
    signalLoadStarted = resolve;
  });
  const loadReleased = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  let currentOwner = "owner-a";

  const job = startNeteaseImportAuditJob(
    currentOwner,
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      maxTracks: 10,
      candidateLimit: 3,
      checkAvailability: false
    },
    {
      loadEntries: async () => {
        signalLoadStarted?.();
        await loadReleased;
        return [];
      },
      searchCandidates: async () => []
    }
  );

  assert.equal(Object.prototype.hasOwnProperty.call(job, "ownerKey"), false);
  await loadStarted;
  currentOwner = "owner-b";

  assert.equal(getNeteaseImportAuditJob(currentOwner, job.id), null);
  assert.equal(cancelNeteaseImportAuditJob(currentOwner, job.id), null);
  assert.equal(getNeteaseImportAuditJob("owner-a", job.id)?.status, "loading");

  releaseLoad?.();
  const completed = await waitForJob("owner-a", job.id, "completed");
  assert.equal(completed.status, "completed");
  assert.equal(Object.prototype.hasOwnProperty.call(completed, "ownerKey"), false);
});

test("legacy ownerless jobs fail closed", () => {
  const job = startNeteaseImportAuditJob(
    "",
    {
      playlistId: "legacy",
      playlistName: "旧任务",
      maxTracks: 1,
      candidateLimit: 1,
      checkAvailability: false
    },
    {
      loadEntries: async () => [],
      searchCandidates: async () => []
    }
  );

  assert.equal(getNeteaseImportAuditJob("owner-a", job.id), null);
  assert.equal(getNeteaseImportAuditJob("", job.id), null);
  assert.equal(cancelNeteaseImportAuditJob("owner-a", job.id), null);
  assert.equal(cancelNeteaseImportAuditJob("", job.id), null);
});

test("formatNeteaseImportAuditJobExport includes normal playable text playlist", () => {
  const exported = formatNeteaseImportAuditJobExport(
    {
      playlistId: "liked",
      playlistName: "我喜欢的音乐",
      scannedCount: 2,
      summary: {
        total: 2,
        playable: 1,
        suspect: 1,
        replaceable: 1,
        needsReview: 0,
        unusable: 0
      },
      playableTrackIds: ["1001"],
      playableTextPlaylist: "正常歌曲 - 正常歌手",
      items: [],
      textPlaylist: "替代歌曲 - 替代歌手",
      unusableText: "",
      markdownReport: ""
    },
    "text"
  );

  assert.match(exported.content, /# 正常可播文字歌单/);
  assert.match(exported.content, /正常歌曲 - 正常歌手/);
  assert.match(exported.content, /替代歌曲 - 替代歌手/);
});

test("audit jobs keep candidate raw internally while all returned and exported DTOs stay detached", async () => {
  const secret = "audit-job-secret-sentinel";
  let availabilityRaw: unknown;
  const started = startNeteaseImportAuditJob(
    "owner-private",
    {
      playlistId: "liked-private",
      playlistName: "私有审计",
      maxTracks: 1,
      candidateLimit: 1,
      checkAvailability: true
    },
    {
      loadEntries: async () => [{
        track: unavailableTrack,
        privilege: { id: "song-1", st: -200, pl: 0, dl: 0 }
      }],
      searchCandidates: async () => [{
        provider: "netease",
        id: "replacement-private",
        title: "缺音源",
        artists: ["原歌手"],
        raw: {
          cookie: secret,
          nested: { SID: secret, credentialFingerprint: secret }
        }
      }],
      checkCandidateAvailability: async (candidate) => {
        availabilityRaw = candidate.raw;
        return null;
      }
    }
  );

  assertPublicDtoSafe(started, secret);
  const completed = await waitForJob("owner-private", started.id, "completed");
  assert.equal(started.status, "queued", "a returned start DTO must not be mutated by job completion");
  assert.deepEqual(availabilityRaw, {
    cookie: secret,
    nested: { SID: secret, credentialFingerprint: secret }
  });
  assertPublicDtoSafe(completed, secret);

  const cancelledAfterCompletion = cancelNeteaseImportAuditJob("owner-private", started.id);
  assert.ok(cancelledAfterCompletion);
  assertPublicDtoSafe(cancelledAfterCompletion, secret);
  const exported = formatNeteaseImportAuditJobExport(completed.result!, "json");
  assert.equal(exported.contentType, "application/json; charset=utf-8");
  assertPublicDtoSafe(JSON.parse(exported.content) as unknown, secret);

  completed.result?.items[0]?.candidates[0]?.artists.push("公共突变");
  const reread = getNeteaseImportAuditJob("owner-private", started.id);
  assert.deepEqual(reread?.result?.items[0]?.candidates[0]?.artists, ["原歌手"]);
});

test("failed audit jobs never expose Error message, cause, stack, or non-Error values", async () => {
  const secret = "audit-job-error-secret-sentinel";
  for (const failure of [Object.assign(new Error(secret), { cause: { cookie: secret } }), secret]) {
    const started = startNeteaseImportAuditJob(
      "owner-failure",
      {
        playlistId: "liked-failure",
        playlistName: "失败审计",
        maxTracks: 1,
        candidateLimit: 1,
        checkAvailability: true
      },
      {
        loadEntries: async () => {
          throw failure;
        },
        searchCandidates: async () => []
      }
    );

    assertPublicDtoSafe(started, secret);
    const failed = await waitForJob("owner-failure", started.id, "failed");
    assert.equal(failed.error, "网易云导入歌单清理失败");
    assertPublicDtoSafe(failed, secret);
    assert.equal("stack" in failed, false);
    assert.equal("cause" in failed, false);

    const cancelled = cancelNeteaseImportAuditJob("owner-failure", started.id);
    assert.ok(cancelled);
    assert.equal(cancelled.error, "网易云导入歌单清理失败");
    assertPublicDtoSafe(cancelled, secret);
  }
});
