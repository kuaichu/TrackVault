import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { type JobView, sanitizeExternalUrl } from "#shared";
import {
  MAX_JOBS_PER_KIND_SNAPSHOT,
  getKnownOrCachedJob,
  isJobRemovedInSync,
  nextJobSyncClock,
  recordKnownSyncedJob,
  subscribeJobSyncEvents,
  useJobSync,
} from "../../entities/job/index.js";
import { api } from "../../shared/api/endpoints.js";
import { ApiClientError } from "../../shared/api/http-client.js";
import { toast } from "../../shared/store/toast-store.js";

const MAX_PENDING_DIRECT_LINK_JOBS = 50;
const MAX_NOTIFIED_DIRECT_LINK_JOBS = 100;
const MAX_DIRECT_LINK_PROBE_RETRIES = 3;
const DIRECT_LINK_PROBE_BASE_RETRY_MS = 450;

interface DirectLinkClientState {
  pendingJobs: Map<string, string | undefined>;
  notifiedJobIds: Set<string>;
  inFlightProbes: Set<string>;
  probeRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  probeAttempts: Map<string, number>;
  activeProber: ((jobId: string, resetRetries?: boolean) => void) | null;
  activeHookCount: number;
}

const directLinkStateByClient = new WeakMap<QueryClient, DirectLinkClientState>();
const trackedStates = new Set<DirectLinkClientState>();

function getDirectLinkState(queryClient: QueryClient): DirectLinkClientState {
  let state = directLinkStateByClient.get(queryClient);
  if (!state) {
    state = {
      pendingJobs: new Map(),
      notifiedJobIds: new Set(),
      inFlightProbes: new Set(),
      probeRetryTimers: new Map(),
      probeAttempts: new Map(),
      activeProber: null,
      activeHookCount: 0,
    };
    directLinkStateByClient.set(queryClient, state);
  }
  trackedStates.add(state);
  return state;
}

function clearRetryStateForJob(state: DirectLinkClientState, jobId: string): void {
  const existingTimer = state.probeRetryTimers.get(jobId);
  if (existingTimer !== undefined) {
    globalThis.clearTimeout(existingTimer);
    state.probeRetryTimers.delete(jobId);
  }
  state.probeAttempts.delete(jobId);
}

function recordNotifiedDirectLink(state: DirectLinkClientState, jobId: string): void {
  state.notifiedJobIds.add(jobId);
  if (state.notifiedJobIds.size > MAX_NOTIFIED_DIRECT_LINK_JOBS) {
    const oldest = state.notifiedJobIds.values().next().value;
    if (oldest) state.notifiedJobIds.delete(oldest);
  }
}

