import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type JobDetailView,
  JobEventSchema,
  type JobKind,
  type JobStatus,
  type JobSummaryView,
  type JobView,
  type JobsListResponse,
} from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { subscribeSse } from "../../shared/api/sse-client.js";
import { toast } from "../../shared/store/toast-store.js";

export const MAX_JOBS_PER_KIND_SNAPSHOT = 50;
export const MAX_JOBS_UNFILTERED_SNAPSHOT = 100;
const MAX_REMOVED_JOB_TOMBSTONES = 500;
const MAX_KNOWN_JOBS_PER_CLIENT = 300;

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);
const JOB_STAGE_RANK: Record<JobStatus, number> = {
  queued: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

interface KnownJobEntry {
  job: JobView;
  sseClock: number;
  serverRevision?: number;
}

interface RemovedJobEntry {
  clock: number;
  serverRevision?: number;
}

export interface JobSyncObserver {
  onJobObserved?: (job: JobView, context: { source: "sse" | "list" | "detail" }) => void;
  onJobRemoved?: (jobId: string) => void;
  onCatchUp?: (hasActiveDownloadObserver: boolean, invalidatePromise: Promise<void>) => void;
  onDownloadListMissingIds?: (presentIds: Set<string>) => void;
}

interface ClientJobSyncState {
  clock: number;
  lastServerRevision: number;
  globalClearedRevision: number;
  globalClearedClock: number;
  clearedRevisionByKind: Map<JobKind, number>;
  clearedClockByKind: Map<JobKind, number>;
  knownJobs: Map<string, KnownJobEntry>;
  removedJobs: Map<string, RemovedJobEntry>;
  queryFetchStartClock: Map<string, number>;
  observers: Set<JobSyncObserver>;
}

const syncStateByClient = new WeakMap<QueryClient, ClientJobSyncState>();

function getClientJobSyncState(queryClient: QueryClient): ClientJobSyncState {
  let state = syncStateByClient.get(queryClient);
  if (!state) {
    state = {
      clock: 0,
      lastServerRevision: 0,
      globalClearedRevision: 0,
      globalClearedClock: 0,
      clearedRevisionByKind: new Map(),
      clearedClockByKind: new Map(),
      knownJobs: new Map(),
      removedJobs: new Map(),
      queryFetchStartClock: new Map(),
      observers: new Set(),
    };
    syncStateByClient.set(queryClient, state);
  }
  return state;
}

export function subscribeJobSyncEvents(queryClient: QueryClient, observer: JobSyncObserver): () => void {
  const state = getClientJobSyncState(queryClient);
  state.observers.add(observer);
  return () => {
    state.observers.delete(observer);
  };
}

export function nextJobSyncClock(queryClient: QueryClient): number {
  return ++getClientJobSyncState(queryClient).clock;
}

export function getKnownOrCachedJob(queryClient: QueryClient, jobId: string): JobView | undefined {
  const state = getClientJobSyncState(queryClient);
  return (
    state.knownJobs.get(jobId)?.job ??
    queryClient.getQueryData<{ job: JobView }>(["job", jobId])?.job ??
    queryClient.getQueryData<JobsListResponse>(["jobs", "download"])?.jobs.find((j) => j.id === jobId)
  );
}

export function isJobRemovedInSync(queryClient: QueryClient, jobId: string, minClock?: number): boolean {
  const removed = getClientJobSyncState(queryClient).removedJobs.get(jobId);
  if (!removed) return false;
  if (minClock !== undefined) {
    return removed.clock >= minClock;
  }
  return true;
}

export function recordKnownSyncedJob(
  queryClient: QueryClient,
  job: JobView,
  serverRevision?: number,
): JobView {
  const state = getClientJobSyncState(queryClient);
  const merged = mergeJobView(state.knownJobs.get(job.id)?.job, job);
  setBoundedKnownJob(state, merged, 0, serverRevision);
  return merged;
}

function setBoundedKnownJob(
  state: ClientJobSyncState,
  job: JobView,
  sseClock = 0,
  serverRevision?: number,
): void {
  const existing = state.knownJobs.get(job.id);
  if (existing) {
    state.knownJobs.delete(job.id);
  }
  state.knownJobs.set(job.id, {
    job,
    sseClock: sseClock > 0 ? sseClock : (existing?.sseClock ?? 0),
    serverRevision: serverRevision ?? existing?.serverRevision,
  });
  while (state.knownJobs.size > MAX_KNOWN_JOBS_PER_CLIENT) {
    const oldestId = state.knownJobs.keys().next().value;
    if (!oldestId) break;
    state.knownJobs.delete(oldestId);
  }
}

function recordRemovedTombstone(
  state: ClientJobSyncState,
  jobId: string,
  clock: number,
  serverRevision?: number,
): void {
  state.removedJobs.delete(jobId);
  state.removedJobs.set(jobId, { clock, serverRevision });
  while (state.removedJobs.size > MAX_REMOVED_JOB_TOMBSTONES) {
    const oldestId = state.removedJobs.keys().next().value;
    if (!oldestId) break;
    state.removedJobs.delete(oldestId);
  }
}

function preserveResult(winner: JobView, fallbackSource: JobView): JobView {
  if (winner.result !== undefined || fallbackSource.result === undefined) {
    return winner;
  }
  return { ...winner, result: fallbackSource.result };
}

/**
 * Monotonically merges two views of the same job using `revision` (when available)
 * with monotonic status/timestamp fallback, while preserving already-fetched detail `result`
 * when a lightweight summary event arrives.
 */
export function mergeJobView(current: JobView | undefined, incoming: JobView): JobView {
  if (!current || current.id !== incoming.id) return incoming;

  if (current.revision !== undefined && incoming.revision !== undefined) {
    if (incoming.revision < current.revision) {
      return current;
    }
    if (incoming.revision > current.revision) {
      return preserveResult(incoming, current);
    }
  }

  const curTerminal = TERMINAL_JOB_STATUSES.has(current.status);
  const incTerminal = TERMINAL_JOB_STATUSES.has(incoming.status);

  if (curTerminal && !incTerminal) return current;
  if (!curTerminal && incTerminal) return preserveResult(incoming, current);

  if (curTerminal && incTerminal) {
    if (current.artifactExpired && !incoming.artifactExpired) return current;
    if (!current.artifactExpired && incoming.artifactExpired) return preserveResult(incoming, current);
    if (incoming.updatedAt < current.updatedAt) return current;
    return preserveResult(incoming, current);
  }

  const curRank = JOB_STAGE_RANK[current.status];
  const incRank = JOB_STAGE_RANK[incoming.status];
  if (incRank !== curRank) {
    return incRank > curRank ? preserveResult(incoming, current) : current;
  }
  if (incoming.updatedAt !== current.updatedAt) {
    return incoming.updatedAt > current.updatedAt ? preserveResult(incoming, current) : current;
  }
  if (incoming.progress !== current.progress) {
    return incoming.progress > current.progress ? preserveResult(incoming, current) : current;
  }
  return preserveResult(incoming, current);
}

function getMaxListLimitForQueryKey(queryKey: readonly unknown[]): number {
  const kind = queryKey[1];
  return typeof kind === "string" ? MAX_JOBS_PER_KIND_SNAPSHOT : MAX_JOBS_UNFILTERED_SNAPSHOT;
}

/**
 * Inserts/updates a job in a cached list while maintaining `createdAt` DESC order
 * and enforcing the server snapshot cap (50 per-kind / 100 unfiltered).
 */
export function upsertJobIntoList(
  prevJobs: readonly JobSummaryView[],
  incoming: JobView,
  maxLimit: number,
  knownMap?: Map<string, JobView>,
): JobSummaryView[] {
  const existingIdx = prevJobs.findIndex((j) => j.id === incoming.id);
  const merged = mergeJobView(
    existingIdx >= 0 ? prevJobs[existingIdx] : knownMap?.get(incoming.id),
    incoming,
  );
  knownMap?.set(merged.id, merged);

  const combined =
    existingIdx >= 0 ? prevJobs.map((j, idx) => (idx === existingIdx ? merged : j)) : [...prevJobs, merged];

  combined.sort((a, b) => b.createdAt - a.createdAt);
  return combined.slice(0, maxLimit);
}

function isSameJobSnapshot(a: JobView, b: JobView): boolean {
  return (
    a === b ||
    (a.status === b.status &&
      a.progress === b.progress &&
      a.updatedAt === b.updatedAt &&
      a.revision === b.revision &&
      a.hasResult === b.hasResult &&
      a.subtitle === b.subtitle &&
      a.downloadReady === b.downloadReady &&
      Boolean(a.artifactExpired) === Boolean(b.artifactExpired) &&
      a.directUrl === b.directUrl &&
      a.result === b.result)
  );
}

function removeJobFromSyncState(
  state: ClientJobSyncState,
  jobId: string,
  clock: number,
  serverRevision?: number,
): void {
  recordRemovedTombstone(state, jobId, clock, serverRevision);
  state.knownJobs.delete(jobId);
  for (const observer of state.observers) {
    observer.onJobRemoved?.(jobId);
  }
}

function applyFinishedJobsCleared(
  queryClient: QueryClient,
  kind?: JobKind,
  clearedBeforeRevision?: number,
): void {
  const state = getClientJobSyncState(queryClient);
  const clearClock = ++state.clock;

  if (clearedBeforeRevision !== undefined) {
    state.lastServerRevision = Math.max(state.lastServerRevision, clearedBeforeRevision);
    if (kind) {
      const prev = state.clearedRevisionByKind.get(kind) ?? 0;
      state.clearedRevisionByKind.set(kind, Math.max(prev, clearedBeforeRevision));
    } else {
      state.globalClearedRevision = Math.max(state.globalClearedRevision, clearedBeforeRevision);
    }
  }
  if (kind) {
    state.clearedClockByKind.set(kind, clearClock);
  } else {
    state.globalClearedClock = clearClock;
  }

  const removedIds = new Set<string>();
  const shouldClearJob = (job: JobSummaryView) => {
    if ((kind && job.kind !== kind) || !TERMINAL_JOB_STATUSES.has(job.status)) {
      return false;
    }
    if (clearedBeforeRevision !== undefined && job.revision !== undefined) {
      return job.revision <= clearedBeforeRevision;
    }
    return true;
  };

  for (const [id, entry] of [...state.knownJobs]) {
    if (shouldClearJob(entry.job)) {
      removedIds.add(id);
      removeJobFromSyncState(state, id, clearClock, clearedBeforeRevision);
    }
  }

  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["jobs"] })) {
    const cached = query.state.data as JobsListResponse | undefined;
    if (!cached?.jobs) continue;
    let listChanged = false;
    const remaining: JobSummaryView[] = [];
    for (const job of cached.jobs) {
      if (shouldClearJob(job)) {
        removedIds.add(job.id);
        removeJobFromSyncState(state, job.id, clearClock, clearedBeforeRevision);
        listChanged = true;
      } else {
        remaining.push(job);
      }
    }
    if (listChanged) {
      queryClient.setQueryData<JobsListResponse>(query.queryKey, { ...cached, jobs: remaining });
    }
  }

  for (const removedId of removedIds) {
    queryClient.removeQueries({ queryKey: ["job", removedId], exact: true });
  }
}

