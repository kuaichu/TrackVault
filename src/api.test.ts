import assert from "node:assert/strict";
import test from "node:test";
import { createClientSessionIdAccessor, getDirectDownloadUrl, getServerDownloadUrl, startServerSongDownload } from "./api";
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

test("server download URL passes provider identifiers without metadata modes", () => {
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
    assert.equal(serverUrl.searchParams.has("metadata"), false);
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

test("server download reads the response in the current page and saves a Blob with progress", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  let fetchInput = "";
  let fetchInit: RequestInit | undefined;
  let appendCalls = 0;
  let clickCalls = 0;
  let removeCalls = 0;
  let createdBlob: Blob | null = null;
  const link: Record<string, unknown> = {
    click: () => { clickCalls += 1; },
    remove: () => { removeCalls += 1; }
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => "test-session-id", setItem: () => undefined },
      URL: {
        createObjectURL: (blob: Blob) => { createdBlob = blob; return "blob:test"; },
        revokeObjectURL: () => undefined
      },
      setTimeout: (callback: () => void) => { callback(); return 0; }
    }
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
  globalThis.fetch = async (input, init) => {
    fetchInput = String(input);
    fetchInit = init;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }
    }), {
      headers: {
        "content-disposition": "attachment; filename=\"____.mp3\"; filename*=UTF-8''%E6%9B%B2%E7%9B%AE.mp3",
        "content-length": "4",
        "content-type": "audio/mpeg",
        "x-trackvault-quality": "lossless"
      }
    });
  };

  try {
    const statuses: string[] = [];
    const progress: Array<{ progress: number; receivedBytes: number; totalBytes?: number; speedBytesPerSecond?: number }> = [];
    let ready: { filename: string; sizeBytes?: number; quality?: string } | undefined;
    await startServerSongDownload(song, "lossless", {
      onStatus: (status) => statuses.push(status),
      onReady: (info) => { ready = info; },
      onProgress: (info) => progress.push(info)
    });
    const href = new URL(fetchInput, "http://trackvault.local");
    assert.equal(href.pathname, "/api/download/proxy");
    assert.equal(href.searchParams.get("sid"), "test-session-id");
    assert.equal(href.searchParams.has("metadata"), false);
    assert.equal(new Headers(fetchInit?.headers).get("x-client-session-id"), "test-session-id");
    assert.equal(appendCalls, 1);
    assert.equal(clickCalls, 1);
    assert.equal(removeCalls, 1);
    assert.equal(link.target, undefined);
    assert.equal(link.rel, undefined);
    assert.equal(link.download, "曲目.mp3");
    assert.deepEqual(statuses, ["服务器已返回文件，正在保存到本机。"]);
    assert.deepEqual(ready, { filename: "曲目.mp3", sizeBytes: 4, quality: "lossless" });
    const lastProgress = progress[progress.length - 1];
    assert.equal(lastProgress?.progress, 100);
    assert.equal(lastProgress?.receivedBytes, 4);
    assert.equal(lastProgress?.totalBytes, 4);
    const savedBlob = createdBlob as Blob | null;
    if (!savedBlob) {
      throw new Error("Blob was not saved");
    }
    assert.equal(savedBlob.size, 4);
    assert.equal(savedBlob.type, "audio/mpeg");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  }
});

test("server download exposes HTTP errors without opening a new tab", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => "error-session", setItem: () => undefined } }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => { throw new Error("download link should not be created"); } }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "Range 不可用" }), {
    status: 409,
    headers: { "content-type": "application/json" }
  });

  try {
    await assert.rejects(startServerSongDownload(song, "lossless"), /Range 不可用/);
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
