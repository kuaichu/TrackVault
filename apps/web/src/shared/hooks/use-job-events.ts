import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { JobEventSchema, type JobKind, type JobStatus, type JobView, sanitizeExternalUrl } from "#shared";
import { api } from "../api/endpoints.js";
import { toast } from "../store/toast-store.js";

const MAX_PENDING_DIRECT_LINK_JOBS = 50;
const MAX_NOTIFIED_DIRECT_LINK_JOBS = 100;
const MAX_JOBS_PER_KIND_SNAPSHOT = 50;
const MAX_JOBS_UNFILTERED_SNAPSHOT = 100;

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);
const JOB_STAGE_RANK: Record<JobStatus, number> = {
  queued: 1,
  running: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

const pendingDirectLinkJobIds = new Set<string>();
const notifiedDirectLinkJobIds = new Set<string>();
const knownJobsByClient = new WeakMap<QueryClient, Map<string, JobView>>();

function getKnownJobsMap(queryClient: QueryClient): Map<string, JobView> {
  let map = knownJobsByClient.get(queryClient);
  if (!map) {
    map = new Map();
    knownJobsByClient.set(queryClient, map);
  }
  return map;
}

function recordNotifiedDirectLink(jobId: string): void {
  notifiedDirectLinkJobIds.add(jobId);
  if (notifiedDirectLinkJobIds.size > MAX_NOTIFIED_DIRECT_LINK_JOBS) {
    const oldest = notifiedDirectLinkJobIds.values().next().value;
    if (oldest) notifiedDirectLinkJobIds.delete(oldest);
  }
}

function notifyDirectLinkIfReady(job: JobView, fallbackTitle?: string): boolean {
  if (job.status === "completed") {
    pendingDirectLinkJobIds.delete(job.id);
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
    pendingDirectLinkJobIds.delete(job.id);
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

export function trackPendingDirectLinkJob(
  jobId: string,
  options?: { queryClient?: QueryClient; fallbackTitle?: string },
): boolean {
  if (!jobId) return false;

  // F17: If SSE already delivered completion before the POST /api/downloads HTTP response resolved,
  // fire the clickable direct-link toast immediately instead of stranding the job in pending set.
  if (options?.queryClient) {
    const known =
      getKnownJobsMap(options.queryClient).get(jobId) ??
      options.queryClient.getQueryData<{ job: JobView }>(["job", jobId])?.job ??
      options.queryClient
        .getQueryData<{ jobs: JobView[] }>(["jobs", "download"])
        ?.jobs.find((j) => j.id === jobId);

    if (known && notifyDirectLinkIfReady(known, options.fallbackTitle)) {
      return true;
    }
  }

  pendingDirectLinkJobIds.add(jobId);
  if (pendingDirectLinkJobIds.size > MAX_PENDING_DIRECT_LINK_JOBS) {
    const oldest = pendingDirectLinkJobIds.values().next().value;
    if (oldest) pendingDirectLinkJobIds.delete(oldest);
  }
  return false;
}

export function clearPendingDirectLinkJobs(): void {
  pendingDirectLinkJobIds.clear();
  notifiedDirectLinkJobIds.clear();
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

    const knownJobs = getKnownJobsMap(queryClient);
    let reconcilingCache = false;

    // F04 + F17: Reconcile any incoming ["jobs", ...] or ["job", id] query snapshot monotonically
    // and check if any pending direct-link job completed during an SSE outage/reconnect.
    const unsubscribeCache = queryClient.getQueryCache().subscribe((cacheEvent) => {
      if (reconcilingCache || cacheEvent.type !== "updated" || cacheEvent.action.type !== "success") {
        return;
      }
      const qKey = cacheEvent.query.queryKey;
      if (qKey[0] === "jobs") {
        const data = cacheEvent.query.state.data as { jobs?: JobView[] } | undefined;
        if (!data || !Array.isArray(data.jobs)) return;
        const maxLimit = getMaxListLimitForQueryKey(qKey);
        let changed = false;

        const mergedList = data.jobs.map((incoming) => {
          const singleCached = queryClient.getQueryData<{ job: JobView }>(["job", incoming.id])?.job;
          const baseline = mergeJobView(knownJobs.get(incoming.id), singleCached ?? incoming);
          const merged = mergeJobView(baseline, incoming);
          knownJobs.set(merged.id, merged);
          if (!isSameJobSnapshot(incoming, merged)) {
            changed = true;
          }
          if (pendingDirectLinkJobIds.has(merged.id)) {
            notifyDirectLinkIfReady(merged);
          }
          return merged;
        });

        const sorted = [...mergedList].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxLimit);
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
      } else if (qKey[0] === "job" && typeof qKey[1] === "string") {
        const data = cacheEvent.query.state.data as { job?: JobView } | undefined;
        if (!data?.job) return;
        const merged = mergeJobView(knownJobs.get(data.job.id), data.job);
        knownJobs.set(merged.id, merged);
        if (pendingDirectLinkJobIds.has(merged.id)) {
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
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      // F17: If pending direct-link jobs exist and no active ["jobs"] observer is mounted to refetch on invalidate,
      // fetch download jobs directly so missed SSE completions during disconnect still trigger the direct-link toast.
      if (pendingDirectLinkJobIds.size > 0) {
        const hasActiveObserver = queryClient
          .getQueryCache()
          .findAll({ queryKey: ["jobs"] })
          .some((q) => matchesJobListQuery(q.queryKey, "download") && q.getObserversCount() > 0);
        if (!hasActiveObserver) {
          void api
            .listJobs("download")
            .then((res) => {
              for (const job of res.jobs) {
                const merged = mergeJobView(knownJobs.get(job.id), job);
                knownJobs.set(merged.id, merged);
                if (pendingDirectLinkJobIds.has(merged.id)) {
                  notifyDirectLinkIfReady(merged);
                }
              }
            })
            .catch(() => undefined);
        }
      }
    };

    const handleOnline = () => {
      catchUpSnapshots();
    };
    window.addEventListener("online", handleOnline);

    if (typeof EventSource === "undefined") {
      return () => {
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
          const singleCached = queryClient.getQueryData<{ job: JobView }>(["job", payload.job.id])?.job;
          const baseline = mergeJobView(knownJobs.get(payload.job.id), singleCached ?? payload.job);
          const mergedJob = mergeJobView(baseline, payload.job);
          knownJobs.set(mergedJob.id, mergedJob);

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
                return { jobs: upsertJobIntoList(prev.jobs, mergedJob, maxLimit, knownJobs) };
              });
            }
            queryClient.setQueryData<{ job: JobView }>(["job", mergedJob.id], { job: mergedJob });
          } finally {
            reconcilingCache = false;
          }

          if (pendingDirectLinkJobIds.has(mergedJob.id)) {
            notifyDirectLinkIfReady(mergedJob);
          }
        } else if (payload.type === "job_removed" && payload.jobId) {
          const removedId = payload.jobId;
          pendingDirectLinkJobIds.delete(removedId);
          knownJobs.delete(removedId);
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
      es.close();
      unsubscribeCache();
      window.removeEventListener("online", handleOnline);
      clearPendingDirectLinkJobs();
    };
  }, [enabled, queryClient]);
}