function isJobClearedForSnapshot(
  state: ClientJobSyncState,
  job: JobSummaryView,
  snapshotServerRevision: number | undefined,
  fetchStartClock: number,
): boolean {
  if (!TERMINAL_JOB_STATUSES.has(job.status)) return false;

  if (snapshotServerRevision !== undefined) {
    const clearedRev = Math.max(state.globalClearedRevision, state.clearedRevisionByKind.get(job.kind) ?? 0);
    if (clearedRev > snapshotServerRevision) {
      return job.revision === undefined || job.revision <= clearedRev;
    }
    return false;
  }

  const clearedClock = Math.max(state.globalClearedClock, state.clearedClockByKind.get(job.kind) ?? 0);
  return clearedClock > fetchStartClock;
}

function isJobRemovedForSnapshot(
  state: ClientJobSyncState,
  jobId: string,
  snapshotServerRevision: number | undefined,
  fetchStartClock: number,
): boolean {
  const removed = state.removedJobs.get(jobId);
  if (!removed) return false;
  if (snapshotServerRevision !== undefined && removed.serverRevision !== undefined) {
    return removed.serverRevision >= snapshotServerRevision;
  }
  return removed.clock > fetchStartClock;
}

function matchesJobListQuery(queryKey: readonly unknown[], kind: JobKind): boolean {
  if (queryKey[0] !== "jobs") return false;
  return queryKey.length === 1 || queryKey[1] === undefined || queryKey[1] === kind;
}

