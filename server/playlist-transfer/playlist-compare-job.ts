import crypto from "node:crypto";
import {
  comparePlaylists,
  type PlaylistCompareProgress,
  type PlaylistCompareRequest,
  type PlaylistCompareResult
} from "./playlist-compare.js";
import type { TransferTrack } from "./types.js";

export type PlaylistCompareJobStatus = "queued" | "loading" | "running" | "completed" | "failed";

type PlaylistCompareJobProgressPhase = "queued" | "loading" | PlaylistCompareProgress["phase"] | "failed";

export type PlaylistCompareJobProgress = Omit<PlaylistCompareProgress, "phase"> & {
  phase: PlaylistCompareJobProgressPhase;
};

export type PlaylistCompareJob = {
  id: string;
  status: PlaylistCompareJobStatus;
  input: PlaylistCompareRequest;
  progress: PlaylistCompareJobProgress;
  result?: PlaylistCompareResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type PlaylistCompareJobDeps = {
  loadSideTracks: (provider: string, playlistId: string) => Promise<TransferTrack[]>;
};

const jobs = new Map<string, PlaylistCompareJob>();

function nowIso() {
  return new Date().toISOString();
}

function emptyProgress(phase: PlaylistCompareJobProgressPhase): PlaylistCompareJobProgress {
  return {
    phase,
    processed: 0,
    total: 0,
    exact: 0,
    sameTitleDifferentArtist: 0,
    similarTitle: 0,
    leftOnly: 0,
    rightOnly: 0
  };
}

function updateJob(job: PlaylistCompareJob, patch: Partial<PlaylistCompareJob>) {
  Object.assign(job, patch, {
    updatedAt: nowIso()
  });
}

async function runJob(job: PlaylistCompareJob, deps: PlaylistCompareJobDeps) {
  try {
    updateJob(job, {
      status: "loading",
      progress: emptyProgress("loading")
    });

    const [leftTracks, rightTracks] = await Promise.all([
      deps.loadSideTracks(job.input.leftProvider, job.input.leftPlaylistId ?? ""),
      deps.loadSideTracks(job.input.rightProvider, job.input.rightPlaylistId ?? "")
    ]);

    const result = comparePlaylists(
      {
        left: {
          provider: job.input.leftProvider,
          playlistId: job.input.leftPlaylistId,
          playlistName: job.input.leftPlaylistName?.trim() || `左侧歌单 ${job.input.leftPlaylistId ?? ""}`,
          tracks: leftTracks
        },
        right: {
          provider: job.input.rightProvider,
          playlistId: job.input.rightPlaylistId,
          playlistName: job.input.rightPlaylistName?.trim() || `右侧歌单 ${job.input.rightPlaylistId ?? ""}`,
          tracks: rightTracks
        }
      },
      {
        onProgress: (progress) => {
          updateJob(job, {
            status: progress.phase === "completed" ? "completed" : "running",
            progress
          });
        }
      }
    );

    updateJob(job, {
      status: "completed",
      result,
      progress: {
        ...job.progress,
        phase: "completed",
        processed: leftTracks.length,
        total: leftTracks.length
      }
    });
  } catch (error) {
    updateJob(job, {
      status: "failed",
      error: error instanceof Error ? error.message : "歌单对比失败",
      progress: {
        ...job.progress,
        phase: "failed"
      }
    });
  }
}

export function startPlaylistCompareJob(input: PlaylistCompareRequest, deps: PlaylistCompareJobDeps) {
  const createdAt = nowIso();
  const job: PlaylistCompareJob = {
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

export function getPlaylistCompareJob(id: string) {
  return jobs.get(id) ?? null;
}
