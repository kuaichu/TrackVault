import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { JobEventSchema, type JobKind, type JobStatus, type JobView, sanitizeExternalUrl } from "#shared";
import { api, subscribeJobHttpAttempts } from "../api/endpoints.js";
import { ApiClientError } from "../api/http-client.js";
import { toast } from "../store/toast-store.js";

const MAX_PENDING_DIRECT_LINK_JOBS = 50;
const MAX_NOTIFIED_DIRECT_LINK_JOBS = 100;
const MAX_REMOVED_JOB_TOMBSTONES = 500;
const MAX_KNOWN_JOBS_PER_CLIENT = 300;
const MAX_JOBS_PER_KIND_SNAPSHOT = 50;
const MAX_JOBS_UNFILTERED_SNAPSHOT = 100;
const MAX_DIRECT_LINK_PROBE_RETRIES = 3;
const DIRECT_LINK_PROBE_BASE_RETRY_MS = 450;

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);
const JOB_STAGE_RANK: Record<JobStatus, number> = {
  queued: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

const pendingDirectLinkJobs = new Map<string, string | undefined>();
const notifiedDirectLinkJobIds = new Set<string>();
const inFlightDirectLinkProbes = new Set<string>();
const directLinkProbeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const directLinkProbeAttempts = new Map<string, number>();
const activeDirectLinkProbers = new WeakMap<QueryClient, (jobId: string, resetRetries?: boolean) => void>();

interface ClientJobEventState {
  seq: number;
  knownJobs: Map<string, JobView>;
  sseUpdatedSeq: Map<string, number>;
  removedJobIds: Map<string, number>;
  queryFetchStartSeq: Map<string, number>;
}

const clientStateByQueryClient = new WeakMap<QueryClient, ClientJobEventState>();

function getClientJobState(queryClient: QueryClient): ClientJobEventState {
  let state = clientStateByQueryClient.get(queryClient);
  if (!state) {
    state = {
      seq: 0,
      knownJobs: new Map(),
      sseUpdatedSeq: new Map(),
      removedJobIds: new Map(),
      queryFetchStartSeq: new Map(),
    };
    clientStateByQueryClient.set(queryClient, state);
  }
  return state;
}

function clearRetryStateForJob(jobId: string): void {
  const existingTimer = directLinkProbeRetryTimers.get(jobId);
  if (existingTimer !== undefined) {
    globalThis.clearTimeout(existingTimer);
    directLinkProbeRetryTimers.delete(jobId);
  }
  directLinkProbeAttempts.delete(jobId);
}

function setBoundedKnownJob(state: ClientJobEventState, job: JobView): void {
  if (state.knownJobs.has(job.id)) {
    state.knownJobs.delete(job.id);
  }
  state.knownJobs.set(job.id, job);
  while (state.knownJobs.size > MAX_KNOWN_JOBS_PER_CLIENT) {
    const oldestId = state.knownJobs.keys().next().value;
    if (!oldestId) break;
    state.knownJobs.delete(oldestId);
    state.sseUpdatedSeq.delete(oldestId);
  }
}

function recordRemovedTombstone(state: ClientJobEventState, jobId: string, seq: number): void {
  state.removedJobIds.delete(jobId);
  state.removedJobIds.set(jobId, seq);
  while (state.removedJobIds.size > MAX_REMOVED_JOB_TOMBSTONES) {
    const oldestId = state.removedJobIds.keys().next().value;
    if (!oldestId) break;
    state.removedJobIds.delete(oldestId);
  }
}

function getMinActiveListFetchSeq(state: ClientJobEventState): number {
  let minSeq = Number.POSITIVE_INFINITY;
  for (const seq of state.queryFetchStartSeq.values()) {
    if (seq < minSeq) minSeq = seq;
  }
  return minSeq;
}

function recordNotifiedDirectLink(jobId: string): void {
  notifiedDirectLinkJobIds.add(jobId);
  if (notifiedDirectLinkJobIds.size > MAX_NOTIFIED_DIRECT_LINK_JOBS) {
    const oldest = notifiedDirectLinkJobIds.values().next().value;
    if (oldest) notifiedDirectLinkJobIds.delete(oldest);
  }
}

function notifyDirectLinkIfReady(job: JobView, explicitFallbackTitle?: string): boolean {
  const fallbackTitle = explicitFallbackTitle ?? pendingDirectLinkJobs.get(job.id);
  if (job.status === "completed") {
    pendingDirectLinkJobs.delete(job.id);
    clearRetryStateForJob(job.id);
    if (notifiedDirectLinkJobIds.has(job.id)) {
      return true;
    }
    const safeDirectUrl = sanitizeExternalUrl(job.directUrl);
    if (safeDirectUrl) {
      recordNotifiedDirectLink(job.id);
      toast.success(`直链已就绪：${job.title || fallbackTitle || "音频文件"}`, {
        action: { label: "打开直链", href: safeDirectUrl },
      });
    }
    return true;
  }
  if (job.status === "failed" || job.status === "cancelled") {
    pendingDirectLinkJobs.delete(job.id);
    clearRetryStateForJob(job.id);
    return true;
  }
  return false;
}

/**
 * F04: Monotonically merges two views of the same job so a late `queued`/`running` snapshot
 * can NEVER overwrite an already-received terminal (`completed`/`failed`/`cancelled`) state.
 */
export function mergeJobView(current: JobView | undefined, incoming: JobView): JobView {
  if (!current || current.id !== incoming.id) return incoming;

  const curTerminal = TERMINAL_JOB_STATUSES.has(current.status);
  const incTerminal = TERMINAL_JOB_STATUSES.has(incoming.status);

  if (curTerminal && !incTerminal) {
    return current;
  }
  if (!curTerminal && incTerminal) {
    return incoming;
  }

  // Both terminal: artifact expiration is strictly monotonic (false -> true)
  if (curTerminal && incTerminal) {
    if (current.artifactExpired && !incoming.artifactExpired) {
      return current;
    }
    if (!current.artifactExpired && incoming.artifactExpired) {
      return incoming;
    }
    if (incoming.updatedAt < current.updatedAt) {
      return current;
    }
    return incoming;
  }

  // Both non-terminal (queued / running)
  const curRank = JOB_STAGE_RANK[current.status];
  const incRank = JOB_STAGE_RANK[incoming.status];
  if (incRank !== curRank) {
    return incRank > curRank ? incoming : current;
  }
  if (incoming.updatedAt !== current.updatedAt) {
    return incoming.updatedAt > current.updatedAt ? incoming : current;
  }
  if (incoming.progress !== current.progress) {
    return incoming.progress > current.progress ? incoming : current;
  }
  return incoming;
}

function getMaxListLimitForQueryKey(queryKey: readonly unknown[]): number {
  const kind = queryKey[1];
  return typeof kind === "string" ? MAX_JOBS_PER_KIND_SNAPSHOT : MAX_JOBS_UNFILTERED_SNAPSHOT;
}

/**
 * F03 + F04: Inserts/updates a job in a cached list while maintaining `createdAt` DESC order
 * and enforcing the server snapshot cap (50 per-kind / 100 unfiltered).
 */
export function upsertJobIntoList(
  prevJobs: readonly JobView[],
  incoming: JobView,
  maxLimit: number,
  knownMap?: Map<string, JobView>,
): JobView[] {
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
      a.subtitle === b.subtitle &&
      a.downloadReady === b.downloadReady &&
      Boolean(a.artifactExpired) === Boolean(b.artifactExpired) &&
      a.directUrl === b.directUrl &&
      a.result === b.result)
  );
}

