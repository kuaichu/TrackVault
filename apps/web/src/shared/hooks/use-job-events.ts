import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { JobEventSchema, type JobKind, type JobView, sanitizeExternalUrl } from "#shared";
import { toast } from "../store/toast-store.js";

const MAX_PENDING_DIRECT_LINK_JOBS = 50;
const pendingDirectLinkJobIds = new Set<string>();

export function trackPendingDirectLinkJob(jobId: string): void {
  if (!jobId) return;
  pendingDirectLinkJobIds.add(jobId);
  if (pendingDirectLinkJobIds.size > MAX_PENDING_DIRECT_LINK_JOBS) {
    const oldest = pendingDirectLinkJobIds.values().next().value;
    if (oldest) pendingDirectLinkJobIds.delete(oldest);
  }
}

export function clearPendingDirectLinkJobs(): void {
  pendingDirectLinkJobIds.clear();
}

function matchesJobListQuery(queryKey: readonly unknown[], kind: JobKind): boolean {
  if (queryKey[0] !== "jobs") return false;
  return queryKey.length === 1 || queryKey[1] === undefined || queryKey[1] === kind;
}

/**
 * Connects a single SSE EventSource to `/api/events` and patches TanStack Query job caches in real time,
 * strictly partitioned by job kind with reconnect/online catch-up and direct-link completion toasts.
 */
export function useJobEvents(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) {
      clearPendingDirectLinkJobs();
      return;
    }

    const handleOnline = () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    };
    window.addEventListener("online", handleOnline);

    if (typeof EventSource === "undefined") {
      return () => {
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
        void queryClient.invalidateQueries({ queryKey: ["jobs"] });
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
          const updatedJob = payload.job;
          queryClient.setQueriesData<{ jobs: JobView[] }>(
            {
              queryKey: ["jobs"],
              predicate: (query) => matchesJobListQuery(query.queryKey, updatedJob.kind),
            },
            (prev) => {
              if (!prev) return prev;
              const exists = prev.jobs.some((j) => j.id === updatedJob.id);
              const nextJobs = exists
                ? prev.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
                : [updatedJob, ...prev.jobs];
              return { jobs: nextJobs };
            },
          );
          queryClient.setQueryData<{ job: JobView }>(["job", updatedJob.id], { job: updatedJob });

          if (pendingDirectLinkJobIds.has(updatedJob.id)) {
            if (updatedJob.status === "completed") {
              pendingDirectLinkJobIds.delete(updatedJob.id);
              const safeDirectUrl = sanitizeExternalUrl(updatedJob.directUrl);
              if (safeDirectUrl) {
                toast.success(`直链已就绪：${updatedJob.title}`, {
                  action: { label: "打开直链", href: safeDirectUrl },
                });
              }
            } else if (updatedJob.status === "failed" || updatedJob.status === "cancelled") {
              pendingDirectLinkJobIds.delete(updatedJob.id);
            }
          }
        } else if (payload.type === "job_removed" && payload.jobId) {
          const removedId = payload.jobId;
          pendingDirectLinkJobIds.delete(removedId);
          queryClient.setQueriesData<{ jobs: JobView[] }>({ queryKey: ["jobs"] }, (prev) => {
            if (!prev) return prev;
            return { jobs: prev.jobs.filter((j) => j.id !== removedId) };
          });
          queryClient.removeQueries({ queryKey: ["job", removedId], exact: true });
        }
      } catch {
        // Ignore malformed SSE frames
      }
    };

    return () => {
      es.close();
      window.removeEventListener("online", handleOnline);
      clearPendingDirectLinkJobs();
    };
  }, [enabled, queryClient]);
}
