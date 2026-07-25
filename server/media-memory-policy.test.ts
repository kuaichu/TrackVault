import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES,
  decideServerMediaHandling,
  MAX_MAX_IN_MEMORY_MEDIA_BYTES,
  MediaMemoryLimitExceededError,
  MIN_MAX_IN_MEMORY_MEDIA_BYTES,
  parseMaxInMemoryMediaBytes,
  readResponseBytesWithLimit,
  withMediaTaggingSlot
} from "./media-memory-policy.js";

const MIB = 1024 * 1024;

function responseFromChunks(chunks: number[][], contentLength?: number, onCancel?: (reason: unknown) => void) {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunk));
    },
    cancel(reason) {
      onCancel?.(reason);
    }
  });
  return new Response(body, {
    headers: contentLength === undefined ? undefined : { "content-length": String(contentLength) }
  });
}

test("media memory policy uses the conservative default", () => {
  assert.equal(parseMaxInMemoryMediaBytes(undefined), DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES);
  assert.equal(parseMaxInMemoryMediaBytes(""), DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES);
});

test("media memory policy accepts a finite positive MiB value", () => {
  assert.equal(parseMaxInMemoryMediaBytes("64"), 64 * MIB);
  assert.equal(parseMaxInMemoryMediaBytes("64.5"), Math.round(64.5 * MIB));
});

test("media memory policy falls back for non-numeric, negative, and zero values", () => {
  assert.equal(parseMaxInMemoryMediaBytes("nope"), DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES);
  assert.equal(parseMaxInMemoryMediaBytes("-1"), DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES);
  assert.equal(parseMaxInMemoryMediaBytes("0"), DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES);
});

test("media memory policy clamps positive values to its lower bound", () => {
  assert.equal(parseMaxInMemoryMediaBytes("1"), MIN_MAX_IN_MEMORY_MEDIA_BYTES);
});

test("media memory policy clamps huge values to its upper bound", () => {
  assert.equal(parseMaxInMemoryMediaBytes("99999"), MAX_MAX_IN_MEMORY_MEDIA_BYTES);
});

test("server bounded reader returns bytes below the limit", async () => {
  const bytes = await readResponseBytesWithLimit(responseFromChunks([[1, 2], [3]]), { limitBytes: 4 });
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("server bounded reader allows a response exactly equal to the limit", async () => {
  const bytes = await readResponseBytesWithLimit(responseFromChunks([[1, 2], [3, 4]], 4), { limitBytes: 4 });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test("server bounded reader rejects a known oversized response before reading", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled = true;
    }
  }), { headers: { "content-length": "5" } });
  const abortController = new AbortController();

  await assert.rejects(
    readResponseBytesWithLimit(response, { limitBytes: 4, abortController }),
    (error: unknown) => error instanceof MediaMemoryLimitExceededError && error.contentLength === 5
  );
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  assert.equal(abortController.signal.aborted, true);
});

test("server bounded reader cancels an unknown-length stream at actual overflow", async () => {
  let cancelled = false;
  const abortController = new AbortController();
  await assert.rejects(
    readResponseBytesWithLimit(responseFromChunks([[1, 2], [3, 4], [5]], undefined, () => { cancelled = true; }), {
      limitBytes: 4,
      abortController
    }),
    MediaMemoryLimitExceededError
  );
  assert.equal(cancelled, true);
  assert.equal(abortController.signal.aborted, true);
});

test("server bounded reader rejects when actual bytes exceed an understated Content-Length", async () => {
  await assert.rejects(
    readResponseBytesWithLimit(responseFromChunks([[1, 2], [3, 4], [5]], 2), { limitBytes: 4 }),
    MediaMemoryLimitExceededError
  );
});

test("server metadata policy permits bounded MP3 and FLAC tagging", () => {
  assert.deepEqual(decideServerMediaHandling({ metadataRequested: true, metadataTarget: "mp3", contentLength: 4, limitBytes: 4 }), { kind: "buffer-and-tag" });
  assert.deepEqual(decideServerMediaHandling({ metadataRequested: true, metadataTarget: "flac", contentLength: 3, limitBytes: 4 }), { kind: "buffer-and-tag" });
});

test("server metadata policy returns a structured oversized rejection with fallbacks", () => {
  const decision = decideServerMediaHandling({ metadataRequested: true, metadataTarget: "mp3", contentLength: 5, limitBytes: 4 });
  assert.equal(decision.kind, "reject");
  if (decision.kind !== "reject") return;
  assert.deepEqual(decision.error.toJSON(), {
    code: "MEDIA_MEMORY_LIMIT_EXCEEDED",
    message: decision.error.message,
    limitBytes: 4,
    contentLength: 5,
    fallbackModes: ["raw-direct", "server-raw"]
  });
});

test("server metadata policy chooses streaming for a raw proxy", () => {
  assert.deepEqual(decideServerMediaHandling({ metadataRequested: false, metadataTarget: "flac", contentLength: 999, limitBytes: 4 }), { kind: "stream" });
  assert.deepEqual(decideServerMediaHandling({ metadataRequested: true, metadataTarget: null, contentLength: 999, limitBytes: 4 }), { kind: "stream" });
});

test("server media tagging slot serializes full-memory operations", async () => {
  const events: string[] = [];
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withMediaTaggingSlot(async () => {
    events.push("first-enter");
    await firstGate;
    events.push("first-leave");
  });
  const second = withMediaTaggingSlot(async () => {
    events.push("second-enter");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-enter"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-enter", "first-leave", "second-enter"]);
});
