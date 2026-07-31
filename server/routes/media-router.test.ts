import assert from "node:assert/strict";
import test from "node:test";
import { addAudioMetadataToDownload, getAudioMetadataTarget, hasConflictingAudioFormatDeclaration } from "../download-metadata.js";
import { MediaMemoryLimitExceededError, decideServerMediaHandling, getResponseContentLength, readResponseBytesWithLimit } from "../media-memory-policy.js";
import { withMediaTaggingSlot } from "../media-memory-policy.js";
import { MediaAccessError } from "../media-security.js";
import { resolveQqDirectDownload } from "../qqmusic-provider.js";
import type { Song } from "../types.js";
import { createMediaRouter, type MediaRouterDependencies } from "./media-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };
const bytes = (...values: number[]) => new Uint8Array(values);
const songQuery = "id=1&title=Track&artist=Artist&album=Album&mediaId=mid&providerSongId=provider-id&coverUrl=cover&duration=03%3A00&source=netease&level=lossless";

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected media dependency call: ${name}`);
}

function createDependencies(overrides: Partial<MediaRouterDependencies> = {}): MediaRouterDependencies {
  return {
    fetchImpl: async () => unexpectedDependency("fetchImpl"),
    getHighResolutionCoverUrl: (url) => url,
    getAudioMetadataTarget: () => unexpectedDependency("getAudioMetadataTarget"),
    hasConflictingAudioFormatDeclaration,
    addAudioMetadataToDownload: async () => unexpectedDependency("addAudioMetadataToDownload"),
    decideServerMediaHandling,
    getMaxInMemoryMediaBytes: () => 96 * 1024 * 1024,
    getResponseContentLength,
    readResponseBytesWithLimit,
    withMediaTaggingSlot: async (operation) => operation(),
    resolveQqSongStream: async () => unexpectedDependency("resolveQqSongStream"),
    resolveSongStream: async () => unexpectedDependency("resolveSongStream"),
    resolveDirectDownload: async () => unexpectedDependency("resolveDirectDownload"),
    isMediaAccessError: (error): error is MediaAccessError => error instanceof MediaAccessError,
    isMediaMemoryLimitExceededError: (error): error is MediaMemoryLimitExceededError => error instanceof MediaMemoryLimitExceededError,
    ...overrides
  };
}

function directDownload(overrides: Partial<{ url: string; filename: string; type: string; quality: string }> = {}) {
  return { url: "https://upstream.invalid/audio", filename: "曲目.mp3", type: "mp3", quality: "lossless", ...overrides };
}

test("cover proxy allows image hosts and preserves content headers", timeout, async () => {
  const seen: string[] = [];
  const dependencies = createDependencies({
    getHighResolutionCoverUrl: (url) => `${url}?high=1`,
    fetchImpl: async (input) => {
      seen.push(String(input));
      return new Response(bytes(1, 2, 3), { headers: { "content-type": "image/png" } });
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    const response = await requestRaw("/api/media/cover?url=https%3A%2F%2Fcdn.music.126.net%2Fcover");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=86400");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(1, 2, 3));
  });
  assert.deepEqual(seen, ["https://cdn.music.126.net/cover?high=1"]);
});

test("cover proxy rejects forbidden hosts without fetching", timeout, async () => {
  await withTestRouter([createMediaRouter(createDependencies())], async ({ request }) => {
    const response = await request("/api/media/cover?url=https%3A%2F%2Fevil.example%2Fcover.jpg");
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "封面地址不在允许的音乐图片域名内" });
  });
});

test("cover proxy preserves non-image and upstream errors", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    fetchImpl: async () => ++calls === 1
      ? new Response("no", { headers: { "content-type": "text/plain" } })
      : new Response(null, { status: 404 })
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const first = await request("/api/media/cover?url=https%3A%2F%2Fy.gtimg.cn%2Fa");
    assert.equal(first.status, 415);
    assert.deepEqual(first.body, { message: "封面地址没有返回图片内容" });
    const second = await request("/api/media/cover?url=https%3A%2F%2Fqpic.y.qq.com%2Fb");
    assert.equal(second.status, 404);
    assert.deepEqual(second.body, { message: "封面拉取失败" });
  });
});

test("cover proxy maps the fixed five MiB limit to its existing 413 body", timeout, async () => {
  let observedLimit = 0;
  const dependencies = createDependencies({
    fetchImpl: async () => new Response(bytes(1), { headers: { "content-type": "image/jpeg" } }),
    readResponseBytesWithLimit: async (_response, input) => {
      observedLimit = input.limitBytes;
      throw new MediaMemoryLimitExceededError({ limitBytes: input.limitBytes, contentLength: input.limitBytes + 1 });
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/media/cover?url=https%3A%2F%2Fthirdqq.qlogo.cn%2Fa");
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { message: "封面文件过大" });
  });
  assert.equal(observedLimit, 5 * 1024 * 1024);
});

test("stream rejects missing id", timeout, async () => {
  await withTestRouter([createMediaRouter(createDependencies())], async ({ request }) => {
    const response = await request("/api/stream");
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { message: "缺少歌曲 id" });
  });
});

test("stream maps Netease inputs, Range, status and response headers", timeout, async () => {
  let resolverArgs: unknown[] = [];
  let range = "";
  const dependencies = createDependencies({
    resolveSongStream: async (...args) => {
      resolverArgs = args;
      return { url: "https://upstream.invalid/stream", type: ".flac" };
    },
    fetchImpl: async (_input, init) => {
      range = new Headers(init?.headers).get("range") ?? "";
      return new Response(bytes(4, 5), { status: 206, headers: {
        "accept-ranges": "bytes", "content-length": "2", "content-range": "bytes 2-3/4", "content-type": "application/octet-stream"
      } });
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    const response = await requestRaw("/api/stream?id=42&level=hires&expectedDuration=bad", { headers: { Range: "bytes=2-3", "x-user-cookie": "cookie" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-range"), "bytes 2-3/4");
    assert.equal(response.headers.get("content-type"), "audio/flac");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate, proxy-revalidate");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(4, 5));
  });
  assert.deepEqual(resolverArgs, ["42", "hires", "cookie", 0]);
  assert.equal(range, "bytes=2-3");
});

test("stream maps QQ song inputs and all resolver audio types", timeout, async () => {
  const observedSongs: Song[] = [];
  const formats = [["wav", "audio/wav"], ["aac", "audio/aac"], ["m4a", "audio/mp4"], ["mp3", "audio/mpeg"]] as const;
  let type = "wav";
  const dependencies = createDependencies({
    resolveQqSongStream: async (song) => {
      observedSongs.push(song);
      return { url: `https://upstream.invalid/${type}` };
    },
    fetchImpl: async () => new Response(bytes(1), { headers: { "content-type": type } })
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    for (const [format, mime] of formats) {
      type = format;
      dependencies.resolveQqSongStream = async (song) => {
        observedSongs.push(song);
        return { url: "https://upstream.invalid/audio", type: format } as { url: string };
      };
      const response = await requestRaw(`/api/stream?id=qq&source=qqmusic&mediaId=mid&level=exhigh`);
      assert.equal(response.headers.get("content-type"), mime);
      await response.arrayBuffer();
    }
  });
  assert.equal(observedSongs.length, 4);
  assert.deepEqual(observedSongs[0], { id: "qq", title: "", artist: "", album: "", mediaId: "mid", duration: "", quality: "", availableQualities: [], source: "qqmusic" });
});

