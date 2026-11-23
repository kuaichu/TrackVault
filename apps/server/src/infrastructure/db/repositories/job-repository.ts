import fs from "node:fs";
import path from "node:path";
import type { ErrorCode, JobKind, JobStatus, JobView } from "#shared";
import type { SqliteClient } from "../client.js";

const MAX_JOBS_PER_USER_AND_KIND = 50;

export function resolveJobArtifactPath(
  tmpDownloadsDir: string,
  userId: string,
  jobId: string,
): string | null {
  const root = path.resolve(tmpDownloadsDir);
  const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "");
  const safeJob = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeUser || !safeJob) return null;
  const target = path.resolve(root, safeUser, `${safeJob}.bin`);
  if (!target.startsWith(root + path.sep)) return null;
  return target;
}

export function hasLocalDownloadArtifactExpectation(record: StoredJobRecord): boolean {
  const isDirectLink = Boolean(record.directUrl) || record.metadata?.mode === "direct_link";
  const artifactExpired = Boolean(record.metadata?.artifactExpired);
  return (
    record.kind === "download" &&
    record.status === "completed" &&
    Boolean(record.artifactFilename) &&
    !isDirectLink &&
    !artifactExpired
  );
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
  result?: unknown;
  errorCode?: ErrorCode;
  errorMessage?: string;
  artifactFilename?: string;
  directUrl?: string;
  createdAt: number;
  updatedAt: number;
}

interface RawJobRow {
  id: string;
  user_id: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  title: string;
  subtitle: string | null;
  metadata_json: string | null;
  result_json: string | null;
  error_code: ErrorCode | null;
  error_message: string | null;
  artifact_filename: string | null;
  direct_url: string | null;
  created_at: number;
  updated_at: number;
}

function safeParseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function mapRow(row: RawJobRow): StoredJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    metadata: safeParseJson<Record<string, unknown>>(row.metadata_json),
    result: safeParseJson<unknown>(row.result_json),
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    artifactFilename: row.artifact_filename ?? undefined,
    directUrl: row.direct_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toJobView(record: StoredJobRecord): JobView {
  const artifactExpired = Boolean(record.metadata?.artifactExpired);
  const isDirectLink = Boolean(record.directUrl) || record.metadata?.mode === "direct_link";

  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    progress: record.progress,
    title: record.title,
    subtitle: record.subtitle,
    metadata: record.metadata,
    result: record.result,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    // J04: Separate local server artifact availability from directUrl / expired artifacts (zero DB migration)
    downloadReady:
      record.kind === "download" &&
      record.status === "completed" &&
      Boolean(record.artifactFilename) &&
      !isDirectLink &&
      !artifactExpired,
    artifactExpired: artifactExpired || undefined,
    directUrl: record.directUrl,
    artifactFilename: record.artifactFilename,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class JobRepository {
  readonly #sqlite: SqliteClient;
  readonly #tmpDownloadsDir: string | null;

  constructor(sqlite: SqliteClient, options?: { tmpDownloadsDir?: string }) {
    this.#sqlite = sqlite;
    this.#tmpDownloadsDir = options?.tmpDownloadsDir ? path.resolve(options.tmpDownloadsDir) : null;
  }

  findRawById(id: string): StoredJobRecord | null {
    const row = this.#sqlite.db.prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as
      | RawJobRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  findRawOwned(userId: string, id: string): StoredJobRecord | null {
    const row = this.#sqlite.db
      .prepare("SELECT * FROM background_jobs WHERE id = ? AND user_id = ?")
      .get(id, userId) as RawJobRow | undefined;
    return row ? mapRow(row) : null;
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

  #reconcileMissingArtifact(record: StoredJobRecord): StoredJobRecord {
    if (!this.#tmpDownloadsDir || !hasLocalDownloadArtifactExpectation(record)) {
      return record;
    }
    const artifactPath = resolveJobArtifactPath(this.#tmpDownloadsDir, record.userId, record.id);
    let exists = false;
    if (artifactPath) {
      try {
        exists = fs.statSync(artifactPath).isFile();
      } catch {
        exists = false;
      }
    }
    if (exists) {
      return record;
    }

    const updatedAt = Date.now();
    const nextMetadata: Record<string, unknown> = {
      ...(record.metadata ?? {}),
      artifactExpired: true,
    };
    const nextSubtitle = "临时文件已过期，请重新下载";
    this.#sqlite.db
      .prepare(
        `UPDATE background_jobs
         SET subtitle = ?, metadata_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextSubtitle, JSON.stringify(nextMetadata), updatedAt, record.id);

    return {
      ...record,
      subtitle: nextSubtitle,
      metadata: nextMetadata,
      updatedAt,
    };
  }

  listActiveCompletedDownloads(): StoredJobRecord[] {
    const rows = this.#sqlite.db
      .prepare(
        `SELECT * FROM background_jobs
         WHERE kind = 'download'
           AND status = 'completed'
           AND artifact_filename IS NOT NULL
           AND direct_url IS NULL`,
      )
      .all() as unknown as RawJobRow[];
    return rows.map(mapRow).filter(hasLocalDownloadArtifactExpectation);
  }

  /**
   * On server startup, mark any previously queued/running jobs as interrupted so they never hang.
   * Returns recovered jobs so partial temp artifacts can be cleaned up (C021).
   */
  recoverInterruptedJobs(): Array<{ id: string; userId: string }> {
    const interrupted = this.#sqlite.db
      .prepare("SELECT id, user_id FROM background_jobs WHERE status IN ('queued', 'running')")
      .all() as Array<{ id: string; user_id: string }>;

    if (interrupted.length > 0) {
      this.#sqlite.db
        .prepare(
          `UPDATE background_jobs
           SET status = 'failed',
               error_code = 'INTERNAL_ERROR',
               error_message = '任务在服务重启前被中断，请重试。',
               updated_at = ?
           WHERE status IN ('queued', 'running')`,
        )
        .run(Date.now());
    }

    return interrupted.map((row) => ({ id: row.id, userId: row.user_id }));
  }

  insert(record: StoredJobRecord): string[] {
    let evictedIds: string[] = [];
    this.#sqlite.transaction(() => {
      this.#sqlite.db
        .prepare(
          `INSERT INTO background_jobs (
            id, user_id, kind, status, progress, title, subtitle, metadata_json, result_json,
            error_code, error_message, artifact_filename, direct_url, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.directUrl ?? null,
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

      evictedIds = evictedRows.map((row) => row.id);
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
    });
    return evictedIds;
  }

  update(
    id: string,
    patch: Partial<
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
        | "directUrl"
      >
    >,
  ): StoredJobRecord | null {
    const current = this.findRawById(id);
    if (!current) return null;

    const next: StoredJobRecord = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };

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
           direct_url = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.progress,
        next.subtitle ?? null,
        next.metadata ? JSON.stringify(next.metadata) : null,
        next.result !== undefined ? JSON.stringify(next.result) : null,
        next.errorCode ?? null,
        next.errorMessage ?? null,
        next.artifactFilename ?? null,
        next.directUrl ?? null,
        next.updatedAt,
        id,
      );

    return next;
  }

  findById(id: string): StoredJobRecord | null {
    const record = this.findRawById(id);
    return record ? this.#reconcileMissingArtifact(record) : null;
  }

  findOwned(userId: string, id: string): StoredJobRecord | null {
    const record = this.findRawOwned(userId, id);
    return record ? this.#reconcileMissingArtifact(record) : null;
  }

  listByUser(userId: string, kind?: JobKind): StoredJobRecord[] {
    return this.listRawByUser(userId, kind).map((record) => this.#reconcileMissingArtifact(record));
  }

  clearFinished(userId: string, kind?: JobKind): string[] {
    const selectSql = kind
      ? "SELECT id FROM background_jobs WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')"
      : "SELECT id FROM background_jobs WHERE user_id = ? AND status IN ('completed', 'failed', 'cancelled')";
    const rows = (
      kind
        ? this.#sqlite.db.prepare(selectSql).all(userId, kind)
        : this.#sqlite.db.prepare(selectSql).all(userId)
    ) as Array<{ id: string }>;

    if (rows.length === 0) return [];

    const deleteSql = kind
      ? "DELETE FROM background_jobs WHERE user_id = ? AND kind = ? AND status IN ('completed', 'failed', 'cancelled')"
      : "DELETE FROM background_jobs WHERE user_id = ? AND status IN ('completed', 'failed', 'cancelled')";
    if (kind) {
      this.#sqlite.db.prepare(deleteSql).run(userId, kind);
    } else {
      this.#sqlite.db.prepare(deleteSql).run(userId);
    }
    return rows.map((r) => r.id);
  }
}
