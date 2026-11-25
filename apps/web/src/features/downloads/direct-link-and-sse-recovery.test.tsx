import { useQuery } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, JobsListResponse } from "#shared";
import { mergeJobView, upsertJobIntoList, useJobsQuery } from "../../entities/job/index.js";
import { api } from "../../shared/api/endpoints.js";
import { useToastStore } from "../../shared/store/toast-store.js";
import { ToastContainer } from "../../shared/ui/primitives.js";
import {
  MockEventSource,
  createTestQueryClient,
  installMockEventSource,
  makeTestJob,
  renderWithProviders,
} from "../../test-utils/fixtures.js";
import { trackPendingDirectLinkJob, useJobEvents } from "./index.js";

describe("Direct-link notifications & SSE job reconciliation recovery", () => {
  let restoreEventSource: (() => void) | undefined;

  beforeEach(() => {
    restoreEventSource = installMockEventSource();
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
  });

  afterEach(() => {
    restoreEventSource?.();
    vi.restoreAllMocks();
  });

  it("mergeJobView never regresses a terminal job back to running on stale snapshot", () => {
    const completed = makeTestJob({ id: "j1", status: "completed", progress: 100, updatedAt: 2000 });
    const staleRunning = makeTestJob({ id: "j1", status: "running", progress: 65, updatedAt: 1500 });

    expect(mergeJobView(completed, staleRunning).status).toBe("completed");
  });

  it("upsertJobIntoList sorts by createdAt DESC and caps list at 100 entries", () => {
    const full100 = Array.from({ length: 100 }, (_, i) =>
      makeTestJob({ id: `n-${i}`, createdAt: 2000 + i, updatedAt: 2000 + i }),
    );
    const afterOldUpdate = upsertJobIntoList(
      full100,
      makeTestJob({ id: "ancient-job", createdAt: 500, updatedAt: 9999 }),
      100,
    );

    expect(afterOldUpdate).toHaveLength(100);
    expect(afterOldUpdate.some((j) => j.id === "ancient-job")).toBe(false);
  });

  it("shows direct-link toast immediately when fast SSE completion arrives before trackPendingDirectLinkJob", () => {
    function SseHarness() {
      useJobEvents(true);
      return <ToastContainer />;
    }

    const { queryClient } = renderWithProviders(<SseHarness />, { withRouter: false });
    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected EventSource instance");

    act(() => es.emitOpen());
    act(() => {
      es.emitMessage({
        type: "job_updated",
        job: makeTestJob({
          id: "dl-fast",
          status: "completed",
          title: "快响应直链",
          directUrl: "https://m7.music.126.net/fast.mp3",
        }),
      });
    });

    act(() => {
      const resolvedImmediately = trackPendingDirectLinkJob("dl-fast", {
        queryClient,
        fallbackTitle: "快响应直链",
      });
      expect(resolvedImmediately).toBe(true);
    });

    expect(screen.getByRole("link", { name: "打开直链" })).toHaveAttribute(
      "href",
      "https://m7.music.126.net/fast.mp3",
    );
  });

  it("catches up missed direct-link completion on SSE reconnect without regressing completed jobs", async () => {
    function SseHarness() {
      useJobEvents(true);
      return <ToastContainer />;
    }

    const { queryClient } = renderWithProviders(<SseHarness />, { withRouter: false });
    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected EventSource instance");

    act(() => es.emitOpen());
    act(() => {
      es.emitMessage({
        type: "job_updated",
        job: makeTestJob({
          id: "dl-fast",
          status: "completed",
          title: "已完成直链",
          directUrl: "https://m7.music.126.net/fast.mp3",
        }),
      });
    });

    trackPendingDirectLinkJob("dl-reconnect", { queryClient });
    vi.spyOn(api, "listJobs").mockResolvedValueOnce({
      jobs: [
        makeTestJob({
          id: "dl-reconnect",
          status: "completed",
          title: "重连补弹直链",
          directUrl: "https://m7.music.126.net/reconnected.mp3",
        }),
        makeTestJob({ id: "dl-fast", status: "running", progress: 40, updatedAt: 500 }),
      ],
    });

    act(() => {
      es.emitError();
      es.emitOpen();
    });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "打开直链" })).toHaveAttribute(
        "href",
        "https://m7.music.126.net/reconnected.mp3",
      );
    });
    expect(queryClient.getQueryData<{ job: JobView }>(["job", "dl-fast"])?.job.status).toBe("completed");
  });

  it("reconciles in-flight listJobs against concurrent SSE add/update/remove and probes >50th direct-link via getJob", async () => {
    let resolveInFlightList: ((res: JobsListResponse) => void) | undefined;
    let listCalls = 0;
    const staleSnapshot = [
      makeTestJob({ id: "removed-job", status: "completed", progress: 100, createdAt: 20 }),
      makeTestJob({ id: "running-job", status: "running", progress: 30, createdAt: 10, updatedAt: 10 }),
    ];

    vi.spyOn(api, "listJobs").mockImplementation(() => {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ jobs: staleSnapshot });
      return new Promise((resolve) => {
        resolveInFlightList = resolve;
      });
    });
    vi.spyOn(api, "getJob").mockImplementation(async (id) => ({
      job: makeTestJob({
        id,
        status: "completed",
        progress: 100,
        title: "五十一号旧直链",
        directUrl: "https://m7.music.126.net/beyond50.mp3",
      }),
    }));

    function JobWatcher() {
      useJobEvents(true);
      useQuery({ queryKey: ["jobs", "download"], queryFn: () => api.listJobs("download") });
      return null;
    }

    const { queryClient } = renderWithProviders(<JobWatcher />, { withRouter: false });
    await waitFor(() => {
      expect(queryClient.getQueryData<JobsListResponse>(["jobs", "download"])?.jobs).toHaveLength(2);
    });

    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected EventSource");
    act(() => es.emitOpen());
    trackPendingDirectLinkJob("beyond-50-id", { queryClient });

    act(() => {
      es.emitError();
      es.emitOpen();
    });
    await waitFor(() => expect(listCalls).toBe(2));

    act(() => {
      es.emitMessage({
        type: "job_updated",
        job: makeTestJob({ id: "new-sse-job", status: "completed", progress: 100, createdAt: 30 }),
      });
      es.emitMessage({
        type: "job_updated",
        job: makeTestJob({
          id: "running-job",
          status: "completed",
          progress: 100,
          createdAt: 10,
          updatedAt: 40,
        }),
      });
      es.emitMessage({ type: "job_removed", jobId: "removed-job" });
    });

    await act(async () => {
      resolveInFlightList?.({ jobs: staleSnapshot });
    });

    const finalJobs = queryClient.getQueryData<JobsListResponse>(["jobs", "download"])?.jobs ?? [];
    expect(finalJobs.map((j) => [j.id, j.status])).toEqual([
      ["new-sse-job", "completed"],
      ["running-job", "completed"],
    ]);

    await waitFor(() => {
      expect(useToastStore.getState().items.some((t) => t.action?.href?.includes("beyond50.mp3"))).toBe(true);
    });
  });

  it("reconciles serverRevision across transient 503 listJobs retry and retries 503 getJob probe for late >50-item registration", async () => {
    const retryQc = createTestQueryClient({ retry: 1, retryDelay: 10 });
    const anchor = makeTestJob({ id: "anchor", createdAt: 1, status: "running", progress: 20, revision: 10 });
    const transient = makeTestJob({
      id: "later-removed",
      createdAt: 2,
      status: "completed",
      progress: 100,
      revision: 11,
    });

    let retryListCalls = 0;
    let rejectAttempt1: ((err: Error) => void) | undefined;
    let resolveAttempt2: ((val: JobsListResponse) => void) | undefined;

    vi.spyOn(api, "listJobs").mockImplementation(() => {
      retryListCalls += 1;
      if (retryListCalls === 1) return Promise.resolve({ jobs: [anchor], serverRevision: 10 });
      if (retryListCalls === 2) {
        return new Promise<JobsListResponse>((_, reject) => {
          rejectAttempt1 = reject;
        });
      }
      return new Promise<JobsListResponse>((resolve) => {
        resolveAttempt2 = resolve;
      });
    });

    let getJobAttempt = 0;
    vi.spyOn(api, "getJob").mockImplementation(async (id) => {
      getJobAttempt += 1;
      if (id === "retry-503-dl" && getJobAttempt === 1) {
        throw new Error("503 transient getJob");
      }
      return {
        job: makeTestJob({
          id,
          status: "completed",
          progress: 100,
          directUrl: `https://m7.music.126.net/${id}.mp3`,
        }),
      };
    });

    function RetryWatcher() {
      useJobEvents(true);
      useJobsQuery("download");
      return null;
    }

    renderWithProviders(<RetryWatcher />, { queryClient: retryQc, withRouter: false });
    await waitFor(() => {
      expect(retryQc.getQueryData<JobsListResponse>(["jobs", "download"])?.jobs.map((j) => j.id)).toEqual([
        "anchor",
      ]);
    });

    const retryEs = MockEventSource.instances[0];
    if (!retryEs) throw new Error("Expected MockEventSource");

    act(() => retryEs.emitOpen());
    act(() => {
      retryEs.emitError();
      retryEs.emitOpen();
    });
    await waitFor(() => expect(retryListCalls).toBe(2));

    await act(async () => {
      rejectAttempt1?.(new Error("503 temporary"));
    });
    act(() => {
      retryEs.emitMessage({ type: "job_updated", job: transient, serverRevision: 11 });
    });
    await waitFor(() => expect(retryListCalls).toBe(3));

    await act(async () => {
      resolveAttempt2?.({ jobs: [anchor], serverRevision: 12 });
    });
    expect(retryQc.getQueryData<JobsListResponse>(["jobs", "download"])?.jobs.map((j) => j.id)).toEqual([
      "anchor",
    ]);

    retryQc.setQueryData(["jobs", "download"], {
      jobs: Array.from({ length: 50 }, (_, idx) => makeTestJob({ id: `newer-${idx}`, createdAt: 100 - idx })),
    });
    trackPendingDirectLinkJob("retry-503-dl", { queryClient: retryQc, fallbackTitle: "重试直链" });

    await waitFor(
      () => {
        expect(useToastStore.getState().items.some((t) => t.action?.href?.includes("retry-503-dl.mp3"))).toBe(
          true,
        );
      },
      { timeout: 2000 },
    );
  });

  it("recovers pending direct-link notifications when browser comes back online", async () => {
    function OnlineWatcher() {
      useJobEvents(true);
      return <ToastContainer />;
    }

    const { queryClient } = renderWithProviders(<OnlineWatcher />, { withRouter: false });
    const es = MockEventSource.instances[0];
    if (!es) throw new Error("Expected MockEventSource");
    act(() => es.emitOpen());

    trackPendingDirectLinkJob("offline-dl-1", { queryClient, fallbackTitle: "离线恢复曲" });

    vi.spyOn(api, "listJobs").mockResolvedValueOnce({
      jobs: [
        makeTestJob({
          id: "offline-dl-1",
          status: "completed",
          progress: 100,
          title: "离线恢复曲",
          directUrl: "https://m7.music.126.net/offline-recovered.mp3",
        }),
      ],
    });

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "打开直链" })).toHaveAttribute(
        "href",
        "https://m7.music.126.net/offline-recovered.mp3",
      );
    });
  });
});