function isPermanentProbeError(err: unknown): boolean {
  if (err instanceof ApiClientError) {
    return (
      err.status === 404 ||
      err.status === 400 ||
      err.status === 401 ||
      err.status === 403 ||
      err.code === "NOT_FOUND"
    );
  }
  if (err && typeof err === "object") {
    const status = (err as { status?: unknown }).status;
    const code = (err as { code?: unknown }).code;
    return status === 404 || status === 400 || status === 401 || status === 403 || code === "NOT_FOUND";
  }
  return false;
}

/**
 * F04: Marks the start sequence of an individual HTTP attempt (including automatic TanStack Query retries,
 * which do not emit a new QueryCache `fetch` event after an initial 503 failure).
 */
export function markJobQueryAttemptStart(queryClient: QueryClient, queryKey: readonly unknown[]): void {
  const state = getClientJobState(queryClient);
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) return;
  if (query.state.fetchFailureCount > 0 || !state.queryFetchStartSeq.has(query.queryHash)) {
    state.queryFetchStartSeq.set(query.queryHash, ++state.seq);
  }
}

export function trackPendingDirectLinkJob(
  jobId: string,
  options?: { queryClient?: QueryClient; fallbackTitle?: string },
): boolean {
  if (!jobId) return false;

  // F17: If SSE already delivered completion before the POST /api/downloads HTTP response resolved,
  // fire the clickable direct-link toast immediately instead of stranding the job in pending set.
  if (options?.queryClient) {
    const state = getClientJobState(options.queryClient);
    if (state.removedJobIds.has(jobId)) {
      return true;
    }
    const known =
      state.knownJobs.get(jobId) ??
      options.queryClient.getQueryData<{ job: JobView }>(["job", jobId])?.job ??
      options.queryClient
        .getQueryData<{ jobs: JobView[] }>(["jobs", "download"])
        ?.jobs.find((j) => j.id === jobId);

    if (known && notifyDirectLinkIfReady(known, options.fallbackTitle)) {
      return true;
    }
  }

  if (pendingDirectLinkJobs.has(jobId)) {
    pendingDirectLinkJobs.delete(jobId);
  }
  pendingDirectLinkJobs.set(jobId, options?.fallbackTitle);
  while (pendingDirectLinkJobs.size > MAX_PENDING_DIRECT_LINK_JOBS) {
    const oldest = pendingDirectLinkJobs.keys().next().value;
    if (!oldest) break;
    pendingDirectLinkJobs.delete(oldest);
    clearRetryStateForJob(oldest);
  }

  // F17: If the POST 202 acknowledgement arrived late (after a reconnect already filled the 50-item download
  // list with newer jobs), probe this older job ID immediately rather than waiting for another reconnect.
  if (options?.queryClient) {
    const cachedList = options.queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs;
    if (
      cachedList &&
      cachedList.length >= MAX_JOBS_PER_KIND_SNAPSHOT &&
      !cachedList.some((j) => j.id === jobId)
    ) {
      activeDirectLinkProbers.get(options.queryClient)?.(jobId, true);
    }
  }

  return false;
}

