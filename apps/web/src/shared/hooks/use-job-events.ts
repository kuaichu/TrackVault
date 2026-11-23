import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { JobEventSchema, type JobView } from "#shared";

/**
 * Connects a single SSE EventSource to `/api/events` and patches TanStack Query job caches in real time,
 * completely eliminating the v1 1.2s permanent polling loop.
 */
export function useJobEvents(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;

    const es = new EventSource("/api/events", { withCredentials: true });
    es.onmessage = (event) => {
      try {
        const parsed = JobEventSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) return;
        const payload = parsed.data;

        if (payload.type === "job_updated" && payload.job) {
          const updatedJob = payload.job;
          queryClient.setQueriesData<{ jobs: JobView[] }>({ queryKey: ["jobs"] }, (prev) => {
            if (!prev) return prev;
            const exists = prev.jobs.some((j) => j.id === updatedJob.id);
            const nextJobs = exists
              ? prev.jobs.map((j) => (j.id === updatedJob.id ? updatedJob : j))
              : [updatedJob, ...prev.jobs];
            return { jobs: nextJobs };
          });
          queryClient.setQueryData<{ job: JobView }>(["job", updatedJob.id], { job: updatedJob });
        } else if (payload.type === "job_removed" && payload.jobId) {
          const removedId = payload.jobId;
          queryClient.setQueriesData<{ jobs: JobView[] }>({ queryKey: ["jobs"] }, (prev) => {
            if (!prev) return prev;
            return { jobs: prev.jobs.filter((j) => j.id !== removedId) };
          });
        }
      } catch {
        // Ignore malformed SSE frames
      }
    };

    return () => {
      es.close();
    };
  }, [enabled, queryClient]);
}
