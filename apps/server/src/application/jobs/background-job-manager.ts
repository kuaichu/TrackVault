import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ErrorCode, JobDetailView, JobEvent, JobKind, JobView, JobsListResponse } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError, isAppError } from "../../domain/errors.js";
import type {
  JobRepositoryPort,
  StoredJobRecord,
  StoredJobSummaryRecord,
} from "../../domain/ports/job-repository.js";
import { hasLocalDownloadArtifactExpectation, toJobSummaryView, toJobView } from "./job-view-mapper.js";

export interface JobRuntimeHandle {
  readonly jobId: string;
  readonly signal: AbortSignal;
  updateProgress(progress: number, subtitle?: string): void;
  getArtifactPath(extension: string): Promise<{ filePath: string; artifactFilename: string }>;
}

export interface JobRunOutcome {
  result?: unknown;
  subtitle?: string;
  artifactFilename?: string;
  directUrl?: string;
  metadata?: Record<string, unknown>;
}

interface QueuedExecution {
  record: StoredJobRecord;
  maxUserConcurrency: number;
  runner: (handle: JobRuntimeHandle) => Promise<JobRunOutcome>;
}

const ARTIFACT_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Unified, owner-scoped background job manager for downloads, playlist transfers,
 * import audits, and playlist comparisons.
 * - Enforces ownerId checks on every read/cancel/artifact fetch.
 * - Enforces per-user and global concurrency caps.
 * - Persists state row-by-row to SQLite with monotonic per-user revision and CAS guards.
 */
export class BackgroundJobManager {
  readonly #repo: JobRepositoryPort;
  readonly #tmpDownloadsDir: string;
  readonly #globalMaxDownload: number;
  readonly #globalMaxGeneral: number;

