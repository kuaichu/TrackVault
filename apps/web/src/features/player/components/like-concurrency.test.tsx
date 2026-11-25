import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsSongLiked, useLikedIdsQuery, useToggleLikeMutation } from "../../../entities/song/index.js";
import { api } from "../../../shared/api/endpoints.js";
import {
  createTestQueryClient,
  createTestQueryWrapper,
  makeTestSong,
  renderWithProviders,
} from "../../../test-utils/fixtures.js";
import { usePlayerStore } from "../store/player-store.js";

describe("Like concurrency & unloaded liked-ids protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves unloaded ['liked-ids'] undefined and captures {platform, songId} across track switches", async () => {
    const qc = createTestQueryClient();
    vi.spyOn(api, "getLikedSongIds").mockImplementation(() => new Promise(() => {}));

    let resolveLike: ((res: { liked: boolean }) => void) | undefined;
    const toggleSpy = vi.spyOn(api, "toggleSongLike").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLike = resolve;
        }),
    );

    const { result } = renderHook(
      () => ({
        mut: useToggleLikeMutation(),
        likeA: useIsSongLiked("netease", "track-a"),
        likeB: useIsSongLiked("netease", "track-b"),
      }),
      { wrapper: createTestQueryWrapper(qc) },
    );

    act(() => {
      result.current.mut.mutate({ platform: "netease", songId: "track-a", nextLiked: true });
    });
    await waitFor(() => expect(toggleSpy).toHaveBeenCalledTimes(1));

    act(() => {
      usePlayerStore.setState({ currentTrack: makeTestSong("track-b") });
    });

    act(() => {
      resolveLike?.({ liked: true });
    });
    await waitFor(() => expect(result.current.mut.isSuccess).toBe(true));

    expect(toggleSpy).toHaveBeenCalledWith("netease", "track-a", true);
    expect(result.current.likeA.liked).toBe(true);
    expect(result.current.likeB.liked).toBe(false);
    expect(qc.getQueryData(["liked-ids", "netease"])).toBeUndefined();
  });

  it("updates ['liked-ids'] incrementally using dynamic platform when already loaded", async () => {
    const qc = createTestQueryClient();
    vi.spyOn(api, "getLikedSongIds").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "toggleSongLike").mockResolvedValueOnce({ liked: true });

    qc.setQueryData(["liked-ids", "qq"], { ids: ["existing-1"] });

    const { result } = renderHook(() => useToggleLikeMutation(), {
      wrapper: createTestQueryWrapper(qc),
    });

    await act(async () => {
      await result.current.mutateAsync({ platform: "qq", songId: "qq-2", nextLiked: true });
    });

    expect(qc.getQueryData(["liked-ids", "qq"])).toEqual({ ids: ["existing-1", "qq-2"] });
  });

  it("preserves newer heart toggle when slow initial getLikedSongIds resolves afterwards", async () => {
    let resolveInitialLikes: ((res: { ids: string[] }) => void) | undefined;
    vi.spyOn(api, "getLikedSongIds")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialLikes = resolve;
          }),
      )
      .mockResolvedValue({ ids: ["old-1", "x-new"] });
    vi.spyOn(api, "toggleSongLike").mockResolvedValue({ liked: true });

    function LikeHarness() {
      const { data } = useLikedIdsQuery("netease", true);
      const mut = useToggleLikeMutation();
      return (
        <div>
          <span data-testid="liked-list">{(data?.ids ?? []).join(",")}</span>
          <button
            type="button"
            onClick={() => mut.mutate({ platform: "netease", songId: "x-new", nextLiked: true })}
          >
            喜欢X
          </button>
        </div>
      );
    }

    renderWithProviders(<LikeHarness />, { withRouter: false });
    fireEvent.click(screen.getByRole("button", { name: "喜欢X" }));
    resolveInitialLikes?.({ ids: ["old-1"] });

    await waitFor(() => {
      expect(screen.getByTestId("liked-list").textContent).toContain("x-new");
    });
  });

  it("recovers cancelled initial liked-ids GET via refetch when toggleSongLike fails", async () => {
    let likedGetCalls = 0;
    vi.spyOn(api, "getLikedSongIds").mockImplementation(async () => {
      likedGetCalls += 1;
      if (likedGetCalls === 1) {
        return new Promise((resolve) => setTimeout(() => resolve({ ids: ["existing-liked"] }), 500));
      }
      return { ids: ["existing-liked"] };
    });
    vi.spyOn(api, "toggleSongLike").mockRejectedValueOnce(new Error("红心接口故障"));

    function FailingLikeHarness() {
      const { data } = useLikedIdsQuery("netease", true);
      const mut = useToggleLikeMutation();
      return (
        <div>
          <span data-testid="recovered-likes">{(data?.ids ?? []).join(",")}</span>
          <button
            type="button"
            onClick={() => mut.mutate({ platform: "netease", songId: "fail-id", nextLiked: true })}
          >
            触发失败红心
          </button>
        </div>
      );
    }

    renderWithProviders(<FailingLikeHarness />, { withRouter: false });
    fireEvent.click(screen.getByRole("button", { name: "触发失败红心" }));

    await waitFor(() => {
      expect(screen.getByTestId("recovered-likes").textContent).toBe("existing-liked");
    });
    expect(likedGetCalls).toBeGreaterThanOrEqual(2);
  });
});