export function clearPendingDirectLinkJobs(): void {
  pendingDirectLinkJobs.clear();
  notifiedDirectLinkJobIds.clear();
  inFlightDirectLinkProbes.clear();
  for (const timer of directLinkProbeRetryTimers.values()) {
    globalThis.clearTimeout(timer);
  }
  directLinkProbeRetryTimers.clear();
  directLinkProbeAttempts.clear();
}

function matchesJobListQuery(queryKey: readonly unknown[], kind: JobKind): boolean {
  if (queryKey[0] !== "jobs") return false;
  return queryKey.length === 1 || queryKey[1] === undefined || queryKey[1] === kind;
}

/**
 * Connects a single SSE EventSource to `/api/events` and patches TanStack Query job caches in real time,
 * strictly partitioned by job kind with monotonic snapshot/SSE reconciliation and direct-link completion toasts.
 */
export function useJobEvents(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      clearPendingDirectLinkJobs();
      return;
    }

    const clientState = getClientJobState(queryClient);
    let reconcilingCache = false;
    let disposed = false;

    const probeSinglePendingDirectLink = (jobId: string, resetRetries = false) => {
      if (disposed || !pendingDirectLinkJobs.has(jobId)) {
        clearRetryStateForJob(jobId);
        return;
      }
      if (clientState.removedJobIds.has(jobId)) {
        pendingDirectLinkJobs.delete(jobId);
        clearRetryStateForJob(jobId);
        return;
      }
      if (resetRetries) {
        directLinkProbeAttempts.delete(jobId);
      }
      if (inFlightDirectLinkProbes.has(jobId)) {
        return;
      }
      const existingTimer = directLinkProbeRetryTimers.get(jobId);
      if (existingTimer !== undefined) {
        globalThis.clearTimeout(existingTimer);
        directLinkProbeRetryTimers.delete(jobId);
      }

      inFlightDirectLinkProbes.add(jobId);
      void api
        .getJob(jobId)
        .then((res) => {
          if (disposed) return;
          directLinkProbeAttempts.delete(jobId);
          if (!res?.job || clientState.removedJobIds.has(jobId)) {
            pendingDirectLinkJobs.delete(jobId);
            clearRetryStateForJob(jobId);
            return;
          }
          const merged = mergeJobView(clientState.knownJobs.get(res.job.id), res.job);
          setBoundedKnownJob(clientState, merged);
          notifyDirectLinkIfReady(merged);
        })
        .catch((err) => {
          if (isPermanentProbeError(err)) {
            pendingDirectLinkJobs.delete(jobId);
            clearRetryStateForJob(jobId);
            return;
          }
          // F17: Bounded retry on transient 503 / network failure while connection remains active
          if (!disposed && pendingDirectLinkJobs.has(jobId)) {
            const attempt = (directLinkProbeAttempts.get(jobId) ?? 0) + 1;
            if (attempt <= MAX_DIRECT_LINK_PROBE_RETRIES) {
              directLinkProbeAttempts.set(jobId, attempt);
              const delayMs = DIRECT_LINK_PROBE_BASE_RETRY_MS * 2 ** (attempt - 1);
              const timer = globalThis.setTimeout(() => {
                directLinkProbeRetryTimers.delete(jobId);
                probeSinglePendingDirectLink(jobId);
              }, delayMs);
              directLinkProbeRetryTimers.set(jobId, timer);
            }
          }
        })
        .finally(() => {
          inFlightDirectLinkProbes.delete(jobId);
        });
    };

    const verifyRemainingPendingDirectLinks = (resetRetries = false) => {
      if (disposed || pendingDirectLinkJobs.size === 0) return;
      for (const jobId of [...pendingDirectLinkJobs.keys()]) {
        probeSinglePendingDirectLink(jobId, resetRetries);
      }
    };

    activeDirectLinkProbers.set(queryClient, probeSinglePendingDirectLink);

    // F04: Update attempt start sequence whenever TanStack Query's Retryer dispatches an automatic retry attempt
    const unsubscribeHttpAttempts = subscribeJobHttpAttempts((attemptEvent) => {
      if (disposed) return;
      for (const query of queryClient.getQueryCache().getAll()) {
        const qKey = query.queryKey;
        const matchesList =
          attemptEvent.type === "list" &&
          qKey[0] === "jobs" &&
          (qKey[1] === attemptEvent.kind || (qKey.length === 1 && attemptEvent.kind === undefined));
        const matchesSingle =
          attemptEvent.type === "single" && qKey[0] === "job" && qKey[1] === attemptEvent.id;
        if (
          (matchesList || matchesSingle) &&
          query.state.fetchStatus === "fetching" &&
          query.state.fetchFailureCount > 0
        ) {
          clientState.queryFetchStartSeq.set(query.queryHash, ++clientState.seq);
        }
      }
    });

    // Seed in-flight list/job queries that may have started before subscription
    for (const q of queryClient.getQueryCache().getAll()) {
      const qKey = q.queryKey;
      if ((qKey[0] === "jobs" || qKey[0] === "job") && q.state.fetchStatus === "fetching") {
        if (!clientState.queryFetchStartSeq.has(q.queryHash)) {
          clientState.queryFetchStartSeq.set(q.queryHash, clientState.seq);
        }
      }
    }

    // F04 + F17: Track query fetch start sequence and reconcile incoming ["jobs", ...] or ["job", id] snapshots
    // monotonically against in-flight SSE job_updated / job_removed events.
    const unsubscribeCache = queryClient.getQueryCache().subscribe((cacheEvent) => {
      if (reconcilingCache || cacheEvent.type !== "updated") {
        return;
      }

      const qKey = cacheEvent.query.queryKey;
      if (cacheEvent.action.type === "fetch") {
        if (qKey[0] === "jobs" || qKey[0] === "job") {
          clientState.queryFetchStartSeq.set(cacheEvent.query.queryHash, ++clientState.seq);
        }
        return;
      }

      if (cacheEvent.action.type === "error") {
        clientState.queryFetchStartSeq.delete(cacheEvent.query.queryHash);
        return;
      }

      if (cacheEvent.action.type !== "success") {
        return;
      }

      if (qKey[0] === "jobs") {
        const fetchStartSeq = clientState.queryFetchStartSeq.get(cacheEvent.query.queryHash) ?? 0;
        clientState.queryFetchStartSeq.delete(cacheEvent.query.queryHash);

        const data = cacheEvent.query.state.data as { jobs?: JobView[] } | undefined;
        if (!data || !Array.isArray(data.jobs)) return;
        const maxLimit = getMaxListLimitForQueryKey(qKey);
        const kindFilter = typeof qKey[1] === "string" ? (qKey[1] as JobKind) : undefined;
        let changed = false;

        const rawSnapshotIds = new Set(data.jobs.map((j) => j.id));
        const oldestSnapshotCreatedAt =
          data.jobs.length > 0 ? Math.min(...data.jobs.map((j) => j.createdAt)) : Number.NEGATIVE_INFINITY;
        const byId = new Map<string, JobView>();

        // 1) Filter out removed tombstones and 2) monotonically merge remaining items with knownJobs / ["job", id]
        for (const incoming of data.jobs) {
          if (clientState.removedJobIds.has(incoming.id)) {
            changed = true;
            continue;
          }
          const singleCached = queryClient.getQueryData<{ job: JobView }>(["job", incoming.id])?.job;
          const baseline = mergeJobView(clientState.knownJobs.get(incoming.id), singleCached ?? incoming);
          const merged = mergeJobView(baseline, incoming);
          setBoundedKnownJob(clientState, merged);
          if (!isSameJobSnapshot(incoming, merged)) {
            changed = true;
          }
          if (pendingDirectLinkJobs.has(merged.id)) {
            notifyDirectLinkIfReady(merged);
          }
          byId.set(merged.id, merged);
        }

        // 3) Merge in any knownJobs matching kindFilter (and not removed) that arrived/updated via SSE
        // while THIS HTTP attempt was in-flight (lastSseSeq > fetchStartSeq) and were missed by the stale snapshot;
        // evict knownJobs confirmed absent by a newer post-SSE snapshot.
        for (const [knownId, knownJob] of [...clientState.knownJobs]) {
          if (byId.has(knownId) || clientState.removedJobIds.has(knownId)) continue;
          if (kindFilter && knownJob.kind !== kindFilter) continue;
          const lastSseSeq = clientState.sseUpdatedSeq.get(knownId) ?? 0;
          if (lastSseSeq > fetchStartSeq) {
            byId.set(knownId, knownJob);
            changed = true;
          } else if (data.jobs.length < maxLimit || knownJob.createdAt > oldestSnapshotCreatedAt) {
            clientState.knownJobs.delete(knownId);
            clientState.sseUpdatedSeq.delete(knownId);
          }
        }

        // Bounded cleanup: prune old tombstones that a post-removal snapshot has already confirmed absent,
        // provided no older list query is still in flight.
        const minActiveFetchSeq = getMinActiveListFetchSeq(clientState);
        for (const [removedId, removedSeq] of clientState.removedJobIds) {
          if (
            fetchStartSeq > removedSeq &&
            removedSeq < minActiveFetchSeq &&
            !rawSnapshotIds.has(removedId)
          ) {
            clientState.removedJobIds.delete(removedId);
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
            queryClient.setQueryData<{ jobs: JobView[] }>(qKey, { jobs: sorted });
          } finally {
            reconcilingCache = false;
          }
        }

        // F17: Whenever a download job list snapshot completes and a registered pending direct-link ID is absent
        // from that list (e.g. pushed past top 50 when its 202 acknowledgement arrived after reconnect), probe it!
        if ((kindFilter === undefined || kindFilter === "download") && pendingDirectLinkJobs.size > 0) {
          for (const pendingId of [...pendingDirectLinkJobs.keys()]) {
            if (!byId.has(pendingId)) {
              probeSinglePendingDirectLink(pendingId);
            }
          }
        }
      } else if (qKey[0] === "job" && typeof qKey[1] === "string") {
        const fetchStartSeq = clientState.queryFetchStartSeq.get(cacheEvent.query.queryHash) ?? 0;
        clientState.queryFetchStartSeq.delete(cacheEvent.query.queryHash);

        const data = cacheEvent.query.state.data as { job?: JobView } | undefined;
        if (!data?.job) return;

        const removedSeq = clientState.removedJobIds.get(data.job.id);
        if (removedSeq !== undefined && removedSeq > fetchStartSeq) {
          reconcilingCache = true;
          try {
            queryClient.removeQueries({ queryKey: qKey, exact: true });
          } finally {
            reconcilingCache = false;
          }
          return;
        }

        const merged = mergeJobView(clientState.knownJobs.get(data.job.id), data.job);
        setBoundedKnownJob(clientState, merged);
        if (pendingDirectLinkJobs.has(merged.id)) {
          notifyDirectLinkIfReady(merged);
        }
        if (!isSameJobSnapshot(data.job, merged)) {
          reconcilingCache = true;
          try {
            queryClient.setQueryData<{ job: JobView }>(qKey, { job: merged });
          } finally {
            reconcilingCache = false;
          }
        }
      }
    });

    const catchUpSnapshots = () => {
      const invalidatePromise = queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (pendingDirectLinkJobs.size === 0) {
        return;
      }

      const hasActiveDownloadObserver = queryClient
        .getQueryCache()
        .findAll({ queryKey: ["jobs"] })
        .some((q) => matchesJobListQuery(q.queryKey, "download") && q.getObserversCount() > 0);

      if (hasActiveDownloadObserver) {
        // Wait for the active list refetch to settle recent items first, then individually probe any
        // older pending direct-link jobs pushed beyond the 50-item list cap (F17).
        void invalidatePromise.finally(() => {
          verifyRemainingPendingDirectLinks(true);
        });
      } else {
        void api
          .listJobs("download")
          .then((res) => {
            if (disposed) return;
            for (const job of res.jobs) {
              if (clientState.removedJobIds.has(job.id)) continue;
              const merged = mergeJobView(clientState.knownJobs.get(job.id), job);
              setBoundedKnownJob(clientState, merged);
              if (pendingDirectLinkJobs.has(merged.id)) {
                notifyDirectLinkIfReady(merged);
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            verifyRemainingPendingDirectLinks(true);
          });
      }
    };

    const handleOnline = () => {
      catchUpSnapshots();
    };
    window.addEventListener("online", handleOnline);

    if (typeof EventSource === "undefined") {
      return () => {
        disposed = true;
        activeDirectLinkProbers.delete(queryClient);
        unsubscribeHttpAttempts();
        unsubscribeCache();
        window.removeEventListener("online", handleOnline);
        clearPendingDirectLinkJobs();
      };
    }

    let hasOpenedOnce = false;
    let hadError = false;

    const es = new EventSource("/api/events", { withCredentials: true });

    es.onopen = () => {
      if (hasOpenedOnce || hadError) {
        hadError = false;
        catchUpSnapshots();
      }
      hasOpenedOnce = true;
    };

    es.onerror = () => {
      hadError = true;
    };

    es.onmessage = (event) => {
      try {
        const parsed = JobEventSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) return;
        const payload = parsed.data;

        if (payload.type === "job_updated" && payload.job) {
          const seq = ++clientState.seq;
          clientState.removedJobIds.delete(payload.job.id);
          clientState.sseUpdatedSeq.set(payload.job.id, seq);

          const singleCached = queryClient.getQueryData<{ job: JobView }>(["job", payload.job.id])?.job;
          const baseline = mergeJobView(
            clientState.knownJobs.get(payload.job.id),
            singleCached ?? payload.job,
          );
          const mergedJob = mergeJobView(baseline, payload.job);
          setBoundedKnownJob(clientState, mergedJob);

          const matchingQueries = queryClient.getQueryCache().findAll({
            queryKey: ["jobs"],
            predicate: (query) => matchesJobListQuery(query.queryKey, mergedJob.kind),
          });

          reconcilingCache = true;
          try {
            for (const query of matchingQueries) {
              const maxLimit = getMaxListLimitForQueryKey(query.queryKey);
              queryClient.setQueryData<{ jobs: JobView[] }>(query.queryKey, (prev) => {
                if (!prev) return prev;
                return { jobs: upsertJobIntoList(prev.jobs, mergedJob, maxLimit, clientState.knownJobs) };
              });
            }
            queryClient.setQueryData<{ job: JobView }>(["job", mergedJob.id], { job: mergedJob });
          } finally {
            reconcilingCache = false;
          }

          if (pendingDirectLinkJobs.has(mergedJob.id)) {
            notifyDirectLinkIfReady(mergedJob);
          }
        } else if (payload.type === "job_removed" && payload.jobId) {
          const removedId = payload.jobId;
          const seq = ++clientState.seq;
          recordRemovedTombstone(clientState, removedId, seq);
          pendingDirectLinkJobs.delete(removedId);
          clearRetryStateForJob(removedId);
          clientState.knownJobs.delete(removedId);
          clientState.sseUpdatedSeq.delete(removedId);
          reconcilingCache = true;
          try {
            queryClient.setQueriesData<{ jobs: JobView[] }>({ queryKey: ["jobs"] }, (prev) => {
              if (!prev) return prev;
              return { jobs: prev.jobs.filter((j) => j.id !== removedId) };
            });
          } finally {
            reconcilingCache = false;
          }
          queryClient.removeQueries({ queryKey: ["job", removedId], exact: true });
        }
      } catch {
        // Ignore malformed SSE frames
      }
    };

    return () => {
      disposed = true;
      es.close();
      activeDirectLinkProbers.delete(queryClient);
      unsubscribeHttpAttempts();
      unsubscribeCache();
      window.removeEventListener("online", handleOnline);
      clearPendingDirectLinkJobs();
    };
  }, [enabled, queryClient]);
}
