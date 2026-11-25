import type { ErrorCode, JobKind, JobStatus } from "#shared";

export interface StoredJobSummaryRecord {
  id: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
  hasResult: boolean;
  revision: number;
  errorCode?: ErrorCode;
  errorMessage?: string;
  artifactFilename?: string;
  artifactExpired: boolean;
  directUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredJobRecord {
  id: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  title: string;
  subtitle?: string;
  metadata?: Record<string, unknown>;
  hasResult?: boolean;
  result?: unknown;
  revision?: number;
  errorCode?: ErrorCode;
  errorMessage?: string;
  artifactFilename?: string;
  artifactExpired?: boolean;
  directUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface JobRevisionState {
  serverRevision: number;
  clearedBeforeRevision: number;
}

export type JobUpdatePatch = Partial<
  Pick<
    StoredJobRecord,
    | "status"
    | "progress"
    | "subtitle"
    | "metadata"
    | "result"
    | "errorCode"
    | "errorMessage"
    | "artifactFilename"
    | "artifactExpired"
    | "directUrl"
  >
>;

export interface JobRepositoryPort {
  recoverInterruptedJobs(errorMessage?: string): Array<{ id: string; userId: string }>;
  listActiveCompletedDownloads(): StoredJobSummaryRecord[];
  listSummariesByUser(userId: string, kind?: JobKind): StoredJobSummaryRecord[];
  listSummariesWithRevision(
    userId: string,
    kind?: JobKind,
  ): { jobs: StoredJobSummaryRecord[]; serverRevision: number; clearedBeforeRevision: number };
  findRawOwned(userId: string, id: string): StoredJobRecord | null;
  findRawOwnedSummary(userId: string, id: string): StoredJobSummaryRecord | null;
  findRawSummaryById(id: string): StoredJobSummaryRecord | null;
  insert(record: StoredJobRecord): { evictedIds: string[]; revision: number };
  update(
    id: string,
    patch: JobUpdatePatch,
    options?: { expectedStatus?: JobStatus | readonly JobStatus[] },
  ): StoredJobRecord | null;
  mutateOwnedResult<TResult = unknown>(
    userId: string,
    jobId: string,
    mutator: (record: StoredJobRecord) => { result: TResult; subtitle?: string },
  ): StoredJobRecord | null;
  clearFinished(
    userId: string,
    kind?: JobKind,
  ): { removedIds: string[]; serverRevision: number; clearedBeforeRevision: number };
}