export function useJobsQuery(kind?: JobKind) {
  return useQuery({
    queryKey: kind ? (["jobs", kind] as const) : (["jobs"] as const),
    queryFn: () => api.listJobs(kind),
  });
}

export function useJobDetailQuery(jobId: string, enabled = true) {
  return useQuery({
    queryKey: ["job", jobId] as const,
    queryFn: () => api.getJob(jobId),
    enabled: Boolean(jobId) && enabled,
  });
}

export function useClearFinishedJobsMutation(
  kind?: JobKind,
  options?: {
    onSuccess?: (res: { removedCount: number }, resolvedKind?: JobKind) => void;
    onError?: (err: unknown) => void;
  },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (overrideKind?: JobKind) => api.clearFinishedJobs(overrideKind ?? kind),
    onSuccess: (res, overrideKind) => {
      const resolvedKind = overrideKind ?? kind;
      applyFinishedJobsCleared(queryClient, resolvedKind);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (options?.onSuccess) {
        options.onSuccess(res, resolvedKind);
      } else {
        toast.success(`已清除 ${res.removedCount} 条记录`);
      }
    },
    onError: (err) => {
      if (options?.onError) {
        options.onError(err);
      } else {
        toast.error(err instanceof Error ? err.message : "清除记录失败");
      }
    },
  });
}

