import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompareResult, ImportAuditResult, JobView, TransferResult, TransferTrackResult } from "#shared";
import { api } from "../../shared/api/endpoints.js";
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
      await screen.findByText(/源歌单共 250 首，本次已处理前 65 首（未处理 185 首）/),
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
