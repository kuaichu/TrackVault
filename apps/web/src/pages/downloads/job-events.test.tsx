import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "#shared";
import { useJobDetailQuery } from "../../entities/job/index.js";
import {
  clearPendingDirectLinkJobs,
  registerPendingDirectLinkJob,
  trackPendingDirectLinkJob,
  useJobEvents,
} from "../../features/downloads/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast, useToastStore } from "../../shared/store/toast-store.js";
import { ToastContainer } from "../../shared/ui/primitives.js";
import { DownloadsPage } from "./DownloadsPage.js";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    MockEventSource.instances.push(this);
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emitMessage(data: Record<string, unknown>) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ timestamp: Date.now(), ...data }) }),
    );
  }

  close() {
    this.closed = true;
  }
}

function makeJob(overrides: Partial<JobView>): JobView {
  return {
    id: "job-1",
    kind: "download",
    status: "running",
    progress: 30,
    title: "晴天 - 周杰伦",
    createdAt: 1000,
    updatedAt: 1000,
    downloadReady: false,
    artifactExpired: false,
    ...overrides,
  };
}

function JobEventsHarness({ enabled = true }: { enabled?: boolean }) {
  useJobEvents(enabled);
  return <ToastContainer />;
}

describe("Phase 5 · useJobEvents SSE partitioning, direct-link toasts, toast cap, and DownloadsPage", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    act(() => {
      useToastStore.getState().clear();
    });
    clearPendingDirectLinkJobs();
  });

  afterEach(() => {
    cleanup();
    globalThis.EventSource = originalEventSource;
    act(() => {
      useToastStore.getState().clear();
    });
    clearPendingDirectLinkJobs();
    vi.restoreAllMocks();
  });

  it("partitions job_updated strictly by kind, removes ['job', id] on job_removed, and invalidates on reconnect/online (F03/F04/B51/B53)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    queryClient.setQueryData<{ jobs: JobView[] }>(["jobs"], { jobs: [] });
    queryClient.setQueryData<{ jobs: JobView[] }>(["jobs", "download"], { jobs: [] });
    queryClient.setQueryData<{ jobs: JobView[] }>(["jobs", "transfer"], { jobs: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <JobEventsHarness enabled />
      </QueryClientProvider>,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    // First open should NOT trigger redundant invalidation
    act(() => {
      es?.emitOpen();
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Download job update must enter ["jobs"] and ["jobs", "download"], NOT ["jobs", "transfer"]
    const dlJob = makeJob({ id: "dl-1", kind: "download", status: "running", progress: 45 });
    act(() => {
      es?.emitMessage({ type: "job_updated", job: dlJob });
    });

    expect(queryClient.getQueryData<{ jobs: JobView[] }>(["jobs"])?.jobs.map((j) => j.id)).toEqual(["dl-1"]);
    expect(
      queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs.map((j) => j.id),
    ).toEqual(["dl-1"]);
    expect(queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "transfer"])?.jobs).toEqual([]);
    expect(queryClient.getQueryData<{ job: JobView }>(["job", "dl-1"])?.job.progress).toBe(45);

    // Transfer job update must NOT pollute ["jobs", "download"]
    const tfJob = makeJob({ id: "tf-1", kind: "transfer", status: "running", title: "歌单迁移" });
    act(() => {
      es?.emitMessage({ type: "job_updated", job: tfJob });
    });

    expect(
      queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs.map((j) => j.id),
    ).toEqual(["dl-1"]);
    expect(
      queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "transfer"])?.jobs.map((j) => j.id),
    ).toEqual(["tf-1"]);

    // job_removed clears both list caches AND single-job detail cache ["job", id]
    act(() => {
      es?.emitMessage({ type: "job_removed", jobId: "dl-1" });
    });
    expect(queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs).toEqual([]);
    expect(queryClient.getQueryData<{ job: JobView }>(["job", "dl-1"])).toBeUndefined();

    // Error + reconnect triggers ["jobs"] snapshot catch-up
    act(() => {
      es?.emitError();
      es?.emitOpen();
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["jobs"] });

    invalidateSpy.mockClear();

    // Browser online event also triggers ["jobs"] snapshot catch-up
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["jobs"] });
  });

  it("shows one-shot clickable safe direct-link toast on completion and enforces strict 3-toast cap (F04/F17/B53)", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <JobEventsHarness enabled />
      </QueryClientProvider>,
    );

    // Strict max 3 toasts
    act(() => {
      toast.info("消息 1");
      toast.info("消息 2");
      toast.info("消息 3");
      toast.info("消息 4");
    });
    expect(useToastStore.getState().items.map((i) => i.message)).toEqual(["消息 2", "消息 3", "消息 4"]);

    act(() => {
      useToastStore.getState().clear();
    });

    const es = MockEventSource.instances[0];
    trackPendingDirectLinkJob("dl-direct-1");
    trackPendingDirectLinkJob("dl-direct-unsafe");

    // Safe direct link produces a clickable external anchor toast once
    const completedSafe = makeJob({
      id: "dl-direct-1",
      status: "completed",
      title: "夜曲 - 周杰伦",
      directUrl: "https://cdn.example.com/audio/ye-qu.flac",
    });
    act(() => {
      es?.emitMessage({ type: "job_updated", job: completedSafe });
      // Duplicate completion event must NOT spawn a second toast
      es?.emitMessage({ type: "job_updated", job: completedSafe });
    });

    const link = screen.getByRole("link", { name: "打开直链" });
    expect(link).toHaveAttribute("href", "https://cdn.example.com/audio/ye-qu.flac");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(useToastStore.getState().items).toHaveLength(1);

    // Unsafe javascript: directUrl must NOT produce an action toast
    act(() => {
      es?.emitMessage({
        type: "job_updated",
        job: makeJob({
          id: "dl-direct-unsafe",
          status: "completed",
          title: "恶意链接",
          directUrl: "javascript:alert(1)",
        }),
      });
    });
    expect(useToastStore.getState().items).toHaveLength(1);
  });

  it("DownloadsPage reports accurate status on cancel, surfaces error retry state, and toasts mutation errors (F18/F20/B48)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // 1) Initial load error shows retry button instead of empty state
    const listSpy = vi
      .spyOn(api, "listJobs")
      .mockRejectedValueOnce(new Error("网络异常"))
      .mockResolvedValue({
        jobs: [makeJob({ id: "dl-race", status: "running", progress: 90, title: "七里香" })],
      });

    // Server returns already-completed job when cancel races with completion
    vi.spyOn(api, "cancelJob").mockResolvedValueOnce({
      job: makeJob({
        id: "dl-race",
        status: "completed",
        progress: 100,
        title: "七里香",
        downloadReady: true,
      }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <DownloadsPage />
        <ToastContainer />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("未能加载下载任务")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => {
      expect(screen.getByText("七里香")).toBeInTheDocument();
    });
    expect(listSpy).toHaveBeenCalledTimes(2);

    // Click cancel -> toast must report already completed, NOT "已取消"
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    await waitFor(() => {
      expect(screen.getByText("该任务已完成，无法取消")).toBeInTheDocument();
    });
    expect(screen.queryByText("已取消下载任务")).not.toBeInTheDocument();
  });

  it("preserves registered pendingDirectLinkJobs across React StrictMode mount/unmount/remount and isolates state per QueryClient (PP-04)", () => {
    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    registerPendingDirectLinkJob("dl-strict-1", {
      queryClient: qc1,
      fallbackTitle: "StrictMode 直链曲",
    });

    render(
      <StrictMode>
        <QueryClientProvider client={qc1}>
          <JobEventsHarness enabled />
        </QueryClientProvider>
      </StrictMode>,
    );

    // StrictMode ran mount -> cleanup -> remount: first EventSource closed, second remains open
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0]?.closed).toBe(true);
    expect(MockEventSource.instances[1]?.closed).toBe(false);

    // Clearing qc2 must NOT affect qc1's pending direct-link registration
    registerPendingDirectLinkJob(qc2, "dl-qc2-only", "会话2直链");
    clearPendingDirectLinkJobs(qc2);

    const activeEs = MockEventSource.instances[1];
    act(() => {
      activeEs?.emitMessage({
        type: "job_updated",
        job: makeJob({
          id: "dl-strict-1",
          status: "completed",
          title: "StrictMode 直链曲",
          directUrl: "https://cdn.example.com/audio/strict.flac",
        }),
      });
    });

    const link = screen.getByRole("link", { name: "打开直链" });
    expect(link).toHaveAttribute("href", "https://cdn.example.com/audio/strict.flac");
    expect(useToastStore.getState().items).toHaveLength(1);
  });

  it("disables DownloadsPage clear and cancel buttons while their mutations are pending (PP-04)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(api, "listJobs").mockResolvedValue({
      jobs: [
        makeJob({ id: "dl-running", status: "running", progress: 40, title: "进行中曲目" }),
        makeJob({ id: "dl-done", status: "completed", progress: 100, title: "已完成曲目" }),
      ],
    });

    let resolveCancel!: (res: { job: JobView }) => void;
    vi.spyOn(api, "cancelJob").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );

    let resolveClear!: (res: { removedCount: number }) => void;
    vi.spyOn(api, "clearFinishedJobs").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveClear = resolve;
        }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <DownloadsPage />
        <ToastContainer />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("进行中曲目")).toBeInTheDocument();
    });

    const cancelBtn = screen.getByRole("button", { name: /取消/ });
    const clearBtn = screen.getByRole("button", { name: "清除已结束" });
    expect(cancelBtn).not.toBeDisabled();
    expect(clearBtn).not.toBeDisabled();

    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(cancelBtn).toBeDisabled();
    });

    fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(clearBtn).toBeDisabled();
    });

    await act(async () => {
      resolveCancel({ job: makeJob({ id: "dl-running", status: "cancelled" }) });
      resolveClear({ removedCount: 1 });
    });
  });

  it("reconciles jobs_cleared by clearedKind/clearedBeforeRevision and refreshes active ['job', id] detail on summary revision bump (P1-1)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const getJobSpy = vi
      .spyOn(api, "getJob")
      .mockResolvedValueOnce({
        job: makeJob({
          id: "tf-detail",
          kind: "transfer",
          status: "completed",
          progress: 100,
          revision: 5,
          hasResult: true,
          result: { version: 1 },
        }),
      })
      .mockResolvedValueOnce({
        job: makeJob({
          id: "tf-detail",
          kind: "transfer",
          status: "completed",
          progress: 100,
          revision: 6,
          hasResult: true,
          result: { version: 2 },
        }),
      });

    queryClient.setQueryData(["jobs", "download"], {
      jobs: [
        makeJob({ id: "dl-done", kind: "download", status: "completed", progress: 100, revision: 3 }),
        makeJob({ id: "dl-running", kind: "download", status: "running", progress: 50, revision: 4 }),
      ],
      serverRevision: 4,
    });

    function DetailWatcher() {
      useJobEvents(true);
      const detail = useJobDetailQuery("tf-detail", true);
      return (
        <div data-testid="detail-version">
          {String((detail.data?.job.result as { version?: number } | undefined)?.version ?? "")}
        </div>
      );
    }

    render(
      <QueryClientProvider client={queryClient}>
        <DetailWatcher />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("detail-version")).toHaveTextContent("1");
    });

    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    // Summary-only SSE update with revision=6 preserves old result temporarily and triggers refetch of ["job", "tf-detail"]
    act(() => {
      es?.emitMessage({
        type: "job_updated",
        serverRevision: 6,
        job: makeJob({
          id: "tf-detail",
          kind: "transfer",
          status: "completed",
          progress: 100,
          revision: 6,
          hasResult: true,
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("detail-version")).toHaveTextContent("2");
    });
    expect(getJobSpy).toHaveBeenCalledTimes(2);

    // jobs_cleared for download removes dl-done while keeping dl-running
    act(() => {
      es?.emitMessage({
        type: "jobs_cleared",
        clearedKind: "download",
        clearedBeforeRevision: 4,
        serverRevision: 7,
      });
    });

    expect(
      queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "download"])?.jobs.map((j) => j.id),
    ).toEqual(["dl-running"]);
  });
});
