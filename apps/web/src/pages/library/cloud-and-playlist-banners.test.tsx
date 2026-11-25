import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobView, Song, TransferResult } from "#shared";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { DEFAULT_PROVIDER_CAPABILITIES } from "../../shared/hooks/use-capabilities.js";
import { useToastStore } from "../../shared/store/toast-store.js";
import {
  createTestQueryClient,
  makeTestJob,
  makeTestSettings,
  makeTestSong,
  renderWithProviders,
} from "../../test-utils/fixtures.js";
import { SongTable } from "../../widgets/song-table/index.js";
import { TransferPage } from "../transfer/index.js";
import { CloudPage, HistoryPage, PlaylistDetailPage } from "./index.js";

describe("Library pages, cloud pagination, table click semantics, and transfer banners", () => {
  beforeEach(() => {
    vi.spyOn(api, "getCapabilities").mockResolvedValue({ capabilities: DEFAULT_PROVIDER_CAPABILITIES });
    vi.spyOn(api, "getSettings").mockResolvedValue({ settings: makeTestSettings() });
    vi.spyOn(api, "getLikedSongIds").mockResolvedValue({ ids: [] });
    vi.spyOn(api, "savePlayerState").mockImplementation(async (state) => ({ state }));
    vi.spyOn(api, "recordPlayHistory").mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PlaylistDetailPage renders >10,000 search/sort truncation warning banner", async () => {
    vi.spyOn(api, "getPlaylistTracks").mockResolvedValueOnce({
      playlist: {
        id: "pl-big",
        platform: "netease",
        name: "万首歌单",
        trackCount: 12_500,
        creatorName: "Tester",
        owned: false,
      },
      songs: [makeTestSong("s-1")],
      total: 1,
      page: 1,
      limit: 50,
      hasMore: false,
      truncated: true,
      scannedTotal: 10_000,
    });

    renderWithProviders(<PlaylistDetailPage />, {
      initialEntries: ["/playlists/netease/pl-big"],
      routePath: "/playlists/:platform/:id",
    });

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("10,000");
    });
  });

  it("CloudPage advances cursor with nextOffset=100 on 99-item page 0 and queues all 205 songs on Play All", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    const seenOffsets: number[] = [];

    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      seenOffsets.push(offset);
      if (offset === 0) {
        return {
          songs: Array.from({ length: 99 }, (_, i) => makeTestSong(`c-${i + 1}`)),
          total: 205,
          offset: 0,
          nextOffset: 100,
          limit: 100,
          hasMore: true,
        };
      }
      if (offset === 100) {
        return {
          songs: Array.from({ length: 100 }, (_, i) => makeTestSong(`c-${101 + i}`)),
          total: 205,
          offset: 100,
          nextOffset: 200,
          limit: 100,
          hasMore: true,
        };
      }
      return {
        songs: Array.from({ length: 6 }, (_, i) => makeTestSong(`c-${201 + i}`)),
        total: 205,
        offset: 200,
        nextOffset: 206,
        limit: 100,
        hasMore: false,
      };
    });

    renderWithProviders(<CloudPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "播放全部" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));

    await waitFor(() => {
      expect(playSpy).toHaveBeenCalledTimes(1);
    });
    expect(seenOffsets).toEqual([0, 100, 200]);
    expect(playSpy.mock.calls[0]?.[1]?.queue).toHaveLength(205);
  });

  it("CloudPage retains page 1, aborts premature playback on page 2 error, and recovers on retry", async () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    let failPage2 = true;

    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) {
        return {
          songs: [makeTestSong("c1", { title: "云盘首曲保留" })],
          total: 2,
          offset: 0,
          nextOffset: 100,
          limit: 100,
          hasMore: true,
        };
      }
      if (failPage2) {
        throw new Error("云盘第二页超时");
      }
      return {
        songs: [makeTestSong("c2", { title: "云盘二页曲" })],
        total: 2,
        offset: 100,
        nextOffset: 101,
        limit: 100,
        hasMore: false,
      };
    });

    renderWithProviders(<CloudPage />);
    await waitFor(() => expect(screen.getByText("云盘首曲保留")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    await waitFor(() => {
      expect(useToastStore.getState().items.some((t) => t.message.includes("云盘后续分页加载失败"))).toBe(
        true,
      );
    });

    expect(playSpy).not.toHaveBeenCalled();
    expect(screen.getByText("云盘首曲保留")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试加载更多" })).toBeInTheDocument();

    failPage2 = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
    await waitFor(() => expect(screen.getByText("云盘二页曲")).toBeInTheDocument());
  });

  it("CloudPage Play All yields to newer user track selection while page 2 is pending", async () => {
    let releaseCloudPage2: (() => void) | undefined;

    vi.spyOn(api, "getCloudSongs").mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) {
        return {
          songs: [makeTestSong("cloud-1", { title: "云盘一" }), makeTestSong("cloud-2", { title: "云盘二" })],
          total: 3,
          offset: 0,
          nextOffset: 2,
          limit: 2,
          hasMore: true,
        };
      }
      await new Promise<void>((resolve) => {
        releaseCloudPage2 = resolve;
      });
      return {
        songs: [makeTestSong("cloud-3", { title: "云盘三" })],
        total: 3,
        offset: 2,
        nextOffset: 3,
        limit: 2,
        hasMore: false,
      };
    });

    const playedTrackIds: string[] = [];
    const origPlayTrack = audioEngine.playTrack.bind(audioEngine);
    vi.spyOn(audioEngine, "playTrack").mockImplementation(async (song, opts) => {
      playedTrackIds.push(song.id);
      return origPlayTrack(song, opts);
    });

    renderWithProviders(<CloudPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: "云盘二" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    const song2Btn = screen.getByRole("button", { name: "云盘二" });
    fireEvent.click(song2Btn, { detail: 0 });
    expect(playedTrackIds).toEqual(["cloud-2"]);

    await act(async () => {
      releaseCloudPage2?.();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "云盘三" })).toBeInTheDocument());
    expect(playedTrackIds).toEqual(["cloud-2"]);
  });

  it("SongTable deduplicates 400ms and 650ms OS double-clicks (detail=2) while firing twice for independent detail=1 clicks", () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);
    let fakeNow = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    renderWithProviders(<SongTable songs={[makeTestSong("dc-1", { title: "双击防抖曲" })]} />);
    const titleBtn = screen.getByRole("button", { name: "双击防抖曲" });

    // 420ms OS double-click (detail=1 -> detail=2) plays once
    fireEvent.click(titleBtn, { detail: 1 });
    fakeNow += 420;
    fireEvent.click(titleBtn, { detail: 2 });
    fireEvent.doubleClick(titleBtn, { detail: 2 });
    expect(playSpy).toHaveBeenCalledTimes(1);

    // 650ms OS double-click (detail=1 -> detail=2) plays once
    playSpy.mockClear();
    fakeNow += 2000;
    fireEvent.click(titleBtn, { detail: 1 });
    fakeNow += 650;
    fireEvent.click(titleBtn, { detail: 2 });
    fireEvent.doubleClick(titleBtn, { detail: 2 });
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Two independent detail=1 clicks 420ms apart play twice
    playSpy.mockClear();
    fakeNow += 2000;
    fireEvent.click(titleBtn, { detail: 1 });
    fakeNow += 420;
    fireEvent.click(titleBtn, { detail: 1 });
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it("SongTable activates both native keyboard clicks with detail=0", () => {
    const playSpy = vi.spyOn(audioEngine, "playTrack").mockResolvedValue(undefined);

    renderWithProviders(<SongTable songs={[makeTestSong("kb-1", { title: "键盘曲" })]} />);
    const titleBtn = screen.getByRole("button", { name: "键盘曲" });

    fireEvent.click(titleBtn, { detail: 0 });
    fireEvent.click(titleBtn, { detail: 0 });

    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it("TransferPage displays playlistTotal vs selected count even when truncated is false", async () => {
    const transferJob: JobView = makeTestJob({
      id: "transfer-t11-ui",
      kind: "transfer",
      status: "completed",
      progress: 100,
      title: "选中曲目迁移",
      result: {
        sourceProvider: "netease",
        targetProvider: "qq",
        playlistName: "选中曲目迁移",
        summary: {
          total: 1,
          matched: 1,
          manualReview: 0,
          notFound: 0,
          unavailable: 0,
          duplicate: 0,
          skipped: 0,
        },
        results: [],
        sourceTotal: 2,
        playlistTotal: 2501,
        processedCount: 1,
        unprocessedCount: 1,
        truncated: false,
      } satisfies TransferResult,
    });
    vi.spyOn(api, "listJobs").mockResolvedValue({ jobs: [transferJob] });

    renderWithProviders(<TransferPage />);

    await waitFor(() => {
      expect(screen.getByText(/源歌单共 2501 首，已选 2 首/)).toBeInTheDocument();
    });
  });

  it("HistoryPage recovers cancelled initial GET when clear fails", async () => {
    const olderSong = makeTestSong("h-older", { title: "旧播放记录" });
    const newerSong = makeTestSong("h-newer", { title: "新播放记录" });

    const failClearQc = createTestQueryClient();
    failClearQc.setQueryData(["play-history"], { items: [olderSong] });

    let historyGetCount = 0;
    let resolveInterruptedGet: ((res: { items: Song[] }) => void) | undefined;
    vi.spyOn(api, "getPlayHistory").mockImplementation(() => {
      historyGetCount += 1;
      if (historyGetCount === 1) {
        return new Promise((resolve) => {
          resolveInterruptedGet = resolve;
        });
      }
      return Promise.resolve({ items: [newerSong, olderSong] });
    });
    vi.spyOn(api, "clearPlayHistory").mockRejectedValueOnce(new Error("503 Clear Failed"));

    renderWithProviders(<HistoryPage />, { queryClient: failClearQc });
    await waitFor(() => expect(historyGetCount).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() => {
      expect(failClearQc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
        "h-newer",
        "h-older",
      ]);
    });
    resolveInterruptedGet?.({ items: [newerSong, olderSong] });
  });
});
