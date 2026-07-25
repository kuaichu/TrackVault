import assert from "node:assert/strict";
import test from "node:test";
import {
  getBrowserMediaDeliveryKind,
  MediaMemoryLimitExceededError,
  readResponseBytesWithLimit
} from "./media-memory";

function responseFromChunks(chunks: number[][], contentLength?: number, onCancel?: () => void) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunk));
    },
    cancel() {
      onCancel?.();
    }
  }), { headers: contentLength === undefined ? undefined : { "content-length": String(contentLength) } });
}

test("browser delivery policy buffers only tagged mode", () => {
  assert.equal(getBrowserMediaDeliveryKind("tagged"), "bounded-buffer");
  assert.equal(getBrowserMediaDeliveryKind("raw"), "native-download");
  assert.equal(getBrowserMediaDeliveryKind("server"), "native-download");
});

test("browser bounded reader returns small media", async () => {
  const bytes = await readResponseBytesWithLimit(responseFromChunks([[1], [2, 3]]), { limitBytes: 4 });
  assert.deepEqual([...bytes], [1, 2, 3]);
});

test("browser bounded reader permits exactly the configured limit", async () => {
  const bytes = await readResponseBytesWithLimit(responseFromChunks([[1, 2], [3, 4]], 4), { limitBytes: 4 });
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
});

test("browser bounded reader rejects known oversize before reading and aborts", async () => {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled = true;
    }
  }), { headers: { "content-length": "5" } });
  const abortController = new AbortController();
  await assert.rejects(readResponseBytesWithLimit(response, { limitBytes: 4, abortController }), MediaMemoryLimitExceededError);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  assert.equal(abortController.signal.aborted, true);
});

test("browser bounded reader cancels unknown-length media on actual overflow", async () => {
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

test("browser bounded reader distrusts an understated Content-Length", async () => {
  await assert.rejects(
    readResponseBytesWithLimit(responseFromChunks([[1, 2], [3, 4], [5]], 2), { limitBytes: 4 }),
    MediaMemoryLimitExceededError
  );
});