test("stream preserves MediaAccessError, QQ and Netease error statuses", timeout, async () => {
  const cases = [
    { source: "netease", error: new MediaAccessError(403, "denied"), status: 403 },
    { source: "qqmusic", error: new Error("qq failed"), status: 409 },
    { source: "netease", error: new Error("netease failed"), status: 502 }
  ];
  for (const item of cases) {
    const dependencies = createDependencies({
      resolveQqSongStream: async () => { throw item.error; },
      resolveSongStream: async () => { throw item.error; }
    });
    await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
      const response = await request(`/api/stream?id=1&source=${item.source}`);
      assert.equal(response.status, item.status);
      assert.deepEqual(response.body, { message: item.error.message });
    });
  }
});

test("direct download maps the full Song, cookie and memory limit", timeout, async () => {
  let observed: unknown[] = [];
  const dependencies = createDependencies({
    getMaxInMemoryMediaBytes: () => 1234,
    resolveDirectDownload: async (...args) => {
      observed = args;
      return directDownload();
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const response = await request(`/api/download/direct?${songQuery}`, { headers: { "x-user-cookie": "secret" } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ...directDownload(), maxInMemoryMediaBytes: 1234 });
  });
  assert.deepEqual(observed, [{ id: "1", title: "Track", artist: "Artist", album: "Album", mediaId: "mid", providerSongId: "provider-id", coverUrl: "cover", duration: "03:00", quality: "", availableQualities: [], source: "netease" }, "lossless", "secret"]);
});

test("direct download preserves validation and error statuses", timeout, async () => {
  await withTestRouter([createMediaRouter(createDependencies())], async ({ request }) => {
    assert.equal((await request("/api/download/direct?id=1")).status, 400);
  });
  for (const [error, status] of [[new MediaAccessError(401, "login"), 401], [new Error("failed"), 502]] as const) {
    const dependencies = createDependencies({ resolveDirectDownload: async () => { throw error; } });
    await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
      const response = await request(`/api/download/direct?${songQuery}`);
      assert.equal(response.status, status);
      assert.deepEqual(response.body, { message: error.message });
    });
  }
});