/**
 * Reconciles TanStack Query job caches (`["jobs"]` & `["job", id]`) with `/api/events` SSE updates
 * using `serverRevision`, `job.revision`, and `clearedBeforeRevision` (with monotonic fallback).
 */
export function useJobSync(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const clientState = getClientJobSyncState(queryClient);
    let reconcilingCache = false;

    const notifyJobObserved = (job: JobView, source: "sse" | "list" | "detail") => {
      for (const observer of clientState.observers) {
        observer.onJobObserved?.(job, { source });
      }
    };

    const unsubscribeCache = queryClient.getQueryCache().subscribe((cacheEvent) => {
      if (reconcilingCache || cacheEvent.type !== "updated") return;

      const qKey = cacheEvent.query.queryKey;
      if (cacheEvent.action.type === "fetch") {
        if (qKey[0] === "jobs" || qKey[0] === "job") {
          clientState.queryFetchStartClock.set(cacheEvent.query.queryHash, ++clientState.clock);
        }
        return;
      }

      if (cacheEvent.action.type === "error") {
        clientState.queryFetchStartClock.delete(cacheEvent.query.queryHash);
        return;
      }

      if (cacheEvent.action.type !== "success") return;

      if (qKey[0] === "jobs") {
        const fetchStartClock = clientState.queryFetchStartClock.get(cacheEvent.query.queryHash) ?? 0;
        clientState.queryFetchStartClock.delete(cacheEvent.query.queryHash);

        const data = cacheEvent.query.state.data as JobsListResponse | undefined;
        if (!data || !Array.isArray(data.jobs)) return;

        if (data.serverRevision !== undefined) {
          clientState.lastServerRevision = Math.max(clientState.lastServerRevision, data.serverRevision);
        }
        if (data.clearedBeforeRevision !== undefined) {
          clientState.globalClearedRevision = Math.max(
            clientState.globalClearedRevision,
            data.clearedBeforeRevision,
          );
        }

        const maxLimit = getMaxListLimitForQueryKey(qKey);
        const kindFilter = typeof qKey[1] === "string" ? (qKey[1] as JobKind) : undefined;
        let changed = false;

        const oldestSnapshotCreatedAt =
          data.jobs.length > 0 ? Math.min(...data.jobs.map((j) => j.createdAt)) : Number.NEGATIVE_INFINITY;
        const byId = new Map<string, JobView>();

        for (const incoming of data.jobs) {
          if (
            isJobRemovedForSnapshot(clientState, incoming.id, data.serverRevision, fetchStartClock) ||
            isJobClearedForSnapshot(clientState, incoming, data.serverRevision, fetchStartClock)
          ) {
            changed = true;
            continue;
          }
          const singleCached = queryClient.getQueryData<{ job: JobView }>(["job", incoming.id])?.job;
          const baseline = mergeJobView(
            clientState.knownJobs.get(incoming.id)?.job,
            singleCached ?? incoming,
          );
          const merged = mergeJobView(baseline, incoming);
          setBoundedKnownJob(clientState, merged, 0, data.serverRevision);
          if (!isSameJobSnapshot(incoming, merged)) {
            changed = true;
          }
          notifyJobObserved(merged, "list");
          byId.set(merged.id, merged);
        }

        for (const [knownId, entry] of [...clientState.knownJobs]) {
          if (byId.has(knownId)) continue;
          if (kindFilter && entry.job.kind !== kindFilter) continue;
          if (
            isJobRemovedForSnapshot(clientState, knownId, data.serverRevision, fetchStartClock) ||
            isJobClearedForSnapshot(clientState, entry.job, data.serverRevision, fetchStartClock)
          ) {
            clientState.knownJobs.delete(knownId);
            continue;
          }

          const isNewerThanSnapshot =
            data.serverRevision !== undefined && entry.serverRevision !== undefined
              ? entry.serverRevision > data.serverRevision
              : entry.sseClock > fetchStartClock;

          if (isNewerThanSnapshot) {
            byId.set(knownId, entry.job);
            changed = true;
          } else if (data.jobs.length < maxLimit || entry.job.createdAt > oldestSnapshotCreatedAt) {
            clientState.knownJobs.delete(knownId);
          }
        }

        const sorted = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxLimit);
        if (
          sorted.length !== data.jobs.length ||
          sorted.some((item, idx) => item.id !== data.jobs?.[idx]?.id)
        ) {
          changed = true;
        }

        if (changed) {
          reconcilingCache = true;
          try {
            queryClient.setQueryData<JobsListResponse>(qKey, { ...data, jobs: sorted });
          } finally {
            reconcilingCache = false;
          }
        }

        if (kindFilter === undefined || kindFilter === "download") {
          const presentIds = new Set(byId.keys());
          for (const observer of clientState.observers) {
            observer.onDownloadListMissingIds?.(presentIds);
          }
        }
      } else if (qKey[0] === "job" && typeof qKey[1] === "string") {
        const fetchStartClock = clientState.queryFetchStartClock.get(cacheEvent.query.queryHash) ?? 0;
        clientState.queryFetchStartClock.delete(cacheEvent.query.queryHash);

        const data = cacheEvent.query.state.data as { job?: JobDetailView } | undefined;
        if (!data?.job) return;

        if (isJobRemovedForSnapshot(clientState, data.job.id, data.job.revision, fetchStartClock)) {
          reconcilingCache = true;
          try {
            queryClient.removeQueries({ queryKey: qKey, exact: true });
          } finally {
            reconcilingCache = false;
          }
          return;
        }

        const merged = mergeJobView(clientState.knownJobs.get(data.job.id)?.job, data.job);
        setBoundedKnownJob(clientState, merged);
        notifyJobObserved(merged, "detail");
        if (!isSameJobSnapshot(data.job, merged)) {
          reconcilingCache = true;
          try {
            queryClient.setQueryData<{ job: JobDetailView }>(qKey, { job: merged });
          } finally {
            reconcilingCache = false;
          }
        }
      }
    });

    const catchUpSnapshots = () => {
      const invalidatePromise = queryClient.invalidateQueries({ queryKey: ["jobs"] });
      const hasActiveDownloadObserver = queryClient
        .getQueryCache()
        .findAll({ queryKey: ["jobs"] })
        .some((q) => matchesJobListQuery(q.queryKey, "download") && q.getObserversCount() > 0);
      for (const observer of clientState.observers) {
        observer.onCatchUp?.(hasActiveDownloadObserver, invalidatePromise);
      }
    };

    const unsubscribeSse = subscribeSse({
      url: "/api/events",
      withCredentials: true,
      onReconnect: catchUpSnapshots,
      onOnline: catchUpSnapshots,
      onMessage: (rawData) => {
        try {
          const parsed = JobEventSchema.safeParse(JSON.parse(rawData));
          if (!parsed.success) return;
          const payload = parsed.data;

          if (payload.serverRevision !== undefined) {
            clientState.lastServerRevision = Math.max(clientState.lastServerRevision, payload.serverRevision);
          }

          if (payload.type === "job_updated" && payload.job) {
            const sseClock = ++clientState.clock;
            clientState.removedJobs.delete(payload.job.id);

            const detailQuery = queryClient
              .getQueryCache()
              .find({ queryKey: ["job", payload.job.id], exact: true });
            const prevSingle = detailQuery?.state.data
              ? (detailQuery.state.data as { job?: JobView }).job
              : undefined;
            const prevKnown = clientState.knownJobs.get(payload.job.id)?.job;
            const baseline = mergeJobView(prevKnown, prevSingle ?? payload.job);
            const mergedJob = mergeJobView(baseline, payload.job);

            setBoundedKnownJob(clientState, mergedJob, sseClock, payload.serverRevision);

            const matchingQueries = queryClient.getQueryCache().findAll({
              queryKey: ["jobs"],
              predicate: (query) => matchesJobListQuery(query.queryKey, mergedJob.kind),
            });

            const listKnownMap = new Map<string, JobView>();
            for (const [id, entry] of clientState.knownJobs) {
              listKnownMap.set(id, entry.job);
            }

            reconcilingCache = true;
            try {
              for (const query of matchingQueries) {
                const maxLimit = getMaxListLimitForQueryKey(query.queryKey);
                queryClient.setQueryData<JobsListResponse>(query.queryKey, (prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    ...(payload.serverRevision !== undefined
                      ? { serverRevision: payload.serverRevision }
                      : {}),
                    jobs: upsertJobIntoList(prev.jobs, mergedJob, maxLimit, listKnownMap),
                  };
                });
              }
              queryClient.setQueryData<{ job: JobDetailView }>(["job", mergedJob.id], { job: mergedJob });
            } finally {
              reconcilingCache = false;
            }

            const shouldRefreshDetail =
              Boolean(detailQuery) &&
              payload.job.result === undefined &&
              (mergedJob.hasResult === true ||
                prevSingle?.result !== undefined ||
                mergedJob.kind !== "download") &&
              (!prevSingle ||
                !isSameJobSnapshot(prevSingle, mergedJob) ||
                (payload.job.revision !== undefined &&
                  (prevSingle.revision === undefined || payload.job.revision > prevSingle.revision)));

            if (shouldRefreshDetail) {
              void queryClient.invalidateQueries({ queryKey: ["job", mergedJob.id], exact: true });
            }

            notifyJobObserved(mergedJob, "sse");
          } else if (payload.type === "job_removed" && payload.jobId) {
            const removedId = payload.jobId;
            const clock = ++clientState.clock;
            removeJobFromSyncState(clientState, removedId, clock, payload.serverRevision);
            reconcilingCache = true;
            try {
              queryClient.setQueriesData<JobsListResponse>({ queryKey: ["jobs"] }, (prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  ...(payload.serverRevision !== undefined ? { serverRevision: payload.serverRevision } : {}),
                  jobs: prev.jobs.filter((j) => j.id !== removedId),
                };
              });
            } finally {
              reconcilingCache = false;
            }
            queryClient.removeQueries({ queryKey: ["job", removedId], exact: true });
          } else if (payload.type === "jobs_cleared") {
            reconcilingCache = true;
            try {
              applyFinishedJobsCleared(
                queryClient,
                payload.clearedKind,
                payload.clearedBeforeRevision ?? payload.serverRevision,
              );
            } finally {
              reconcilingCache = false;
            }
          }
        } catch {
          // Ignore malformed SSE frames
        }
      },
    });

    return () => {
      unsubscribeSse();
      unsubscribeCache();
    };
  }, [enabled, queryClient]);
}
