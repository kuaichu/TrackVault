import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompareResult,
  ImportAuditResult,
  JobDetailView,
  JobSummaryView,
  JobView,
  TransferResult,
  TransferTrackResult,
} from "#shared";
import { clearPendingDirectLinkJobs, useJobEvents } from "../../features/downloads/index.js";
import { api } from "../../shared/api/endpoints.js";
import { useToastStore } from "../../shared/store/toast-store.js";
import { ToastContainer } from "../../shared/ui/primitives.js";
import { TransferPage } from "./TransferPage.js";

function renderTransferPage(queryClient?: QueryClient) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  return {
    queryClient: client,
    ...render(
      <QueryClientProvider client={client}>
        <TransferPage />
      </QueryClientProvider>,
    ),
  };
}

function makeTransferJob(result: TransferResult): JobView {
  return {
    id: "job-transfer-1",
    kind: "transfer",
    status: "completed",
    title: "歌单互转 · 测试歌单",
    subtitle: "匹配完成",
    progress: 100,
    downloadReady: false,
    artifactExpired: false,
    result,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("Phase 3 · TransferPage UI validation, manual review, pagination, audit & compare viewers", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("disables submit when input is empty (B46) and passes checkAvailability flag (T09)", async () => {
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [] });
    const startSpy = vi.spyOn(api, "startTransferJob").mockResolvedValue({
      job: {
        id: "job-new",
        kind: "transfer",
        status: "queued",
        title: "歌单互转",
        progress: 0,
        downloadReady: false,
        artifactExpired: false,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    renderTransferPage();

    const submitBtn = screen.getByRole("button", { name: "开始匹配" });
    expect(submitBtn).toBeDisabled();

    const textarea = screen.getByPlaceholderText(/每行一首曲目/);
    fireEvent.change(textarea, { target: { value: "   \n  " } });
    expect(submitBtn).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "晴天 - 周杰伦" } });
    expect(submitBtn).not.toBeDisabled();

    const probeCheckbox = screen.getByLabelText(/实测音源可用性/);
    expect(probeCheckbox).not.toBeChecked();
    fireEvent.click(probeCheckbox);
    expect(probeCheckbox).toBeChecked();

    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceProvider: "text",
          targetProvider: "netease",
          rawText: "晴天 - 周杰伦",
          checkAvailability: true,
        }),
      );
    });
  });

  it("supports manual review selection (F15), disables import when 0 matched (F19), and invalidates playlists on import (F13)", async () => {
    const initialResult: TransferResult = {
      sourceProvider: "text",
      targetProvider: "netease",
      playlistName: "人工确认单",
      summary: {
        total: 2,
        matched: 0,
        manualReview: 1,
        notFound: 1,
        unavailable: 0,
        duplicate: 0,
        skipped: 0,
      },
      results: [
        {
          sourceTrack: { source: "text", title: "找不到这首歌", artists: ["未知"] },
          status: "not_found",
          candidates: [],
          reason: "目标平台未找到匹配候选",
        },
        {
          sourceTrack: { source: "text", title: "晴天", artists: ["周杰伦"] },
          status: "manual_review",
          candidates: [
            {
              provider: "netease",
              targetTrackId: "cand-a",
              title: "晴天 (Acoustic)",
              artists: ["周杰伦"],
              availability: "playable",
              confidenceScore: 76,
              reasons: ["歌名接近"],
            },
            {
              provider: "netease",
              targetTrackId: "cand-b",
              title: "晴天 (Live)",
              artists: ["周杰伦"],
              availability: "playable",
              confidenceScore: 74,
              reasons: ["歌名接近"],
            },
          ],
          reason: "存在相似候选，建议人工确认",
        },
      ],
    };

    const firstRow = initialResult.results[0];
    const secondRow = initialResult.results[1];
    if (!firstRow || !secondRow) throw new Error("Missing fixture rows");

    const updatedResult: TransferResult = {
      ...initialResult,
      summary: {
        ...initialResult.summary,
        matched: 1,
        manualReview: 0,
      },
      results: [
        firstRow,
        {
          ...secondRow,
          status: "matched",
          selectedCandidate: secondRow.candidates[1],
          reason: "已人工确认",
        },
      ],
    };

    let currentJob = makeTransferJob(initialResult);
    vi.spyOn(api, "listJobs").mockImplementation(async () => ({ jobs: [currentJob] }));
    const selectSpy = vi.spyOn(api, "updateTransferSelection").mockImplementation(async () => {
      currentJob = makeTransferJob(updatedResult);
      return { job: currentJob };
    });
    const importSpy = vi.spyOn(api, "importTransferJob").mockResolvedValue({
      playlistId: "pl-created",
      playlistName: "人工确认单",
      playlistUrl: "https://music.163.com/#/playlist?id=pl-created",
      addedCount: 1,
      skippedCount: 0,
    });

    const { queryClient } = renderTransferPage();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    // Initially 0 matched -> import button disabled with hint (F19)
    const importBtn = await screen.findByRole("button", { name: "创建目标歌单 (0)" });
    expect(importBtn).toBeDisabled();
    expect(screen.getByText("暂无可导入的匹配/可播曲目")).toBeInTheDocument();

    // Filter to "待确认 (1)" and pick candidate #2 (verifies originalIndex === 1, NOT filtered index 0!)
    fireEvent.click(screen.getByRole("button", { name: "待确认 (1)" }));
    const pickButtons = screen.getAllByRole("button", { name: "采用" });
    expect(pickButtons).toHaveLength(2);
    const secondPick = pickButtons[1];
    if (!secondPick) throw new Error("Expected second pick button");
    fireEvent.click(secondPick);

    await waitFor(() => {
      expect(selectSpy).toHaveBeenCalledWith("job-transfer-1", {
        index: 1,
        action: "select",
        targetTrackId: "cand-b",
      });
    });

    // Import button now enabled with count (1)
    const enabledImportBtn = await screen.findByRole("button", { name: "创建目标歌单 (1)" });
    expect(enabledImportBtn).not.toBeDisabled();
    fireEvent.click(enabledImportBtn);

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith("job-transfer-1", {});
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["playlists"] });
    });
  });

  it("paginates more than 50 transfer items (F16), displays Chinese status labels and truncation notice (T11/C071)", async () => {
    const rows: TransferTrackResult[] = Array.from({ length: 65 }, (_, i) => ({
      sourceTrack: { source: "text", title: `曲目 ${i + 1}`, artists: [`歌手 ${i + 1}`] },
      status: "matched",
      candidates: [],
      selectedCandidate: {
        provider: "netease",
        targetTrackId: `t-${i + 1}`,
        title: `曲目 ${i + 1}`,
        artists: [`歌手 ${i + 1}`],
        availability: "playable",
        confidenceScore: 98,
        reasons: ["歌名完全一致"],
      },
    }));

    const job = makeTransferJob({
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistName: "大歌单",
      sourceTotal: 250,
      processedCount: 65,
      unprocessedCount: 185,
      truncated: true,
      summary: {
        total: 65,
        matched: 65,
        manualReview: 0,
        notFound: 0,
        unavailable: 0,
        duplicate: 0,
        skipped: 0,
      },
      results: rows,
    });

    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [job] });
    renderTransferPage();

    expect(
      await screen.findByText(/源歌单共 250 首，已处理 65 首（未处理 185 首：超出单次处理上限 185 首）/),
    ).toBeInTheDocument();
    expect(screen.getByText("已显示 50 / 65 首")).toBeInTheDocument();
    expect(screen.queryByText("曲目 65")).not.toBeInTheDocument();
    // Must not leak raw English enum
    expect(screen.queryByText("matched")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "加载更多（剩余 15 首）" }));
    expect(screen.getByText("已显示 65 / 65 首")).toBeInTheDocument();
    expect(screen.getByText("曲目 65")).toBeInTheDocument();
  });

  it("renders audit issues/replacements (B27/C071), compare similarTitle/items and clearFinished action (C071)", async () => {
    const auditResult: ImportAuditResult = {
      playlistId: "pl-1",
      playlistName: "灰歌单",
      scannedCount: 2,
      playableCount: 0,
      issueCount: 2,
      playableTrackIds: [],
      issues: [
        {
          trackId: "1",
          title: "数字专辑歌",
          artists: ["歌手甲"],
          issueType: "paid_album",
          reason: "需要购买数字专辑",
          replacements: [
            {
              provider: "netease",
              targetTrackId: "rep-1",
              title: "数字专辑歌 (Live)",
              artists: ["歌手甲"],
              availability: "playable",
              confidenceScore: 86,
              reasons: ["歌名接近"],
            },
          ],
        },
        {
          trackId: "2",
          title: "试听歌",
          artists: ["歌手乙"],
          issueType: "trial_only",
          reason: "实测音源仅提供试听片段",
          replacements: [],
        },
      ],
    };

    const compareResult: CompareResult = {
      left: { provider: "netease", playlistId: "L1", playlistName: "歌单A", total: 2 },
      right: { provider: "qq", playlistId: "R1", playlistName: "歌单B", total: 2 },
      summary: {
        leftTotal: 2,
        rightTotal: 2,
        exact: 1,
        similarTitle: 1,
        sameTitleDifferentArtist: 0,
        leftOnly: 0,
        rightOnly: 0,
      },
      items: [
        {
          status: "exact",
          score: 100,
          left: { source: "netease", title: "晴天", artists: ["周杰伦"] },
          right: { source: "qq", title: "晴天", artists: ["周杰伦"] },
        },
        {
          status: "similar_title",
          score: 76,
          left: { source: "netease", title: "稻香", artists: ["周杰伦"] },
          right: { source: "qq", title: "稻香 (Live)", artists: ["周杰伦"] },
          reason: "同艺人近似歌名",
        },
      ],
    };

    vi.spyOn(api, "listJobs").mockImplementation(async (kind) => {
      if (kind === "import_audit") {
        return {
          jobs: [
            {
              id: "job-audit-1",
              kind: "import_audit",
              status: "completed",
              title: "可用性审计 · 灰歌单",
              progress: 100,
              downloadReady: false,
              artifactExpired: false,
              result: auditResult,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      }
      if (kind === "compare") {
        return {
          jobs: [
            {
              id: "job-compare-1",
              kind: "compare",
              status: "completed",
              title: "双歌单对比",
              progress: 100,
              downloadReady: false,
              artifactExpired: false,
              result: compareResult,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      }
      return { jobs: [] };
    });
    const clearSpy = vi.spyOn(api, "clearFinishedJobs").mockResolvedValue({ removedCount: 1 });

    renderTransferPage();

    // Switch to Audit tab
    fireEvent.click(screen.getByRole("button", { name: "灰歌检测" }));
    expect(await screen.findByText("数字专辑歌")).toBeInTheDocument();
    expect(screen.getByText("付费专辑")).toBeInTheDocument();
    expect(screen.getByText("仅试听")).toBeInTheDocument();
    expect(screen.getByText("替代候选（1）")).toBeInTheDocument();
    expect(screen.getByText("数字专辑歌 (Live)")).toBeInTheDocument();

    // Switch to Compare tab
    fireEvent.click(screen.getByRole("button", { name: "双歌单对比" }));
    expect(await screen.findAllByText("相似歌名")).toHaveLength(2);
    expect(screen.getByText("同艺人近似歌名")).toBeInTheDocument();

    // Verify compare selects have shrink-0
    const selects = screen.getAllByRole("combobox");
    for (const sel of selects) {
      expect(sel.className).toContain("shrink-0");
    }

    // Clear finished jobs button works
    fireEvent.click(screen.getByRole("button", { name: "清除已结束" }));
    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalledWith("compare");
    });
  });
});

class MockTransferEventSource {
  static instances: MockTransferEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(_url: string, _init?: EventSourceInit) {
    MockTransferEventSource.instances.push(this);
  }

  emitOpen() {
    this.onopen?.(new Event("open"));
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  close() {}
}

function makeTombstoneTestJob(overrides: Partial<JobView>): JobView {
  return {
    id: "tf-1",
    kind: "transfer",
    status: "completed",
    progress: 100,
    title: "歌单迁移任务",
    createdAt: 1000,
    updatedAt: 1000,
    downloadReady: false,
    artifactExpired: false,
    ...overrides,
  };
}

function JobEventsMount() {
  useJobEvents(true);
  return null;
}

describe("PP-04 · TransferPage clearFinishedJobs tombstone protection", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockTransferEventSource.instances = [];
    globalThis.EventSource = MockTransferEventSource as unknown as typeof EventSource;
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();
  });

  afterEach(() => {
    cleanup();
    globalThis.EventSource = originalEventSource;
    useToastStore.getState().clear();
    clearPendingDirectLinkJobs();
    vi.restoreAllMocks();
  });

  it("calls markFinishedJobsCleared on clearFinishedMutation success so an in-flight listJobs snapshot cannot resurrect cleared jobs", async () => {
    const completedJob = makeTombstoneTestJob({
      id: "tf-done",
      status: "completed",
      title: "已完成的迁移",
      createdAt: 2000,
      updatedAt: 2000,
    });
    const runningJob = makeTombstoneTestJob({
      id: "tf-running",
      status: "running",
      progress: 50,
      title: "进行中的迁移",
      createdAt: 1000,
      updatedAt: 1000,
    });

    let listCalls = 0;
    let resolveInFlightList!: (res: { jobs: JobView[] }) => void;
    vi.spyOn(api, "listJobs").mockImplementation(() => {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({ jobs: [completedJob, runningJob] });
      }
      if (listCalls === 2) {
        return new Promise((resolve) => {
          resolveInFlightList = resolve;
        });
      }
      return Promise.resolve({ jobs: [runningJob] });
    });

    const clearSpy = vi.spyOn(api, "clearFinishedJobs").mockResolvedValueOnce({ removedCount: 1 });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <JobEventsMount />
        <TransferPage />
        <ToastContainer />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("已完成的迁移")).toBeInTheDocument();
      expect(screen.getByText("进行中的迁移")).toBeInTheDocument();
    });

    const es = MockTransferEventSource.instances[0];
    if (!es) throw new Error("Expected MockTransferEventSource");
    act(() => {
      es.emitOpen();
    });

    // Trigger an overlapping listJobs snapshot (#2) that stays in flight while user clears finished jobs
    act(() => {
      es.emitError();
      es.emitOpen();
    });
    await waitFor(() => expect(listCalls).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "清除已结束" }));
    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalledWith("transfer");
      expect(screen.getByText("已清除 1 条已结束任务")).toBeInTheDocument();
    });

    // Now the stale in-flight listJobs (#2) resolves with both jobs: tf-done MUST NOT resurrect
    await act(async () => {
      resolveInFlightList({ jobs: [completedJob, runningJob] });
    });

    await waitFor(() => {
      expect(screen.queryByText("已完成的迁移")).toBeNull();
    });
    expect(screen.getByText("进行中的迁移")).toBeInTheDocument();
    expect(
      queryClient.getQueryData<{ jobs: JobView[] }>(["jobs", "transfer"])?.jobs.map((j) => j.id),
    ).toEqual(["tf-running"]);
  });
});