function notifyDirectLinkIfReady(
  state: DirectLinkClientState,
  job: JobView,
  explicitFallbackTitle?: string,
): boolean {
  const fallbackTitle = explicitFallbackTitle ?? state.pendingJobs.get(job.id);
  if (job.status === "completed") {
    state.pendingJobs.delete(job.id);
    clearRetryStateForJob(state, job.id);
    if (state.notifiedJobIds.has(job.id)) {
      return true;
    }
    const safeDirectUrl = sanitizeExternalUrl(job.directUrl);
    if (safeDirectUrl) {
      recordNotifiedDirectLink(state, job.id);
      toast.success(`直链已就绪：${job.title || fallbackTitle || "音频文件"}`, {
        action: { label: "打开直链", href: safeDirectUrl },
      });
    }
    return true;
  }
  if (job.status === "failed" || job.status === "cancelled") {
    state.pendingJobs.delete(job.id);
    clearRetryStateForJob(state, job.id);
    return true;
  }
  return false;
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

export function registerPendingDirectLinkJob(
  jobId: string,
  options?: { queryClient?: QueryClient; fallbackTitle?: string },
): boolean;
export function registerPendingDirectLinkJob(
  queryClient: QueryClient,
  jobId: string,
  fallbackTitle?: string,
): boolean;
export function registerPendingDirectLinkJob(
  jobIdOrClient: string | QueryClient,
  optionsOrJobId?: { queryClient?: QueryClient; fallbackTitle?: string } | string,
  maybeFallbackTitle?: string,
): boolean {
  const jobId = typeof jobIdOrClient === "string" ? jobIdOrClient : (optionsOrJobId as string);
  const queryClient =
    typeof jobIdOrClient === "string"
      ? (optionsOrJobId as { queryClient?: QueryClient } | undefined)?.queryClient
      : jobIdOrClient;
  const fallbackTitle =
    typeof jobIdOrClient === "string"
      ? (optionsOrJobId as { fallbackTitle?: string } | undefined)?.fallbackTitle
      : maybeFallbackTitle;

  if (!jobId) return false;

  const targetStates = queryClient
    ? [getDirectLinkState(queryClient)]
    : [...trackedStates].filter((s) => s.activeHookCount > 0);

  if (targetStates.length === 0) {
    return false;
  }

  for (const state of targetStates) {
    if (queryClient) {
      if (isJobRemovedInSync(queryClient, jobId)) {
        return true;
      }
      const known = getKnownOrCachedJob(queryClient, jobId);
      if (known && notifyDirectLinkIfReady(state, known, fallbackTitle)) {
        return true;
      }
    }

    if (state.pendingJobs.has(jobId)) {
      state.pendingJobs.delete(jobId);
    }
    state.pendingJobs.set(jobId, fallbackTitle);

    while (state.pendingJobs.size > MAX_PENDING_DIRECT_LINK_JOBS) {
      const oldest = state.pendingJobs.keys().next().value;
      if (!oldest) break;
      state.pendingJobs.delete(oldest);
      clearRetryStateForJob(state, oldest);
    }

    if (queryClient) {
      const cachedList = queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs;
      if (
        cachedList &&
        cachedList.length >= MAX_JOBS_PER_KIND_SNAPSHOT &&
        !cachedList.some((j) => j.id === jobId)
      ) {
        state.activeProber?.(jobId, true);
      }
    }
  }

  return false;
}

export const trackPendingDirectLinkJob = registerPendingDirectLinkJob;

function clearDirectLinkState(state: DirectLinkClientState): void {
  state.pendingJobs.clear();
  state.notifiedJobIds.clear();
  state.inFlightProbes.clear();
  for (const timer of state.probeRetryTimers.values()) {
    globalThis.clearTimeout(timer);
  }
  state.probeRetryTimers.clear();
  state.probeAttempts.clear();
}

export function clearPendingDirectLinkJobs(queryClient?: QueryClient): void {
  if (queryClient) {
    const state = directLinkStateByClient.get(queryClient);
    if (!state) return;
    clearDirectLinkState(state);
    if (state.activeHookCount <= 0) {
      trackedStates.delete(state);
      directLinkStateByClient.delete(queryClient);
    }
    return;
  }

  for (const state of [...trackedStates]) {
    clearDirectLinkState(state);
    if (state.activeHookCount <= 0) {
      trackedStates.delete(state);
    }
  }
}

/**
 * Coordinates job cache synchronization (`entities/job`) with direct-link completion polling
 * and ready notifications (`features/downloads`).
 */
export function useJobEvents(enabled: boolean): void {
  const queryClient = useQueryClient();

  useJobSync(enabled);

  useEffect(() => {
    if (!enabled) {
      clearPendingDirectLinkJobs(queryClient);
      return;
    }

    const dlState = getDirectLinkState(queryClient);
    dlState.activeHookCount += 1;
    let disposed = false;

    const probeSinglePendingDirectLink = (jobId: string, resetRetries = false) => {
      if (disposed || !dlState.pendingJobs.has(jobId)) {
        clearRetryStateForJob(dlState, jobId);
        return;
      }
      if (isJobRemovedInSync(queryClient, jobId)) {
        dlState.pendingJobs.delete(jobId);
        clearRetryStateForJob(dlState, jobId);
        return;
      }
      if (resetRetries) {
        dlState.probeAttempts.delete(jobId);
      }
      if (dlState.inFlightProbes.has(jobId)) {
        return;
      }
      const existingTimer = dlState.probeRetryTimers.get(jobId);
      if (existingTimer !== undefined) {
        globalThis.clearTimeout(existingTimer);
        dlState.probeRetryTimers.delete(jobId);
      }

      const probeClock = nextJobSyncClock(queryClient);
      dlState.inFlightProbes.add(jobId);
      void api
        .getJob(jobId)
        .then((res) => {
          if (disposed && dlState.activeHookCount <= 0) return;
          dlState.probeAttempts.delete(jobId);
          if (
            !res?.job ||
            !dlState.pendingJobs.has(jobId) ||
            isJobRemovedInSync(queryClient, jobId, probeClock)
          ) {
            dlState.pendingJobs.delete(jobId);
            clearRetryStateForJob(dlState, jobId);
            return;
          }
          const merged = recordKnownSyncedJob(queryClient, res.job);
          notifyDirectLinkIfReady(dlState, merged);
        })
        .catch((err) => {
          if (isPermanentProbeError(err)) {
            dlState.pendingJobs.delete(jobId);
            clearRetryStateForJob(dlState, jobId);
            return;
          }
          if (
            (!disposed || dlState.activeHookCount > 0) &&
            dlState.pendingJobs.has(jobId) &&
            !isJobRemovedInSync(queryClient, jobId)
          ) {
            const attempt = (dlState.probeAttempts.get(jobId) ?? 0) + 1;
            if (attempt <= MAX_DIRECT_LINK_PROBE_RETRIES) {
              dlState.probeAttempts.set(jobId, attempt);
              const delayMs = DIRECT_LINK_PROBE_BASE_RETRY_MS * 2 ** (attempt - 1);
              const timer = globalThis.setTimeout(() => {
                dlState.probeRetryTimers.delete(jobId);
                dlState.activeProber?.(jobId);
              }, delayMs);
              dlState.probeRetryTimers.set(jobId, timer);
            }
          }
        })
        .finally(() => {
          dlState.inFlightProbes.delete(jobId);
        });
    };

    const verifyRemainingPendingDirectLinks = (resetRetries = false) => {
      if (disposed || dlState.pendingJobs.size === 0) return;
      for (const jobId of [...dlState.pendingJobs.keys()]) {
        probeSinglePendingDirectLink(jobId, resetRetries);
      }
    };

    dlState.activeProber = probeSinglePendingDirectLink;

    const unsubscribeSync = subscribeJobSyncEvents(queryClient, {
      onJobObserved: (job) => {
        if (dlState.pendingJobs.has(job.id)) {
          notifyDirectLinkIfReady(dlState, job);
        }
      },
      onJobRemoved: (jobId) => {
        dlState.pendingJobs.delete(jobId);
        clearRetryStateForJob(dlState, jobId);
      },
      onDownloadListMissingIds: (presentIds) => {
        if (dlState.pendingJobs.size === 0) return;
        for (const pendingId of [...dlState.pendingJobs.keys()]) {
          if (!presentIds.has(pendingId)) {
            probeSinglePendingDirectLink(pendingId);
          }
        }
      },
      onCatchUp: (hasActiveDownloadObserver, invalidatePromise) => {
        if (dlState.pendingJobs.size === 0) return;
        if (hasActiveDownloadObserver) {
          void invalidatePromise.finally(() => {
            verifyRemainingPendingDirectLinks(true);
          });
          return;
        }
        void api
          .listJobs("download")
          .then((res) => {
            if (disposed) return;
            for (const job of res.jobs) {
              if (isJobRemovedInSync(queryClient, job.id)) continue;
              const merged = recordKnownSyncedJob(queryClient, job, res.serverRevision);
              if (dlState.pendingJobs.has(merged.id)) {
                notifyDirectLinkIfReady(dlState, merged);
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            verifyRemainingPendingDirectLinks(true);
          });
      },
    });

    return () => {
      disposed = true;
      dlState.activeHookCount = Math.max(0, dlState.activeHookCount - 1);
      if (dlState.activeProber === probeSinglePendingDirectLink) {
        dlState.activeProber = null;
      }
      unsubscribeSync();
    };
  }, [enabled, queryClient]);
}
