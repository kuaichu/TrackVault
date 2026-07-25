import assert from "node:assert/strict";
import test from "node:test";
import { getDirectDownloadUrl, getServerDownloadUrl } from "./api";
import type { Song } from "./types";

const song: Song = {
  id: "song-1",
  title: "Bounded Song",
  artist: "TrackVault",
  album: "Memory Safety",
  duration: "03:00",
  quality: "FLAC",
  availableQualities: [],
  source: "netease"
};

test("server download URL explicitly selects raw native streaming while direct metadata stays clean", () => {
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
    const directUrl = new URL(getDirectDownloadUrl(song, "lossless"), "http://trackvault.local");
    assert.equal(serverUrl.pathname, "/api/download/proxy");
    assert.equal(serverUrl.searchParams.get("metadata"), "raw");
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
