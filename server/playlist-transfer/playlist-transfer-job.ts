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
  input: CreatePlaylistTransferInput;
  progress: PlaylistTransferRunProgress;
  result?: PlaylistTransferJob;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

const jobs = new Map<string, PlaylistTransferRunJob>();

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

async function runJob(job: PlaylistTransferRunJob, deps: CreatePlaylistTransferDeps) {
  try {
    const result = await createPlaylistTransferJob(job.input, {
      ...deps,
      onProgress: (progress) => {
        deps.onProgress?.(progress);
        updateJob(job, {
          status: statusForPhase(progress.phase),
          progress
        });
      }
    });

    updateJob(job, {
      status: "completed",
      result,
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
  const job: PlaylistTransferRunJob = {
    id: crypto.randomUUID(),
    status: "queued",
    input,
    progress: emptyProgress("queued"),
    createdAt,
    updatedAt: createdAt
  };

  jobs.set(job.id, job);
  setTimeout(() => {
    void runJob(job, deps);
  }, 0);
  return job;
}

export function getPlaylistTransferRunJob(id: string) {
  return jobs.get(id) ?? null;
}