test("proxy explicit raw paths stream bytes with original status and headers", timeout, async () => {
  const observedRanges: (string | null)[] = [];
  const dependencies = createDependencies({
    getMaxInMemoryMediaBytes: () => 4096,
    resolveDirectDownload: async () => directDownload(),
    fetchImpl: async (_input, init) => {
      observedRanges.push(new Headers(init?.headers).get("range"));
      return new Response(bytes(7, 8), { status: 206, headers: { "content-type": "audio/mpeg", "content-length": "2", "content-range": "bytes 1-2/3" } });
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    for (const [suffix, range] of [[`metadata=raw&${songQuery}`, undefined], [`metadata=raw&${songQuery}`, "bytes=1-2"]] as const) {
      const response = await requestRaw(`/api/download/proxy?${suffix}`, { headers: range ? { Range: range } : undefined });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"__.mp3\"; filename*=UTF-8''%E6%9B%B2%E7%9B%AE.mp3");
      assert.equal(response.headers.get("content-length"), "2");
      assert.equal(response.headers.get("content-range"), "bytes 1-2/3");
      assert.equal(response.headers.get("x-trackvault-quality"), "lossless");
      assert.equal(response.headers.get("x-trackvault-max-in-memory-media-bytes"), "4096");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(7, 8));
    }
  });
  assert.deepEqual(observedRanges, [null, "bytes=1-2"]);
});

test("proxy never silently turns a tagged Range request into raw audio", timeout, async () => {
  await withTestRouter([createMediaRouter(createDependencies())], async ({ request }) => {
    const response = await request(`/api/download/proxy?${songQuery}`, { headers: { Range: "bytes=1-2" } });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      code: "METADATA_RANGE_UNSUPPORTED",
      message: "标签下载不支持 Range 续传；如需原样续传，请显式使用服务器裸下载。",
      fallbackModes: ["server-raw"]
    });
  });
});

test("direct tagged preflight reports M4A before native browser handoff", timeout, async () => {
  const dependencies = createDependencies({
    resolveDirectDownload: async () => directDownload({ filename: "track.m4a", type: "m4a", quality: "M4A 128K" }),
    getAudioMetadataTarget: () => null
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const response = await request(`/api/download/direct?metadata=tagged&${songQuery.replace("source=netease", "source=qqmusic")}`);
    assert.equal(response.status, 415);
    assert.equal(response.body.code, "METADATA_FORMAT_UNSUPPORTED");
    assert.deepEqual(response.body.fallbackModes, ["server-raw"]);
  });
});

