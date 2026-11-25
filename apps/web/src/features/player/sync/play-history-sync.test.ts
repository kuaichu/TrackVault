import { afterEach, describe, expect, it, vi } from "vitest";
import type { Song } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { createTestQueryClient, makeTestSong } from "../../../test-utils/fixtures.js";
import {
  abortPlayHistoryClear,
  applyClearedPlayHistory,
  applyRecordedPlayHistory,
  beginPlayHistoryClear,
  beginPlayHistoryRecord,
  fetchSyncedPlayHistory,
} from "./play-history-sync.js";

describe("play-history-sync · revision watermark & causal ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects stale GET, POST, and DELETE responses with lower server revision", async () => {
    const qc = createTestQueryClient();
    const s1 = makeTestSong("s1");
    const s2 = makeTestSong("s2");

    applyRecordedPlayHistory(qc, { items: [s2, s1], revision: 5 });
    expect(qc.getQueryData<{ items: Song[]; revision?: number }>(["play-history"])).toEqual({
      items: [s2, s1],
      revision: 5,
    });

    applyRecordedPlayHistory(qc, { items: [s1], revision: 4 });
    expect(
      qc.getQueryData<{ items: Song[]; revision?: number }>(["play-history"])?.items.map((s) => s.id),
    ).toEqual(["s2", "s1"]);

    vi.spyOn(api, "getPlayHistory").mockResolvedValueOnce({ items: [s1], revision: 3 });
    const fetchedStale = await fetchSyncedPlayHistory(qc);
    expect(fetchedStale.items.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(fetchedStale.revision).toBe(5);

    applyClearedPlayHistory(qc, { items: [], revision: 6 });
    expect(qc.getQueryData<{ items: Song[]; revision?: number }>(["play-history"])).toEqual({
      items: [],
      revision: 6,
    });

    const s3 = makeTestSong("s3");
    applyRecordedPlayHistory(qc, { items: [s3], revision: 7 });
    applyClearedPlayHistory(qc, { items: [], revision: 5 });
    expect(
      qc.getQueryData<{ items: Song[]; revision?: number }>(["play-history"])?.items.map((s) => s.id),
    ).toEqual(["s3"]);
  });

  it("rejects older POST resolving after clear and preserves newer POST when late clear ack arrives", () => {
    const qc = createTestQueryClient();
    const olderSong = makeTestSong("f14-older");
    const newerSong = makeTestSong("f14-newer");

    const olderPostSeq = beginPlayHistoryRecord(qc);
    const clearSeq1 = beginPlayHistoryClear(qc);
    applyClearedPlayHistory(qc, { items: [] }, clearSeq1);
    applyRecordedPlayHistory(qc, { items: [olderSong] }, olderPostSeq, olderSong);
    expect(qc.getQueryData<{ items: Song[] }>(["play-history"])?.items ?? []).toEqual([]);

    const clearSeq2 = beginPlayHistoryClear(qc);
    const newerPostSeq = beginPlayHistoryRecord(qc);
    applyRecordedPlayHistory(qc, { items: [newerSong] }, newerPostSeq, newerSong);
    applyClearedPlayHistory(qc, { items: [] }, clearSeq2);
    expect(qc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
      "f14-newer",
    ]);
  });

  it("preserves other-tab history loaded after clear alongside subsequent local play", async () => {
    const qc = createTestQueryClient();
    const clearSeq = beginPlayHistoryClear(qc);
    applyClearedPlayHistory(qc, { items: [] }, clearSeq);

    const otherTabSong = makeTestSong("other-tab");
    const localSong = makeTestSong("local-tab");
    vi.spyOn(api, "getPlayHistory").mockResolvedValueOnce({ items: [otherTabSong] });

    const syncedGet = await fetchSyncedPlayHistory(qc);
    qc.setQueryData(["play-history"], syncedGet);

    const localStartSeq = beginPlayHistoryRecord(qc);
    applyRecordedPlayHistory(qc, { items: [localSong, otherTabSong] }, localStartSeq, localSong);

    expect(qc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
      "local-tab",
      "other-tab",
    ]);
  });

  it("restores pre-clear and overlapping in-flight items when clear fails via abortPlayHistoryClear", async () => {
    const qc = createTestQueryClient();
    const preSong = makeTestSong("pre-clear-row");
    const midSong = makeTestSong("during-clear-row");

    vi.spyOn(api, "getPlayHistory").mockResolvedValueOnce({ items: [preSong] });
    qc.setQueryData(["play-history"], await fetchSyncedPlayHistory(qc));

    const failingClearSeq = beginPlayHistoryClear(qc);
    const midRecSeq = beginPlayHistoryRecord(qc);
    applyRecordedPlayHistory(qc, { items: [midSong, preSong] }, midRecSeq, midSong);

    abortPlayHistoryClear(qc, failingClearSeq);
    expect(qc.getQueryData<{ items: Song[] }>(["play-history"])?.items.map((s) => s.id)).toEqual([
      "during-clear-row",
      "pre-clear-row",
    ]);
  });
});
