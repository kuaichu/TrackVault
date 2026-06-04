import fs from "node:fs/promises";
import path from "node:path";
import type { PlaylistTransferJob } from "./types.js";

const dataDir = path.resolve(process.cwd(), "data");
const jobsPath = path.join(dataDir, "playlist-transfer-jobs.json");

async function readJobs(): Promise<PlaylistTransferJob[]> {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    const raw = await fs.readFile(jobsPath, "utf8");
    const parsed = JSON.parse(raw) as PlaylistTransferJob[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeJobs(jobs: PlaylistTransferJob[]) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2), "utf8");
}

export async function savePlaylistTransferJob(job: PlaylistTransferJob) {
  const jobs = await readJobs();
  const existingIndex = jobs.findIndex((item) => item.id === job.id);
  const nextJobs =
    existingIndex >= 0
      ? jobs.map((item, index) => (index === existingIndex ? job : item))
      : [job, ...jobs];

  await writeJobs(nextJobs.slice(0, 50));
  return job;
}

export async function listPlaylistTransferJobs(ownerKey: string) {
  const jobs = await readJobs();
  return jobs.filter((job) => job.ownerKey === ownerKey);
}

export async function getPlaylistTransferJob(ownerKey: string, jobId: string) {
  const jobs = await readJobs();
  return jobs.find((job) => job.ownerKey === ownerKey && job.id === jobId) ?? null;
}
