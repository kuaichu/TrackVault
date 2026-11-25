import type { ErrorCode, JobKind, JobStatus } from "#shared";
import {
  hasLocalDownloadArtifactExpectation,
  toJobSummaryView,
  toJobView,
} from "../../../application/jobs/job-view-mapper.js";
import type {
  JobRepositoryPort,
  JobRevisionState,
  JobUpdatePatch,
  StoredJobRecord,
  StoredJobSummaryRecord,
} from "../../../domain/ports/job-repository.js";
import type { SqliteClient } from "../client.js";

export type { JobRevisionState, JobUpdatePatch, StoredJobRecord, StoredJobSummaryRecord };
export { hasLocalDownloadArtifactExpectation, toJobSummaryView, toJobView };

const MAX_JOBS_PER_USER_AND_KIND = 50;

interface RawJobSummaryRow {
  id: string;
  user_id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  title: string;
  subtitle: string | null;
  metadata_json: string | null;
  has_result: number;
  error_code: ErrorCode | null;
  error_message: string | null;
  artifact_filename: string | null;
  artifact_expired: number | null;
  direct_url: string | null;
  revision: number | null;
  created_at: number;
  updated_at: number;
}

interface RawJobRow extends Omit<RawJobSummaryRow, "has_result"> {
  result_json: string | null;
}

const SUMMARY_SELECT_COLUMNS = `
  id, user_id, kind, status, progress, title, subtitle, metadata_json,
  (result_json IS NOT NULL) AS has_result,
  error_code, error_message, artifact_filename, artifact_expired,
  direct_url, revision, created_at, updated_at
`;

function safeParseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function mapSummaryRow(row: RawJobSummaryRow): StoredJobSummaryRecord {
  const metadata = safeParseJson<Record<string, unknown>>(row.metadata_json);
  const artifactExpired = Boolean(row.artifact_expired) || Boolean(metadata?.artifactExpired);
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    metadata,
    hasResult: Boolean(row.has_result),
    revision: Number(row.revision ?? 0) || 0,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    artifactFilename: row.artifact_filename ?? undefined,
    artifactExpired,
    directUrl: row.direct_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRow(row: RawJobRow): StoredJobRecord {
  const metadata = safeParseJson<Record<string, unknown>>(row.metadata_json);
  const result = safeParseJson<unknown>(row.result_json);
  const artifactExpired = Boolean(row.artifact_expired) || Boolean(metadata?.artifactExpired);
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    metadata,
    hasResult: row.result_json !== null && result !== undefined,
    result,
    revision: Number(row.revision ?? 0) || 0,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    artifactFilename: row.artifact_filename ?? undefined,
    artifactExpired,
    directUrl: row.direct_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getClearedColumnForKind(kind: JobKind): string {
  switch (kind) {
    case "download":
      return "download_cleared_before_revision";
    case "transfer":
      return "transfer_cleared_before_revision";
    case "import_audit":
      return "import_audit_cleared_before_revision";
    case "compare":
      return "compare_cleared_before_revision";
  }
}

export class JobRepository implements JobRepositoryPort {
  readonly #sqlite: SqliteClient;

  constructor(sqlite: SqliteClient, _options?: { tmpDownloadsDir?: string }) {
    this.#sqlite = sqlite;
  }

  bumpJobRevision(userId: string): number {
    return this.#sqlite.transaction(() => {
      this.#sqlite.db
        .prepare(
          `INSERT INTO user_revisions (user_id, job_revision)
           VALUES (?, 1)
           ON CONFLICT(user_id) DO UPDATE SET
             job_revision = user_revisions.job_revision + 1`,
        )
        .run(userId);
      const row = this.#sqlite.db
        .prepare("SELECT job_revision FROM user_revisions WHERE user_id = ?")
        .get(userId) as { job_revision: number };
      return row.job_revision;
    });
  }

  getJobRevisionState(userId: string, kind?: JobKind): JobRevisionState {
    const row = this.#sqlite.db
      .prepare(
        `SELECT job_revision, job_cleared_before_revision,
                download_cleared_before_revision, transfer_cleared_before_revision,
                import_audit_cleared_before_revision, compare_cleared_before_revision
         FROM user_revisions
         WHERE user_id = ?`,
      )
      .get(userId) as
      | {
          job_revision: number;
          job_cleared_before_revision: number;
          download_cleared_before_revision: number;
          transfer_cleared_before_revision: number;
          import_audit_cleared_before_revision: number;
          compare_cleared_before_revision: number;
        }
      | undefined;

    if (!row) {
      return { serverRevision: 0, clearedBeforeRevision: 0 };
    }

    const serverRevision = row.job_revision;
    if (!kind) {
      return {
        serverRevision,
        clearedBeforeRevision: row.job_cleared_before_revision,
      };
    }

    const kindCleared =
      kind === "download"
        ? row.download_cleared_before_revision
        : kind === "transfer"
          ? row.transfer_cleared_before_revision
          : kind === "import_audit"
            ? row.import_audit_cleared_before_revision
            : row.compare_cleared_before_revision;

    return {
      serverRevision,
      clearedBeforeRevision: Math.max(row.job_cleared_before_revision, kindCleared),
    };
  }

  findRawById(id: string): StoredJobRecord | null {
    const row = this.#sqlite.db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as
      | RawJobRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  findRawSummaryById(id: string): StoredJobSummaryRecord | null {
    const row = this.#sqlite.db
      .prepare(`SELECT ${SUMMARY_SELECT_COLUMNS} FROM background_jobs WHERE id = ?`)
      .get(id) as RawJobSummaryRow | undefined;
    return row ? mapSummaryRow(row) : null;
  }

  findRawOwned(userId: string, id: string): StoredJobRecord | null {
    const row = this.#sqlite.db
      .prepare("SELECT * FROM background_jobs WHERE id = ? AND user_id = ?")
      .get(id, userId) as RawJobRow | undefined;
    return row ? mapRow(row) : null;
  }

  findRawOwnedSummary(userId: string, id: string): StoredJobSummaryRecord | null {
    const row = this.#sqlite.db
      .prepare(`SELECT ${SUMMARY_SELECT_COLUMNS} FROM background_jobs WHERE id = ? AND user_id = ?`)
      .get(id, userId) as RawJobSummaryRow | undefined;
    return row ? mapSummaryRow(row) : null;
  }

  listSummariesByUser(userId: string, kind?: JobKind): StoredJobSummaryRecord[] {
    const rows = kind
      ? (this.#sqlite.db
          .prepare(
            `SELECT ${SUMMARY_SELECT_COLUMNS}
             FROM background_jobs
             WHERE user_id = ? AND kind = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(userId, kind, MAX_JOBS_PER_USER_AND_KIND) as unknown as RawJobSummaryRow[])
      : (this.#sqlite.db
          .prepare(
            `SELECT ${SUMMARY_SELECT_COLUMNS}
             FROM background_jobs
             WHERE user_id = ?
             ORDER BY created_at DESC LIMIT 100`,
          )
          .all(userId) as unknown as RawJobSummaryRow[]);

    return rows.map(mapSummaryRow);
  }

  listSummariesWithRevision(
    userId: string,
    kind?: JobKind,
  ): { jobs: StoredJobSummaryRecord[]; serverRevision: number; clearedBeforeRevision: number } {
    return this.#sqlite.transaction(() => {
      const jobs = this.listSummariesByUser(userId, kind);
      const { serverRevision, clearedBeforeRevision } = this.getJobRevisionState(userId, kind);
      return { jobs, serverRevision, clearedBeforeRevision };
    });
  }

  listRawByUser(userId: string, kind?: JobKind): StoredJobRecord[] {
    const rows = kind
      ? (this.#sqlite.db
          .prepare(
            "SELECT * FROM background_jobs WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(userId, kind, MAX_JOBS_PER_USER_AND_KIND) as unknown as RawJobRow[])
      : (this.#sqlite.db
          .prepare("SELECT * FROM background_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100")
          .all(userId) as unknown as RawJobRow[]);

    return rows.map(mapRow);
  }

  listActiveCompletedDownloads(): StoredJobSummaryRecord[] {
    const rows = this.#sqlite.db
      .prepare(
        `SELECT ${SUMMARY_SELECT_COLUMNS}
         FROM background_jobs
         WHERE kind = 'download'
           AND status = 'completed'
           AND artifact_filename IS NOT NULL
           AND direct_url IS NULL
           AND artifact_expired = 0`,
      )
      .all() as unknown as RawJobSummaryRow[];
    return rows
      .map(mapSummaryRow)
      .filter((record) => !record.artifactExpired && record.metadata?.mode !== "direct_link");
  }

  /**
   * On server startup, mark any previously queued/running jobs as interrupted so they never hang.
   * Returns recovered jobs so partial temp artifacts can be cleaned up (C021).
   */
  recoverInterruptedJobs(errorMessage?: string): Array<{ id: string; userId: string }> {
    return this.#sqlite.immediateTransaction(() => {
      const interrupted = this.#sqlite.db
        .prepare("SELECT id, user_id FROM background_jobs WHERE status IN ('queued', 'running')")
        .all() as Array<{ id: string; user_id: string }>;

      if (interrupted.length > 0) {
        const now = Date.now();
        const revByUser = new Map<string, number>();
        for (const row of interrupted) {
          if (!revByUser.has(row.user_id)) {
            revByUser.set(row.user_id, this.bumpJobRevision(row.user_id));
          }
        }
        const updateStmt = this.#sqlite.db.prepare(
          `UPDATE background_jobs
           SET status = 'failed',
               error_code = 'INTERNAL_ERROR',
               error_message = ?,
               revision = ?,
               updated_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        );
        for (const row of interrupted) {
          updateStmt.run(errorMessage ?? null, revByUser.get(row.user_id) ?? 0, now, row.id);
        }
      }

      return interrupted.map((row) => ({ id: row.id, userId: row.user_id }));
    });
  }

  insert(record: StoredJobRecord): { evictedIds: string[]; revision: number } {
    return this.#sqlite.transaction(() => {
      const revision = this.bumpJobRevision(record.userId);
      const artifactExpired = Boolean(record.artifactExpired || record.metadata?.artifactExpired);
      this.#sqlite.db
        .prepare(
          `INSERT INTO background_jobs (
            id, user_id, kind, status, progress, title, subtitle, metadata_json, result_json,
            error_code, error_message, artifact_filename, artifact_expired, direct_url, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.userId,
          record.kind,
          record.status,
          record.progress,
          record.title,
          record.subtitle ?? null,
          record.metadata ? JSON.stringify(record.metadata) : null,
          record.result !== undefined ? JSON.stringify(record.result) : null,
          record.errorCode ?? null,
          record.errorMessage ?? null,
          record.artifactFilename ?? null,
          artifactExpired ? 1 : 0,
          record.directUrl ?? null,
          revision,
          record.createdAt,
          record.updatedAt,
        );

      // Retain per-user per-kind history independently and return evicted IDs for orphan artifact cleanup (C021)
      const evictedRows = this.#sqlite.db
        .prepare(
          `SELECT id FROM background_jobs
           WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')
             AND id NOT IN (
               SELECT id FROM background_jobs
               WHERE user_id = ? AND kind = ?
               ORDER BY created_at DESC LIMIT ?
             )`,
        )
        .all(record.userId, record.kind, record.userId, record.kind, MAX_JOBS_PER_USER_AND_KIND) as Array<{
        id: string;
      }>;

      const evictedIds = evictedRows.map((row) => row.id);
      if (evictedIds.length > 0) {
        this.#sqlite.db
          .prepare(
            `DELETE FROM background_jobs
             WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')
               AND id NOT IN (
                 SELECT id FROM background_jobs
                 WHERE user_id = ? AND kind = ?
                 ORDER BY created_at DESC LIMIT ?
               )`,
          )
          .run(record.userId, record.kind, record.userId, record.kind, MAX_JOBS_PER_USER_AND_KIND);
      }

      return { evictedIds, revision };
    });
  }

  update(
    id: string,
    patch: JobUpdatePatch,
    options?: { expectedStatus?: JobStatus | readonly JobStatus[] },
  ): StoredJobRecord | null {
    return this.#sqlite.immediateTransaction(() => {
      const current = this.findRawSummaryById(id);
      if (!current) return null;

      if (options?.expectedStatus !== undefined) {
        const allowed = Array.isArray(options.expectedStatus)
          ? options.expectedStatus
          : [options.expectedStatus];
        if (!allowed.includes(current.status)) {
          return null;
        }
      }

      const revision = this.bumpJobRevision(current.userId);
      const hasResultPatch = Object.prototype.hasOwnProperty.call(patch, "result");
      const nextMetadata = patch.metadata !== undefined ? patch.metadata : current.metadata;
      const nextArtifactExpired =
        patch.artifactExpired !== undefined
          ? patch.artifactExpired
          : Boolean(current.artifactExpired || nextMetadata?.artifactExpired);
      const updatedAt = Date.now();
      const nextStatus = patch.status ?? current.status;
      const nextProgress = patch.progress ?? current.progress;
      const nextSubtitle = patch.subtitle !== undefined ? patch.subtitle : current.subtitle;
      const nextErrorCode = patch.errorCode !== undefined ? patch.errorCode : current.errorCode;
      const nextErrorMessage = patch.errorMessage !== undefined ? patch.errorMessage : current.errorMessage;
      const nextArtifactFilename =
        patch.artifactFilename !== undefined ? patch.artifactFilename : current.artifactFilename;
      const nextDirectUrl = patch.directUrl !== undefined ? patch.directUrl : current.directUrl;
      const nextHasResult = hasResultPatch ? patch.result !== undefined : current.hasResult;

      if (hasResultPatch) {
        this.#sqlite.db
          .prepare(
            `UPDATE background_jobs SET
               status = ?,
               progress = ?,
               subtitle = ?,
               metadata_json = ?,
               result_json = ?,
               error_code = ?,
               error_message = ?,
               artifact_filename = ?,
               artifact_expired = ?,
               direct_url = ?,
               revision = ?,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextStatus,
            nextProgress,
            nextSubtitle ?? null,
            nextMetadata ? JSON.stringify(nextMetadata) : null,
            patch.result !== undefined ? JSON.stringify(patch.result) : null,
            nextErrorCode ?? null,
            nextErrorMessage ?? null,
            nextArtifactFilename ?? null,
            nextArtifactExpired ? 1 : 0,
            nextDirectUrl ?? null,
            revision,
            updatedAt,
            id,
          );
      } else {
        this.#sqlite.db
          .prepare(
            `UPDATE background_jobs SET
               status = ?,
               progress = ?,
               subtitle = ?,
               metadata_json = ?,
               error_code = ?,
               error_message = ?,
               artifact_filename = ?,
               artifact_expired = ?,
               direct_url = ?,
               revision = ?,
               updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextStatus,
            nextProgress,
            nextSubtitle ?? null,
            nextMetadata ? JSON.stringify(nextMetadata) : null,
            nextErrorCode ?? null,
            nextErrorMessage ?? null,
            nextArtifactFilename ?? null,
            nextArtifactExpired ? 1 : 0,
            nextDirectUrl ?? null,
            revision,
            updatedAt,
            id,
          );
      }

      return {
        ...current,
        status: nextStatus,
        progress: nextProgress,
        subtitle: nextSubtitle,
        metadata: nextMetadata,
        hasResult: nextHasResult,
        ...(hasResultPatch ? { result: patch.result } : {}),
        errorCode: nextErrorCode,
        errorMessage: nextErrorMessage,
        artifactFilename: nextArtifactFilename,
        artifactExpired: nextArtifactExpired,
        directUrl: nextDirectUrl,
        revision,
        updatedAt,
      };
    });
  }

  mutateOwnedResult<TResult = unknown>(
    userId: string,
    jobId: string,
    mutator: (record: StoredJobRecord) => { result: TResult; subtitle?: string },
  ): StoredJobRecord | null {
    return this.#sqlite.immediateTransaction(() => {
      const row = this.#sqlite.db
        .prepare("SELECT * FROM background_jobs WHERE id = ? AND user_id = ?")
        .get(jobId, userId) as RawJobRow | undefined;
      if (!row) return null;

      const current = mapRow(row);
      const mutated = mutator(current);
      const revision = this.bumpJobRevision(userId);
      const updatedAt = Date.now();
      const nextSubtitle = mutated.subtitle !== undefined ? mutated.subtitle : current.subtitle;

      this.#sqlite.db
        .prepare(
          `UPDATE background_jobs
           SET result_json = ?,
               subtitle = ?,
               revision = ?,
               updated_at = ?
           WHERE id = ? AND user_id = ?`,
        )
        .run(
          mutated.result !== undefined ? JSON.stringify(mutated.result) : null,
          nextSubtitle ?? null,
          revision,
          updatedAt,
          jobId,
          userId,
        );

      return {
        ...current,
        result: mutated.result,
        hasResult: mutated.result !== undefined,
        subtitle: nextSubtitle,
        revision,
        updatedAt,
      };
    });
  }

  findById(id: string): StoredJobRecord | null {
    return this.findRawById(id);
  }

  findOwned(userId: string, id: string): StoredJobRecord | null {
    return this.findRawOwned(userId, id);
  }

  listByUser(userId: string, kind?: JobKind): StoredJobRecord[] {
    return this.listRawByUser(userId, kind);
  }

  clearFinished(
    userId: string,
    kind?: JobKind,
  ): { removedIds: string[]; serverRevision: number; clearedBeforeRevision: number } {
    return this.#sqlite.immediateTransaction(() => {
      const selectSql = kind
        ? "SELECT id FROM background_jobs WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')"
        : "SELECT id FROM background_jobs WHERE user_id = ? AND status IN ('completed', 'failed', 'cancelled')";
      const rows = (
        kind
          ? this.#sqlite.db.prepare(selectSql).all(userId, kind)
          : this.#sqlite.db.prepare(selectSql).all(userId)
      ) as Array<{ id: string }>;

      if (rows.length === 0) {
        const state = this.getJobRevisionState(userId, kind);
        return {
          removedIds: [],
          serverRevision: state.serverRevision,
          clearedBeforeRevision: state.clearedBeforeRevision,
        };
      }

      const deleteSql = kind
        ? "DELETE FROM background_jobs WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')"
        : "DELETE FROM background_jobs WHERE user_id = ? AND status IN ('completed', 'failed', 'cancelled')";
      if (kind) {
        this.#sqlite.db.prepare(deleteSql).run(userId, kind);
      } else {
        this.#sqlite.db.prepare(deleteSql).run(userId);
      }

      const nextRev = this.bumpJobRevision(userId);
      if (kind) {
        const col = getClearedColumnForKind(kind);
        this.#sqlite.db
          .prepare(`UPDATE user_revisions SET ${col} = ? WHERE user_id = ?`)
          .run(nextRev, userId);
      } else {
        this.#sqlite.db
          .prepare(
            `UPDATE user_revisions
             SET job_cleared_before_revision = ?,
                 download_cleared_before_revision = ?,
                 transfer_cleared_before_revision = ?,
                 import_audit_cleared_before_revision = ?,
                 compare_cleared_before_revision = ?
             WHERE user_id = ?`,
          )
          .run(nextRev, nextRev, nextRev, nextRev, nextRev, userId);
      }

      return {
        removedIds: rows.map((r) => r.id),
        serverRevision: nextRev,
        clearedBeforeRevision: nextRev,
      };
    });
  }
}
