import assert from "node:assert/strict";
import test from "node:test";
import { createClientSessionIdAccessor, getDirectDownloadUrl, getServerDownloadUrl } from "./api";
import type { Song } from "./types";

const song: Song = {
  id: "song-1",
  title: "Bounded Song",
  artist: "TrackVault",
  album: "Memory Safety",
  duration: "03:00",
  quality: "FLAC",
  availableQualities: [],
  source: "netease",
  mediaId: "media-1",
  providerSongId: "provider-1",
  coverUrl: "https://music.126.net/cover.jpg"
};

test("server download URL defaults to tagged metadata, passes provider identifiers, and keeps explicit raw fallback", () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: () => "test-session-id",
        setItem: () => undefined
      }
    }
  });

  try {
    const serverUrl = new URL(getServerDownloadUrl(song, "lossless"), "http://trackvault.local");
    const rawServerUrl = new URL(getServerDownloadUrl(song, "lossless", "raw"), "http://trackvault.local");
    const directUrl = new URL(getDirectDownloadUrl(song, "lossless"), "http://trackvault.local");
    assert.equal(serverUrl.pathname, "/api/download/proxy");
    assert.equal(serverUrl.searchParams.has("metadata"), false);
    assert.equal(rawServerUrl.searchParams.get("metadata"), "raw");
    assert.equal(serverUrl.searchParams.get("source"), "netease");
    assert.equal(serverUrl.searchParams.get("mediaId"), "media-1");
    assert.equal(serverUrl.searchParams.get("providerSongId"), "provider-1");
    assert.equal(serverUrl.searchParams.get("coverUrl"), "https://music.126.net/cover.jpg");
    assert.equal(serverUrl.searchParams.get("sid"), "test-session-id");
    assert.equal(directUrl.pathname, "/api/download/direct");
    assert.equal(directUrl.searchParams.has("metadata"), false);
    assert.equal(directUrl.searchParams.get("sid"), "test-session-id");
  } finally {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  }
});

test("client session fallback reuses one in-memory UUID per page accessor", () => {
  let generated = 0;
  const createAccessor = () => createClientSessionIdAccessor({
    readStored: () => {
      throw new Error("localStorage unavailable");
    },
    writeStored: () => {
      throw new Error("localStorage unavailable");
    },
    randomUUID: () => `memory-session-${++generated}`
  });

  const firstPage = createAccessor();
  assert.equal(firstPage(), "memory-session-1");
  assert.equal(firstPage(), "memory-session-1");

  const refreshedPage = createAccessor();
  assert.equal(refreshedPage(), "memory-session-2");
});

test("client session accessor replaces invalid and default stored identifiers", () => {
  const writes: string[] = [];
  for (const stored of ["default", "bad!sid", "a".repeat(65)]) {
    const getSessionId = createClientSessionIdAccessor({
      readStored: () => stored,
      writeStored: (value) => writes.push(value),
      randomUUID: () => "valid-memory-session"
    });
    assert.equal(getSessionId(), "valid-memory-session");
  }
  assert.deepEqual(writes, ["valid-memory-session", "valid-memory-session", "valid-memory-session"]);
});