test("proxy preserves the NetEase song fields and forwards tagged and raw modes to the resolver", timeout, async () => {
  const calls: unknown[][] = [];
  const dependencies = createDependencies({
    resolveDirectDownload: async (...args) => { calls.push(args); return directDownload(); },
    fetchImpl: async () => new Response(bytes(1), { headers: { "content-type": "audio/mpeg", "content-length": "1" } }),
    getAudioMetadataTarget: () => "mp3",
    addAudioMetadataToDownload: async ({ bytes: original }) => original
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    assert.equal((await requestRaw(`/api/download/proxy?${songQuery}`)).status, 200);
    assert.equal((await requestRaw(`/api/download/proxy?metadata=raw&${songQuery}`)).status, 200);
  });
  assert.equal((calls[0][0] as Song).source, "netease");
  assert.equal((calls[0][0] as Song).mediaId, "mid");
  assert.equal((calls[0][0] as Song).providerSongId, "provider-id");
  assert.equal((calls[0][0] as Song).coverUrl, "cover");
  assert.deepEqual(calls.map((args) => args[3]), [{ metadata: "tagged" }, { metadata: "raw" }]);
});

test("proxy tags small MP3 and FLAC responses inside the serial slot", timeout, async () => {
  let slotCalls = 0;
  let resolvedType = "mp3";
  const targets: string[] = [];
  const dependencies = createDependencies({
    getMaxInMemoryMediaBytes: () => 16,
    resolveDirectDownload: async (_song, level) => {
      resolvedType = String(level);
      return directDownload({ filename: `track.${level}`, type: String(level) });
    },
    fetchImpl: async () => {
      const content = resolvedType === "flac" ? bytes(0x66, 0x4c, 0x61, 0x43) : bytes(0xff, 0xfb, 0x90, 0x64);
      return new Response(content, { headers: { "content-type": "application/octet-stream", "content-length": String(content.byteLength) } });
    },
    getAudioMetadataTarget: ({ type, bytes: content }) => content ? getAudioMetadataTarget({ bytes: content }) : type === "flac" ? "flac" : "mp3",
    withMediaTaggingSlot: async (operation) => { slotCalls += 1; return operation(); },
    addAudioMetadataToDownload: async ({ bytes: original, type, onMetadataResult }) => {
      targets.push(type ?? "");
      onMetadataResult?.({ lyricsFetched: true, coverFetched: type === "flac" });
      return bytes(...original, 9);
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    for (const [level, mime] of [["mp3", "audio/mpeg"], ["flac", "audio/flac"]]) {
      const response = await requestRaw(`/api/download/proxy?${songQuery.replace("level=lossless", `level=${level}`)}`);
      assert.equal(response.headers.get("content-type"), mime);
      assert.equal(response.headers.get("content-length"), "5");
      assert.equal(response.headers.get("x-trackvault-lyrics"), "fetched");
      assert.equal(response.headers.get("x-trackvault-cover"), level === "flac" ? "fetched" : "missing");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), level === "flac" ? bytes(0x66, 0x4c, 0x61, 0x43, 9) : bytes(0xff, 0xfb, 0x90, 0x64, 9));
    }
  });
  assert.equal(slotCalls, 2);
  assert.deepEqual(targets, ["mp3", "flac"]);
});

test("tagged M4A returns an explicit unsupported error while raw M4A still streams", timeout, async () => {
  const dependencies = createDependencies({
    resolveDirectDownload: async () => directDownload({ filename: "track.m4a", type: "m4a", quality: "M4A 128K" }),
    fetchImpl: async () => new Response(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70), { headers: { "content-type": "audio/mp4", "content-length": "8" } }),
    getAudioMetadataTarget
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request, requestRaw }) => {
    const tagged = await request(`/api/download/proxy?${songQuery.replace("source=netease", "source=qqmusic")}`);
    assert.equal(tagged.status, 415);
    assert.deepEqual(tagged.body, {
      code: "METADATA_FORMAT_UNSUPPORTED",
      message: "当前仅有 M4A 或其他不可写标签格式；可改用服务器裸下载。",
      format: "m4a",
      fallbackModes: ["server-raw"]
    });
    const raw = await requestRaw(`/api/download/proxy?metadata=raw&${songQuery.replace("source=netease", "source=qqmusic")}`);
    assert.equal(raw.status, 200);
    assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70));
  });
});

