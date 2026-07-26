import crypto from "node:crypto";
import {
  createPlaylistTransferJob,
  type CreatePlaylistTransferDeps,
  type CreatePlaylistTransferInput,
  type PlaylistTransferProgress,
  type PlaylistTransferProgressPhase
} from "./service.js";
import type { PlaylistTransferJob } from "./types.js";

export type PlaylistTransferRunJobStatus = "queued" | "loading" | "running" | "saving" | "completed" | "failed";

type PlaylistTransferRunProgressPhase = "queued" | PlaylistTransferProgressPhase | "failed";

export type PlaylistTransferRunProgress = Omit<PlaylistTransferProgress, "phase"> & {
  phase: PlaylistTransferRunProgressPhase;
};

export type PlaylistTransferRunJob = {
  id: string;
  status: PlaylistTransferRunJobStatus;
  input: Omit<CreatePlaylistTransferInput, "ownerKey">;
  progress: PlaylistTransferRunProgress;
  result?: Omit<PlaylistTransferJob, "ownerKey">;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredPlaylistTransferRunJob = {
  readonly ownerKey: string;
  job: PlaylistTransferRunJob;
};

const jobs = new Map<string, StoredPlaylistTransferRunJob>();

function nowIso() {
  return new Date().toISOString();
}

function emptyProgress(phase: PlaylistTransferRunProgressPhase): PlaylistTransferRunProgress {
  return {
    phase,
    processed: 0,
    total: 0,
    matched: 0,
    manualReview: 0,
    notFound: 0,
    unavailable: 0,
    duplicate: 0,
    skipped: 0
  };
}

function statusForPhase(phase: PlaylistTransferProgressPhase): PlaylistTransferRunJobStatus {
  if (phase === "loading") {
    return "loading";
  }

  if (phase === "saving") {
    return "saving";
  }

  if (phase === "completed") {
    return "completed";
  }

  return "running";
}

function updateJob(job: PlaylistTransferRunJob, patch: Partial<PlaylistTransferRunJob>) {
  Object.assign(job, patch, {
    updatedAt: nowIso()
  });
}

async function runJob(storedJob: StoredPlaylistTransferRunJob, deps: CreatePlaylistTransferDeps) {
  const { job, ownerKey } = storedJob;
  try {
    const result = await createPlaylistTransferJob({
      ...job.input,
      ownerKey
    }, {
      ...deps,
      onProgress: (progress) => {
        deps.onProgress?.(progress);
        updateJob(job, {
          status: statusForPhase(progress.phase),
          progress
        });
      }
    });

    const { ownerKey: _resultOwnerKey, ...publicResult } = result;
    updateJob(job, {
      status: "completed",
      result: publicResult,
      progress: {
        ...job.progress,
        phase: "completed",
        processed: result.summary.total,
        total: result.summary.total
      }
    });
  } catch (error) {
    updateJob(job, {
      status: "failed",
      error: error instanceof Error ? error.message : "歌单互转失败",
      progress: {
        ...job.progress,
        phase: "failed"
      }
    });
  }
}

export function startPlaylistTransferRunJob(input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) {
  const createdAt = nowIso();
  const { ownerKey, ...publicInput } = input;
  const job: PlaylistTransferRunJob = {
    id: crypto.randomUUID(),
    status: "queued",
    input: publicInput,
    progress: emptyProgress("queued"),
    createdAt,
    updatedAt: createdAt
  };

  const storedJob: StoredPlaylistTransferRunJob = {
    ownerKey,
    job
  };
  jobs.set(job.id, storedJob);
  setTimeout(() => {
    void runJob(storedJob, deps);
  }, 0);
  return job;
}

export function getPlaylistTransferRunJob(ownerKey: string, id: string) {
  const storedJob = jobs.get(id);
  if (!storedJob?.ownerKey || storedJob.ownerKey !== ownerKey) {
    return null;
  }

  return storedJob.job;
}
