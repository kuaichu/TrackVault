import assert from "node:assert/strict";
import test from "node:test";
import { createClientSessionIdAccessor, getDirectDownloadUrl, getServerDownloadUrl, SERVER_DOWNLOAD_HANDOFF_MESSAGE, startServerSongDownload } from "./api";
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

test("server download handoff synchronously navigates one proxy tab without direct preflight or download attribute", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let appendCalls = 0;
  let clickCalls = 0;
  let removeCalls = 0;
  const link: Record<string, unknown> = {
    click: () => { clickCalls += 1; },
    remove: () => { removeCalls += 1; }
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => "handoff-session", setItem: () => undefined } }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, "a");
        return link;
      },
      body: {
        appendChild: (value: unknown) => {
          assert.equal(value, link);
          appendCalls += 1;
        }
      }
    }
  });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ message: "proxy failed" }), { status: 502 });
  };

  try {
    const handoff = startServerSongDownload(song, "lossless");
    const href = new URL(String(link.href), "http://trackvault.local");
    assert.equal(fetchCalls, 0);
    assert.equal(appendCalls, 1);
    assert.equal(clickCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(href.pathname, "/api/download/proxy");
    assert.equal(href.searchParams.get("sid"), "test-session-id");
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.equal(Object.prototype.hasOwnProperty.call(link, "download"), false);
    assert.equal(handoff.status, "preparing");
    assert.notEqual(handoff.status, "done");
    assert.equal(handoff.handedOff, true);
    assert.equal(handoff.detail, SERVER_DOWNLOAD_HANDOFF_MESSAGE);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
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