test("proxy returns structured 413 before reading a known oversized response", timeout, async () => {
  let readCalls = 0;
  const dependencies = createDependencies({
    getMaxInMemoryMediaBytes: () => 4,
    resolveDirectDownload: async () => directDownload(),
    fetchImpl: async () => new Response(bytes(1), { headers: { "content-type": "audio/mpeg", "content-length": "5" } }),
    getAudioMetadataTarget: () => "mp3",
    readResponseBytesWithLimit: async () => { readCalls += 1; return bytes(); }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const response = await request(`/api/download/proxy?${songQuery}`);
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { code: "MEDIA_MEMORY_LIMIT_EXCEEDED", message: "媒体文件超过 0 MiB 的安全内存处理上限", limitBytes: 4, contentLength: 5, fallbackModes: ["raw-direct", "server-raw"] });
  });
  assert.equal(readCalls, 0);
});

test("proxy returns structured 413 when an unknown-length stream exceeds the limit", timeout, async () => {
  const dependencies = createDependencies({
    getMaxInMemoryMediaBytes: () => 3,
    resolveDirectDownload: async () => directDownload(),
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes(1, 2)); controller.enqueue(bytes(3, 4)); controller.close(); } }), { headers: { "content-type": "audio/mpeg" } }),
    getAudioMetadataTarget: () => "mp3"
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const response = await request(`/api/download/proxy?${songQuery}`);
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { code: "MEDIA_MEMORY_LIMIT_EXCEEDED", message: "媒体文件超过 0 MiB 的安全内存处理上限", limitBytes: 3, fallbackModes: ["raw-direct", "server-raw"] });
  });
});

test("proxy preserves MediaAccessError status and unknown paths reach next middleware", timeout, async () => {
  const dependencies = createDependencies({ resolveDirectDownload: async () => { throw new MediaAccessError(403, "forbidden"); } });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    const denied = await request(`/api/download/proxy?${songQuery}`);
    assert.equal(denied.status, 403);
    assert.deepEqual(denied.body, { message: "forbidden" });
    const fallback = await request("/api/media/unknown");
    assert.equal(fallback.status, 404);
    assert.deepEqual(fallback.body, { message: "test fallback" });
  });
});

test("tagged proxy rejects non-audio bytes and declared-format conflicts with structured 415", timeout, async () => {
  const cases = [
    { filename: "track.mp3", type: "mp3", contentType: "text/html", content: bytes(0x3c, 0x68, 0x74, 0x6d, 0x6c) },
    { filename: "track.mp3", type: "mp3", contentType: "audio/flac", content: bytes(0x66, 0x4c, 0x61, 0x43) },
    { filename: "track.flac", type: "flac", contentType: "audio/flac", content: bytes(0xff, 0xfb, 0x90, 0x64) },
    { filename: "track.m4a", type: "m4a", contentType: "audio/mpeg", content: bytes(0xff, 0xfb, 0x90, 0x64) },
    { filename: "track.mp3", type: "mp3", contentType: "audio/mpeg", content: bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70) }
  ];
  let taggerCalls = 0;
  let current = cases[0];
  const dependencies = createDependencies({
    resolveDirectDownload: async () => directDownload({ filename: current.filename, type: current.type }),
    fetchImpl: async () => new Response(current.content, { headers: { "content-type": current.contentType, "content-length": String(current.content.byteLength) } }),
    getAudioMetadataTarget,
    addAudioMetadataToDownload: async ({ bytes: original }) => { taggerCalls += 1; return original; }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ request }) => {
    for (const item of cases) {
      current = item;
      const response = await request(`/api/download/proxy?${songQuery}`);
      assert.equal(response.status, 415);
      assert.equal((response.body as { code?: string }).code, "METADATA_FORMAT_UNSUPPORTED");
      assert.deepEqual((response.body as { fallbackModes?: string[] }).fallbackModes, ["server-raw"]);
    }
  });
  assert.equal(taggerCalls, 0);
});