describe("TransferPage · P1-1 lazy history detail & P1-2 manualDecision reset UI", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("collapses older completed jobs by default and fetches api.getJob(id) only when expanded", async () => {
    const makeSummary = (overrides: Partial<JobSummaryView>): JobSummaryView => ({
      id: "job-summary-1",
      kind: "transfer",
      status: "completed",
      progress: 100,
      title: "歌单迁移任务",
      hasResult: true,
      createdAt: 1000,
      updatedAt: 1000,
      ...overrides,
    });

    const makeDetailResult = (trackTitle: string, withManualDecision = false): TransferResult => ({
      sourceProvider: "netease",
      targetProvider: "qq",
      playlistName: "测试歌单",
      summary: {
        total: 1,
        matched: 1,
        manualReview: 0,
        notFound: 0,
        unavailable: 0,
        duplicate: 0,
        skipped: 0,
      },
      results: [
        {
          sourceTrack: {
            source: "netease",
            sourceTrackId: "s-1",
            title: trackTitle,
            artists: ["周杰伦"],
          },
          status: "matched",
          candidates: [
            {
              provider: "qq",
              targetTrackId: "qq-1",
              title: trackTitle,
              artists: ["周杰伦"],
              availability: "playable",
              confidenceScore: 95,
              reasons: ["歌名与歌手一致"],
            },
          ],
          selectedCandidate: {
            provider: "qq",
            targetTrackId: "qq-1",
            title: trackTitle,
            artists: ["周杰伦"],
            availability: "playable",
            confidenceScore: 95,
            reasons: ["歌名与歌手一致"],
          },
          ...(withManualDecision
            ? {
                initialMatch: {
                  status: "manual_review",
                  reason: "初始需人工确认",
                },
                manualDecision: {
                  action: "select",
                  targetTrackId: "qq-1",
                  updatedAt: 2000,
                },
              }
            : {}),
        },
      ],
    });

    const latestSummary = makeSummary({
      id: "tf-latest",
      title: "最新迁移任务",
      createdAt: 2000,
      updatedAt: 2000,
    });
    const olderSummary = makeSummary({
      id: "tf-older",
      title: "历史迁移任务",
      createdAt: 1000,
      updatedAt: 1000,
    });

    vi.spyOn(api, "listJobs").mockResolvedValue({
      jobs: [latestSummary, olderSummary],
      serverRevision: 10,
    });

    const getJobSpy = vi.spyOn(api, "getJob").mockImplementation(async (id) => {
      if (id === "tf-latest") {
        return {
          job: {
            ...latestSummary,
            result: makeDetailResult("最新曲目"),
          } satisfies JobDetailView,
        };
      }
      return {
        job: {
          ...olderSummary,
          result: makeDetailResult("历史展开曲目", true),
        } satisfies JobDetailView,
      };
    });

    renderTransferPage();

    await waitFor(() => {
      expect(screen.getByText("最新曲目")).toBeInTheDocument();
    });
    expect(getJobSpy).toHaveBeenCalledTimes(1);
    expect(getJobSpy).toHaveBeenCalledWith("tf-latest");
    expect(screen.queryByText("历史展开曲目")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开详情" }));

    await waitFor(() => {
      expect(screen.getByText("历史展开曲目")).toBeInTheDocument();
    });
    expect(getJobSpy).toHaveBeenCalledTimes(2);
    expect(getJobSpy).toHaveBeenCalledWith("tf-older");
    expect(screen.getByText("人工已选")).toBeInTheDocument();
    expect(screen.getByText(/可重置无损恢复为初始结果：待确认/)).toBeInTheDocument();
    expect(screen.getByTitle("无损恢复为初始状态：待确认")).toBeInTheDocument();
  });
});
