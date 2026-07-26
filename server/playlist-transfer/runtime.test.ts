import assert from "node:assert/strict";
import test from "node:test";
import { createPlaylistTransferRuntime } from "./runtime.js";
import type { PlaylistTransferRuntimeDependencies } from "./runtime.js";
import type { MatchCandidate, ProviderTrack, TransferImportRequest, TransferTrack } from "./types.js";

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<PlaylistTransferRuntimeDependencies> = {}
): PlaylistTransferRuntimeDependencies {
  return {
    searchNeteaseProviderTracks: async () => unexpectedDependency("searchNeteaseProviderTracks"),
    searchQqProviderTracks: async () => unexpectedDependency("searchQqProviderTracks"),
    loadNeteasePlaylistTransferTracks: async () => unexpectedDependency("loadNeteasePlaylistTransferTracks"),
    loadQqPlaylistTransferTracks: async () => unexpectedDependency("loadQqPlaylistTransferTracks"),
    checkNeteaseProviderTrackAvailability: async () => unexpectedDependency("checkNeteaseProviderTrackAvailability"),
    ...overrides
  };
}

const sourceTrack: TransferTrack = {
  source: "netease",
  sourceTrackId: "source-42",
  title: "Track title",
  artists: ["Artist"],
  album: "Album",
  durationSeconds: 123
};

const candidate: MatchCandidate = {
  provider: "netease",
  targetTrackId: "target-42",
  title: "Track title",
  artists: ["Artist"],
  confidenceScore: 1,
  reasons: []
};

function importRequest(overrides: Partial<TransferImportRequest>): TransferImportRequest {
  return {
    sourceProvider: "netease",
    targetProvider: "qq",
    ...overrides
  };
}

test("returns the same-provider source track without searching", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());

  assert.deepEqual(await runtime.searchTargetTracks(sourceTrack, "netease"), [{
    provider: "netease",
    id: "source-42",
    title: "Track title",
    artists: sourceTrack.artists,
    album: "Album",
    durationSeconds: 123
  }]);
});

test("searches the Netease provider for other-source tracks", async () => {
  const expected: ProviderTrack[] = [{ provider: "netease", id: "n-1", title: "N", artists: ["Artist"] }];
  const calls: TransferTrack[] = [];
  const runtime = createPlaylistTransferRuntime(createDependencies({
    searchNeteaseProviderTracks: async (track) => {
      calls.push(track);
      return expected;
    }
  }));
  const track = { ...sourceTrack, source: "qq" as const };

  assert.equal(await runtime.searchTargetTracks(track, "netease"), expected);
  assert.deepEqual(calls, [track]);
});

test("searches the QQ provider for other-source tracks", async () => {
  const expected: ProviderTrack[] = [{ provider: "qq", id: "q-1", title: "Q", artists: ["Artist"] }];
  const calls: TransferTrack[] = [];
  const runtime = createPlaylistTransferRuntime(createDependencies({
    searchQqProviderTracks: async (track) => {
      calls.push(track);
      return expected;
    }
  }));

  assert.equal(await runtime.searchTargetTracks(sourceTrack, "qq"), expected);
  assert.deepEqual(calls, [sourceTrack]);
});

test("returns no candidates for unsupported target providers", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());

  assert.deepEqual(await runtime.searchTargetTracks(sourceTrack, "text"), []);
});

test("loads a Netease source playlist without normalizing its ID", async () => {
  const expected = [{ ...sourceTrack, sourceTrackId: "loaded-n" }];
  const playlistIds: string[] = [];
  const runtime = createPlaylistTransferRuntime(createDependencies({
    loadNeteasePlaylistTransferTracks: async (playlistId) => {
      playlistIds.push(playlistId);
      return expected;
    }
  }));

  assert.equal(await runtime.loadSourceTracks(importRequest({ playlistId: "  netease-id  " })), expected);
  assert.deepEqual(playlistIds, ["  netease-id  "]);
});

test("rejects a missing Netease playlist ID with the existing message", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());

  await assert.rejects(runtime.loadSourceTracks(importRequest({ playlistId: "" })), {
    message: "缺少网易云歌单 ID"
  });
});

test("loads a QQ source playlist without normalizing its ID", async () => {
  const expected = [{ ...sourceTrack, source: "qq" as const, sourceTrackId: "loaded-q" }];
  const playlistIds: string[] = [];
  const runtime = createPlaylistTransferRuntime(createDependencies({
    loadQqPlaylistTransferTracks: async (playlistId) => {
      playlistIds.push(playlistId);
      return expected;
    }
  }));

  assert.equal(await runtime.loadSourceTracks(importRequest({
    sourceProvider: "qq",
    playlistId: "  qq-id  "
  })), expected);
  assert.deepEqual(playlistIds, ["  qq-id  "]);
});

test("rejects a missing QQ playlist ID with the existing message", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());

  await assert.rejects(runtime.loadSourceTracks(importRequest({ sourceProvider: "qq" })), {
    message: "缺少 QQ 音乐歌单 ID"
  });
});

test("returns no tracks for non-provider source types", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());

  assert.deepEqual(await runtime.loadSourceTracks(importRequest({ sourceProvider: "text" })), []);
});

test("checks Netease target availability", async () => {
  const expected = { status: "vip_only" as const, reason: "VIP only" };
  const calls: MatchCandidate[] = [];
  const runtime = createPlaylistTransferRuntime(createDependencies({
    checkNeteaseProviderTrackAvailability: async (value) => {
      calls.push(value);
      return expected;
    }
  }));

  assert.equal(await runtime.checkAvailability(candidate), expected);
  assert.deepEqual(calls, [candidate]);
});

test("does not check availability for QQ or unknown providers", async () => {
  const runtime = createPlaylistTransferRuntime(createDependencies());
  const qqCandidate = { ...candidate, provider: "qq" as const };
  const unknownCandidate = { ...candidate, provider: "unknown" } as unknown as MatchCandidate;

  assert.equal(await runtime.checkAvailability(qqCandidate), null);
  assert.equal(await runtime.checkAvailability(unknownCandidate), null);
});