test("tagged proxy accepts MP3 magic when filename, resolver type, and Content-Type are unknown", timeout, async () => {
  let taggerCalls = 0;
  const dependencies = createDependencies({
    resolveDirectDownload: async () => directDownload({ filename: "track.bin", type: "unknown" }),
    fetchImpl: async () => new Response(bytes(0xff, 0xfb, 0x90, 0x64), { headers: { "content-type": "application/octet-stream", "content-length": "4" } }),
    getAudioMetadataTarget,
    addAudioMetadataToDownload: async ({ bytes: original }) => { taggerCalls += 1; return original; }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    const response = await requestRaw(`/api/download/proxy?${songQuery}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes(0xff, 0xfb, 0x90, 0x64));
  });
  assert.equal(taggerCalls, 1);
});

test("a tagged metadata disconnect releases the serial slot for the next request", { timeout: 10_000 }, async () => {
  let metadataCalls = 0;
  let firstMetadataStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstMetadataStarted = resolve; });
  const dependencies = createDependencies({
    resolveDirectDownload: async () => directDownload(),
    fetchImpl: async () => new Response(bytes(0xff, 0xfb, 0x90, 0x64), { headers: { "content-type": "audio/mpeg", "content-length": "4" } }),
    getAudioMetadataTarget,
    withMediaTaggingSlot,
    addAudioMetadataToDownload: async ({ bytes: original, signal }) => {
      metadataCalls += 1;
      if (metadataCalls === 1) {
        firstMetadataStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return original;
    }
  });
  await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
    const clientAbort = new AbortController();
    const first = requestRaw(`/api/download/proxy?${songQuery}`, { signal: clientAbort.signal, headers: { Connection: "close" } });
    await firstStarted;
    clientAbort.abort();
    await first.catch(() => undefined);

    const second = await requestRaw(`/api/download/proxy?${songQuery}`, { headers: { Connection: "close" } });
    assert.equal(second.status, 200);
    assert.deepEqual(new Uint8Array(await second.arrayBuffer()), bytes(0xff, 0xfb, 0x90, 0x64));
  });
  assert.equal(metadataCalls, 2);
});

test("QQ resolver, metadata loader, tagger, and proxy run as one composed tagged chain", timeout, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith("https://c.y.qq.com/")
    ? new Response('MusicJsonCallback({"lyric":"WzAwOjAxLjAwXWNvbXBvc2VkIGx5cmlj"})', { headers: { "content-type": "text/plain" } })
    : originalFetch(input, init);
  try {
    const dependencies = createDependencies({
      resolveDirectDownload: (song, level, _cookie, options) => resolveQqDirectDownload(song, level, options, async () => ({
        url: "https://upstream.invalid/qq.mp3",
        qqType: "128" as const,
        extension: "mp3" as const,
        bitrate: 128
      })),
      fetchImpl: async () => new Response(bytes(0xff, 0xfb, 0x90, 0x64), { headers: { "content-type": "audio/mpeg", "content-length": "4" } }),
      getAudioMetadataTarget,
      addAudioMetadataToDownload,
      withMediaTaggingSlot
    });
    await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
      const response = await requestRaw(`/api/download/proxy?${songQuery.replace("source=netease", "source=qqmusic").replace("level=lossless", "level=standard")}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "audio/mpeg");
      assert.equal(response.headers.get("x-trackvault-lyrics"), "fetched");
      const tagged = new Uint8Array(await response.arrayBuffer());
      assert.equal(new TextDecoder().decode(tagged.subarray(0, 3)), "ID3");
      assert.ok(tagged.byteLength > 4);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const route of ["/api/stream?id=1", `/api/download/proxy?metadata=raw&${songQuery}`]) {
  test(`${route.split("?")[0]} aborts its upstream when the client disconnects`, timeout, async () => {
    let resolveAborted!: () => void;
    const aborted = new Promise<void>((resolve) => { resolveAborted = resolve; });
    const dependencies = createDependencies({
      resolveSongStream: async () => ({ url: "https://upstream.invalid/stream" }),
      resolveDirectDownload: async () => directDownload(),
      fetchImpl: async (_input, init) => {
        init?.signal?.addEventListener("abort", resolveAborted, { once: true });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes(1)); } }), { headers: { "content-type": "audio/mpeg" } });
      }
    });
    await withTestRouter([createMediaRouter(dependencies)], async ({ requestRaw }) => {
      const clientAbort = new AbortController();
      const response = await requestRaw(route, { signal: clientAbort.signal });
      const reader = response.body?.getReader();
      await reader?.read();
      clientAbort.abort();
      await aborted;
      await reader?.cancel().catch(() => undefined);
    });
  });
}