  readonly #events = new EventEmitter();
  readonly #queue: QueuedExecution[] = [];
  readonly #runningControllers = new Map<
    string,
    { userId: string; kind: JobKind; controller: AbortController }
  >();
  #cleanupTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: {
    repo: JobRepositoryPort;
    tmpDownloadsDir: string;
    globalMaxConcurrentDownloads: number;
    globalMaxConcurrentJobs: number;
  }) {
    this.#repo = options.repo;
    this.#tmpDownloadsDir = path.resolve(options.tmpDownloadsDir);
    this.#globalMaxDownload = options.globalMaxConcurrentDownloads;
    this.#globalMaxGeneral = options.globalMaxConcurrentJobs;
    this.#events.setMaxListeners(100);
    const recovered = this.#repo.recoverInterruptedJobs("任务在服务重启前被中断，请重试。");
    for (const item of recovered) {
      void this.#deleteArtifactById(item.userId, item.id).catch(() => undefined);
    }
    // J04: Startup scan marks any completed local download whose temp file is already missing as expired
    for (const completed of this.#repo.listActiveCompletedDownloads()) {
      this.#reconcileArtifactRecord(completed, false);
    }
  }

  startPeriodicCleanup(): void {
    if (this.#cleanupTimer || this.#stopped) return;
    this.#cleanupTimer = setInterval(
      () => {
        void this.cleanupExpiredArtifacts().catch(() => undefined);
      },
      30 * 60 * 1000,
    );
    this.#cleanupTimer.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }

    const queuedItems = this.#queue.splice(0, this.#queue.length);
    for (const item of queuedItems) {
      const updated = this.#repo.update(
        item.record.id,
        { status: "cancelled", subtitle: "服务已停止，任务已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      if (updated) {
        this.#emit(item.record.userId, {
          type: "job_updated",
          job: toJobSummaryView(updated),
          serverRevision: updated.revision ?? 0,
          timestamp: updated.updatedAt,
        });
      }
      void this.#deleteArtifactById(item.record.userId, item.record.id).catch(() => undefined);
    }

    const runningEntries = [...this.#runningControllers.entries()];
    this.#runningControllers.clear();
    for (const [jobId, entry] of runningEntries) {
      entry.controller.abort();
      const updated = this.#repo.update(
        jobId,
        { status: "cancelled", subtitle: "服务已停止，任务已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      if (updated) {
        this.#emit(entry.userId, {
          type: "job_updated",
          job: toJobSummaryView(updated),
          serverRevision: updated.revision ?? 0,
          timestamp: updated.updatedAt,
        });
      }
      void this.#deleteArtifactById(entry.userId, jobId).catch(() => undefined);
    }
  }

  subscribe(userId: string, listener: (event: JobEvent) => void): () => void {
    const channel = `user:${userId}`;
    this.#events.on(channel, listener);
    return () => {
      this.#events.off(channel, listener);
    };
  }

  #emit(userId: string, event: JobEvent): void {
    this.#events.emit(`user:${userId}`, event);
  }

  enqueue(input: {
    actor: ActorContext;
    kind: JobKind;
    title: string;
    subtitle?: string;
    metadata?: Record<string, unknown>;
    maxUserConcurrency?: number;
    runner: (handle: JobRuntimeHandle) => Promise<JobRunOutcome>;
  }): JobView {
    if (this.#stopped) {
      throw new AppError("INTERNAL_ERROR", "服务正在停止，暂不接受新任务。");
    }

    const activeForUser =
      [...this.#runningControllers.values()].filter(
        (r) => r.userId === input.actor.userId && r.kind === input.kind,
      ).length +
      this.#queue.filter((q) => q.record.userId === input.actor.userId && q.record.kind === input.kind)
        .length;

    const queueLimit = input.kind === "download" ? 30 : 10;
    if (activeForUser >= queueLimit) {
      throw new AppError("JOB_LIMIT_EXCEEDED", "当前排队任务过多，请等待部分任务完成后再试。");
    }

    const now = Date.now();
    const record: StoredJobRecord = {
      id: crypto.randomUUID(),
      userId: input.actor.userId,
      kind: input.kind,
      status: "queued",
      progress: 0,
      title: input.title,
      subtitle: input.subtitle,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    const { evictedIds, revision } = this.#repo.insert(record);
    const persistedRecord: StoredJobRecord = {
      ...record,
      revision,
      hasResult: false,
      artifactExpired: false,
    };
    for (const evictedId of evictedIds) {
      this.#emit(input.actor.userId, {
        type: "job_removed",
        jobId: evictedId,
        serverRevision: revision,
        timestamp: now,
      });
      void this.#deleteArtifactById(input.actor.userId, evictedId).catch(() => undefined);
    }
    const summaryView = toJobSummaryView(persistedRecord);
    this.#emit(input.actor.userId, {
      type: "job_updated",
      job: summaryView,
      serverRevision: revision,
      timestamp: now,
    });

    this.#queue.push({
      record: persistedRecord,
      maxUserConcurrency: Math.max(1, input.maxUserConcurrency ?? 2),
      runner: input.runner,
    });
    this.#drainQueue();

    return toJobView(persistedRecord);
  }

  listForActorWithRevision(actor: ActorContext, kind?: JobKind): JobsListResponse {
    const { jobs, serverRevision, clearedBeforeRevision } = this.#repo.listSummariesWithRevision(
      actor.userId,
      kind,
    );
    return {
      jobs: jobs.map(toJobSummaryView),
      serverRevision,
      clearedBeforeRevision,
    };
  }

  getOwnedJob(actor: ActorContext, jobId: string): StoredJobRecord {
    const record = this.#repo.findRawOwned(actor.userId, jobId);
    if (!record) {
      throw new AppError("NOT_FOUND", "任务不存在或无权访问。");
    }
    return this.#reconcileArtifactRecord(record, true);
  }

  getOwnedJobView(actor: ActorContext, jobId: string): JobDetailView {
    return toJobView(this.getOwnedJob(actor, jobId));
  }

  mutateOwnedJobResult<TResult = unknown>(
    actor: ActorContext,
    jobId: string,
    mutator: (record: StoredJobRecord) => { result: TResult; subtitle?: string },
  ): JobDetailView {
    const updated = this.#repo.mutateOwnedResult(actor.userId, jobId, mutator);
    if (!updated) {
      throw new AppError("NOT_FOUND", "任务不存在或无权访问。");
    }
    this.#emit(actor.userId, {
      type: "job_updated",
      job: toJobSummaryView(updated),
      serverRevision: updated.revision ?? 0,
      timestamp: updated.updatedAt,
    });
    return toJobView(updated);
  }

  updateOwnedJobResult(
    actor: ActorContext,
    jobId: string,
    patch: { result: unknown; subtitle?: string },
  ): JobDetailView {
    return this.mutateOwnedJobResult(actor, jobId, () => patch);
  }

  cancelOwnedJob(actor: ActorContext, jobId: string): JobDetailView {
    const record = this.getOwnedJob(actor, jobId);

    const queueIndex = this.#queue.findIndex((item) => item.record.id === jobId);
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
      const updated = this.#repo.update(
        jobId,
        { status: "cancelled", subtitle: "已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      const effective = updated ?? record;
      this.#emit(actor.userId, {
        type: "job_updated",
        job: toJobSummaryView(effective),
        serverRevision: effective.revision ?? 0,
        timestamp: Date.now(),
      });
      return toJobView(effective);
    }

    const running = this.#runningControllers.get(jobId);
    if (running) {
      running.controller.abort();
      const updated = this.#repo.update(
        jobId,
        { status: "cancelled", subtitle: "已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      const effective = updated ?? record;
      this.#emit(actor.userId, {
        type: "job_updated",
        job: toJobSummaryView(effective),
        serverRevision: effective.revision ?? 0,
        timestamp: Date.now(),
      });
      return toJobView(effective);
    }

    return toJobView(record);
  }

  cancelJobsForUser(userId: string, options?: { removeArtifactsDir?: boolean }): void {
    for (let i = this.#queue.length - 1; i >= 0; i -= 1) {
      const queued = this.#queue[i];
      if (!queued || queued.record.userId !== userId) continue;
      this.#queue.splice(i, 1);
      const updated = this.#repo.update(
        queued.record.id,
        { status: "cancelled", subtitle: "账号权限变更，任务已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      if (updated) {
        this.#emit(userId, {
          type: "job_updated",
          job: toJobSummaryView(updated),
          serverRevision: updated.revision ?? 0,
          timestamp: Date.now(),
        });
      }
    }

    for (const [jobId, running] of this.#runningControllers.entries()) {
      if (running.userId !== userId) continue;
      running.controller.abort();
      const updated = this.#repo.update(
        jobId,
        { status: "cancelled", subtitle: "账号权限变更，任务已取消" },
        { expectedStatus: ["queued", "running"] },
      );
      if (updated) {
        this.#emit(userId, {
          type: "job_updated",
          job: toJobSummaryView(updated),
          serverRevision: updated.revision ?? 0,
          timestamp: Date.now(),
        });
      }
    }

    if (options?.removeArtifactsDir) {
      const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "");
      if (safeUser) {
        const userDir = path.resolve(this.#tmpDownloadsDir, safeUser);
        if (userDir.startsWith(this.#tmpDownloadsDir + path.sep)) {
          void fs.rm(userDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }
  }

  clearFinishedWithRevision(
    actor: ActorContext,
    kind?: JobKind,
  ): { removedCount: number; serverRevision: number; clearedBeforeRevision: number } {
    const { removedIds, serverRevision, clearedBeforeRevision } = this.#repo.clearFinished(
      actor.userId,
      kind,
    );
    const now = Date.now();
    if (removedIds.length > 0) {
      for (const id of removedIds) {
        this.#emit(actor.userId, {
          type: "job_removed",
          jobId: id,
          serverRevision,
          clearedBeforeRevision,
          ...(kind ? { clearedKind: kind } : {}),
          timestamp: now,
        });
        void this.#deleteArtifactById(actor.userId, id).catch(() => undefined);
      }
      this.#emit(actor.userId, {
        type: "jobs_cleared",
        serverRevision,
        clearedBeforeRevision,
        ...(kind ? { clearedKind: kind } : {}),
        timestamp: now,
      });
    }
    return {
      removedCount: removedIds.length,
      serverRevision,
      clearedBeforeRevision,
    };
  }

  #validateArtifactAccess(
    actor: ActorContext,
    jobId: string,
  ): { record: StoredJobSummaryRecord; artifactFilename: string; safeFilePath: string } {
    const record = this.#repo.findRawOwnedSummary(actor.userId, jobId);
    if (!record) {
      throw new AppError("NOT_FOUND", "任务不存在或无权访问。");
    }

    const isDirectLink = Boolean(record.directUrl) || record.metadata?.mode === "direct_link";
    const isExpired = Boolean(record.artifactExpired || record.metadata?.artifactExpired);
    if (
      record.kind !== "download" ||
      record.status !== "completed" ||
      !record.artifactFilename ||
      isDirectLink ||
      isExpired
    ) {
      throw new AppError("NOT_FOUND", "下载文件尚未就绪或已过期。");
    }

    return {
      record,
      artifactFilename: record.artifactFilename,
      safeFilePath: this.#resolveSafeArtifactPath(actor.userId, jobId),
    };
  }

  async openOwnedArtifactFile(
    actor: ActorContext,
    jobId: string,
  ): Promise<{ fileHandle: fs.FileHandle; downloadFilename: string; sizeBytes: number }> {
    const { record, artifactFilename, safeFilePath } = this.#validateArtifactAccess(actor, jobId);
    let fileHandle: fs.FileHandle;
    try {
      fileHandle = await fs.open(safeFilePath, "r");
    } catch {
      this.#markArtifactExpired(record);
      throw new AppError("NOT_FOUND", "下载文件已过期清理，请重新下载。");
    }

    try {
      const stat = await fileHandle.stat();
      if (!stat.isFile()) {
        await fileHandle.close().catch(() => undefined);
        this.#markArtifactExpired(record);
        throw new AppError("NOT_FOUND", "下载文件不存在。");
      }
      return {
        fileHandle,
        downloadFilename: artifactFilename,
        sizeBytes: stat.size,
      };
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      if (isAppError(error)) throw error;
      this.#markArtifactExpired(record);
      throw new AppError("NOT_FOUND", "下载文件已过期清理，请重新下载。");
    }
  }

  async resolveOwnedArtifactFile(
    actor: ActorContext,
    jobId: string,
  ): Promise<{ filePath: string; downloadFilename: string; sizeBytes: number }> {
    const { record, artifactFilename, safeFilePath } = this.#validateArtifactAccess(actor, jobId);
    let sizeBytes = 0;
    try {
      const stat = await fs.stat(safeFilePath);
      if (!stat.isFile()) {
        this.#markArtifactExpired(record);
        throw new AppError("NOT_FOUND", "下载文件不存在。");
      }
      sizeBytes = stat.size;
    } catch (error) {
      if (isAppError(error)) throw error;
      this.#markArtifactExpired(record);
      throw new AppError("NOT_FOUND", "下载文件已过期清理，请重新下载。");
    }

    return { filePath: safeFilePath, downloadFilename: artifactFilename, sizeBytes };
  }

  #reconcileArtifactRecord<T extends StoredJobSummaryRecord | StoredJobRecord>(
    record: T,
    emitEvent: boolean,
  ): T {
    if (!hasLocalDownloadArtifactExpectation(record)) {
      return record;
    }
    let exists = false;
    try {
      const safePath = this.#resolveSafeArtifactPath(record.userId, record.id);
      exists = fsSync.statSync(safePath).isFile();
    } catch {
      exists = false;
    }
    if (exists) {
      return record;
    }
    const updated = this.#markArtifactExpired(record, emitEvent);
    return (updated ? { ...record, ...updated } : record) as T;
  }

  #markArtifactExpired(
    record: StoredJobSummaryRecord | StoredJobRecord,
    emitEvent = true,
  ): StoredJobRecord | null {
    if (record.artifactExpired || record.metadata?.artifactExpired) {
      return null;
    }
    const updated = this.#repo.update(record.id, {
      subtitle: "临时文件已过期，请重新下载",
      artifactExpired: true,
      metadata: {
        ...(record.metadata ?? {}),
        artifactExpired: true,
      },
    });
    if (updated && emitEvent) {
      this.#emit(record.userId, {
        type: "job_updated",
        job: toJobSummaryView(updated),
        serverRevision: updated.revision ?? 0,
        timestamp: updated.updatedAt,
      });
    }
    return updated;
  }

  #resolveSafeArtifactPath(userId: string, jobId: string): string {
    const safeUser = userId.replace(/[^a-zA-Z0-9_-]/g, "");
    const safeJob = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!safeUser || !safeJob) {
      throw new AppError("FORBIDDEN", "非法的临时文件路径。");
    }
    const target = path.resolve(this.#tmpDownloadsDir, safeUser, `${safeJob}.bin`);
    if (!target.startsWith(this.#tmpDownloadsDir + path.sep)) {
      throw new AppError("FORBIDDEN", "非法的临时文件路径。");
    }
    return target;
  }

  async #deleteArtifactById(userId: string, jobId: string): Promise<void> {
    const filePath = this.#resolveSafeArtifactPath(userId, jobId);
    await fs.unlink(filePath).catch(() => undefined);
  }

  async cleanupExpiredArtifacts(): Promise<void> {
    const now = Date.now();
    const userDirs = await fs.readdir(this.#tmpDownloadsDir).catch(() => []);
    for (const userDir of userDirs) {
      const dirPath = path.join(this.#tmpDownloadsDir, userDir);
      const files = await fs.readdir(dirPath).catch(() => []);
      for (const file of files) {
        const full = path.join(dirPath, file);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && now - stat.mtimeMs > ARTIFACT_TTL_MS) {
          await fs.unlink(full).catch(() => undefined);
          // J04: Synchronize DB state and SSE event when expired artifact is purged
          const jobId = file.replace(/\.bin$/i, "");
          const record = this.#repo.findRawSummaryById(jobId);
          if (record) {
            this.#markArtifactExpired(record, true);
          }
        }
      }
    }
    // J04: Also reconcile any DB download records whose local temp file was already removed externally
    for (const completed of this.#repo.listActiveCompletedDownloads()) {
      this.#reconcileArtifactRecord(completed, true);
    }
  }

  #countRunning(filter: { kind?: JobKind; userId?: string; isDownload?: boolean }): number {
    let count = 0;
    for (const entry of this.#runningControllers.values()) {
      if (filter.userId && entry.userId !== filter.userId) continue;
      if (filter.kind && entry.kind !== filter.kind) continue;
      if (filter.isDownload !== undefined && (entry.kind === "download") !== filter.isDownload) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  #drainQueue(): void {
    if (this.#stopped) return;
    for (let i = 0; i < this.#queue.length; ) {
      if (this.#stopped) break;
      const item = this.#queue[i];
      if (!item) break;

      const isDownload = item.record.kind === "download";
      const globalCap = isDownload ? this.#globalMaxDownload : this.#globalMaxGeneral;
      const globalRunning = this.#countRunning({ isDownload });
      const userRunning = this.#countRunning({ userId: item.record.userId, kind: item.record.kind });

      if (globalRunning < globalCap && userRunning < item.maxUserConcurrency) {
        this.#queue.splice(i, 1);
        void this.#execute(item);
      } else {
        i += 1;
      }
    }
  }

  async #execute(item: QueuedExecution): Promise<void> {
    if (this.#stopped) return;
    const { record, runner } = item;
    const controller = new AbortController();
    this.#runningControllers.set(record.id, {
      userId: record.userId,
      kind: record.kind,
      controller,
    });

    let lastPersistedProgress = 0;
    let lastPersistedSubtitle: string | undefined = record.subtitle;
    let lastPersistedAt = 0;
    const startRecord = this.#repo.update(
      record.id,
      { status: "running", progress: 1 },
      { expectedStatus: "queued" },
    );
    if (!startRecord) {
      this.#runningControllers.delete(record.id);
      return;
    }
    this.#emit(record.userId, {
      type: "job_updated",
      job: toJobSummaryView(startRecord),
      serverRevision: startRecord.revision ?? 0,
      timestamp: startRecord.updatedAt,
    });

    const handle: JobRuntimeHandle = {
      jobId: record.id,
      signal: controller.signal,
      updateProgress: (progress, subtitle) => {
        if (controller.signal.aborted || this.#stopped) return;
        const clamped = Math.min(99, Math.max(1, Math.round(progress)));
        const nextSubtitle = subtitle !== undefined ? subtitle : lastPersistedSubtitle;
        const progressChanged = clamped !== lastPersistedProgress;
        const subtitleChanged = nextSubtitle !== lastPersistedSubtitle;

        // J06: Skip completely unchanged progress/subtitle ticks, and throttle high-frequency updates
        if (!progressChanged && !subtitleChanged) {
          return;
        }
        const now = Date.now();
        if (
          lastPersistedAt > 0 &&
          Math.abs(clamped - lastPersistedProgress) < 4 &&
          now - lastPersistedAt < 500
        ) {
          return;
        }

        lastPersistedProgress = clamped;
        lastPersistedSubtitle = nextSubtitle;
        lastPersistedAt = now;
        const updated = this.#repo.update(
          record.id,
          {
            progress: clamped,
            ...(subtitle !== undefined ? { subtitle } : {}),
          },
          { expectedStatus: "running" },
        );
        if (updated) {
          this.#emit(record.userId, {
            type: "job_updated",
            job: toJobSummaryView(updated),
            serverRevision: updated.revision ?? 0,
            timestamp: now,
          });
        }
      },
      getArtifactPath: async (extension: string) => {
        const filePath = this.#resolveSafeArtifactPath(record.userId, record.id);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const cleanExt = extension.replace(/^\./, "").replace(/[^a-z0-9]/gi, "") || "mp3";
        return { filePath, artifactFilename: `${record.title}.${cleanExt}` };
      },
    };

    try {
      const outcome = await runner(handle);
      if (controller.signal.aborted || this.#stopped) {
        await this.#deleteArtifactById(record.userId, record.id);
        return;
      }

      // CAS guard: never overwrite a job that was cancelled/stopped concurrently
      const completed = this.#repo.update(
        record.id,
        {
          status: "completed",
          progress: 100,
          subtitle: outcome.subtitle ?? "已完成",
          result: outcome.result,
          artifactFilename: outcome.artifactFilename,
          directUrl: outcome.directUrl,
          metadata: outcome.metadata ?? record.metadata,
        },
        { expectedStatus: "running" },
      );
      if (!completed) {
        await this.#deleteArtifactById(record.userId, record.id);
        return;
      }
      this.#emit(record.userId, {
        type: "job_updated",
        job: toJobSummaryView(completed),
        serverRevision: completed.revision ?? 0,
        timestamp: completed.updatedAt,
      });
    } catch (error) {
      await this.#deleteArtifactById(record.userId, record.id);
      if (controller.signal.aborted || this.#stopped) {
        return;
      }
      const errorCode: ErrorCode = isAppError(error) ? error.code : "INTERNAL_ERROR";
      const errorMessage = error instanceof Error ? error.message : "后台任务执行失败";
      const failed = this.#repo.update(
        record.id,
        {
          status: "failed",
          progress: 0,
          errorCode,
          errorMessage,
          subtitle: "执行失败",
        },
        { expectedStatus: "running" },
      );
      if (failed) {
        this.#emit(record.userId, {
          type: "job_updated",
          job: toJobSummaryView(failed),
          serverRevision: failed.revision ?? 0,
          timestamp: failed.updatedAt,
        });
      }
    } finally {
      this.#runningControllers.delete(record.id);
      if (!this.#stopped) {
        this.#drainQueue();
      }
    }
  }
}
