import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadMediaResponseToFile } from "./media-download-file.js";

async function withTempDirectory(run: (directory: string) => Promise<void>) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "trackvault-media-"));
  try {
    await run(directory);
  } finally {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
}

function responseFromChunks(chunks: number[][], contentLength?: number) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(Uint8Array.from(chunk));
    }
  }), { headers: contentLength === undefined ? undefined : { "content-length": String(contentLength) } });
}

test("background file download writes metadata for a small file and cleans task temp files", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "song.mp3");
    const result = await downloadMediaResponseToFile({
      response: responseFromChunks([[1, 2], [3]], 3),
      outputPath,
      tempId: "task-small",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      writeMetadata: async (bytes) => Uint8Array.from([9, ...bytes])
    });
    assert.equal(result.metadataStatus, "written");
    assert.equal(result.fileSizeBytes, 4);
    assert.deepEqual([...await fsPromises.readFile(outputPath)], [9, 1, 2, 3]);
    assert.deepEqual(await fsPromises.readdir(directory), ["song.mp3"]);
  });
});

test("background file download allows metadata at exactly the memory limit", async () => {
  await withTempDirectory(async (directory) => {
    let metadataCalls = 0;
    const result = await downloadMediaResponseToFile({
      response: responseFromChunks([[1, 2], [3, 4]]),
      outputPath: path.join(directory, "exact.flac"),
      tempId: "task-exact",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      writeMetadata: async (bytes) => {
        metadataCalls += 1;
        return bytes;
      }
    });
    assert.equal(metadataCalls, 1);
    assert.equal(result.metadataStatus, "written");
  });
});

test("background file download uses actual bytes to skip oversized metadata and preserves raw audio", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "large.flac");
    let metadataCalls = 0;
    const result = await downloadMediaResponseToFile({
      response: responseFromChunks([[1, 2], [3, 4], [5]], 2),
      outputPath,
      tempId: "task-large",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      writeMetadata: async (bytes) => {
        metadataCalls += 1;
        return bytes;
      }
    });
    assert.equal(metadataCalls, 0);
    assert.equal(result.metadataStatus, "skipped-size-limit");
    assert.equal(result.fileSizeBytes, 5);
    assert.match(result.warning ?? "", /未写入标签/);
    assert.deepEqual([...await fsPromises.readFile(outputPath)], [1, 2, 3, 4, 5]);
    assert.deepEqual(await fsPromises.readdir(directory), ["large.flac"]);
  });
});

test("background file download preserves raw audio and reports a metadata failure", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "fallback.mp3");
    const result = await downloadMediaResponseToFile({
      response: responseFromChunks([[1, 2, 3]]),
      outputPath,
      tempId: "task-fallback",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      writeMetadata: async () => { throw new Error("synthetic tag failure"); }
    });
    assert.equal(result.metadataStatus, "failed");
    assert.match(result.warning ?? "", /synthetic tag failure/);
    assert.deepEqual([...await fsPromises.readFile(outputPath)], [1, 2, 3]);
  });
});

test("background raw download publishes without invoking metadata", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "raw.bin");
    const result = await downloadMediaResponseToFile({
      response: responseFromChunks([[4, 5, 6]]),
      outputPath,
      tempId: "task-raw",
      maxInMemoryMediaBytes: 2,
      metadataRequested: false
    });
    assert.equal(result.metadataStatus, "not-requested");
    assert.deepEqual([...await fsPromises.readFile(outputPath)], [4, 5, 6]);
  });
});

test("background stream failure aborts upstream and leaves no final or partial file", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "broken.mp3");
    const abortController = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.error(new Error("synthetic stream failure"));
      }
    }));
    await assert.rejects(downloadMediaResponseToFile({
      response,
      outputPath,
      tempId: "task-broken",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      abortController,
      writeMetadata: async (bytes) => bytes
    }), /synthetic stream failure/);
    assert.equal(abortController.signal.aborted, true);
    assert.deepEqual(await fsPromises.readdir(directory), []);
  });
});

test("background cancellation stops the source and removes the task partial file", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "cancelled.flac");
    const abortController = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        abortController.signal.addEventListener("abort", () => {
          controller.error(abortController.signal.reason);
        }, { once: true });
      }
    }));
    const download = downloadMediaResponseToFile({
      response,
      outputPath,
      tempId: "task-cancelled",
      maxInMemoryMediaBytes: 4,
      metadataRequested: true,
      abortController,
      writeMetadata: async (bytes) => bytes
    });
    abortController.abort(new Error("synthetic cancellation"));
    await assert.rejects(download, /synthetic cancellation/);
    assert.deepEqual(await fsPromises.readdir(directory), []);
  });
});

test("background download never removes a colliding temp file it did not create", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "song.mp3");
    const collidingTempPath = path.join(directory, ".song.mp3.task-collision.raw.part");
    await fsPromises.writeFile(collidingTempPath, Uint8Array.of(9, 9));
    await assert.rejects(downloadMediaResponseToFile({
      response: responseFromChunks([[1, 2, 3]]),
      outputPath,
      tempId: "task-collision",
      maxInMemoryMediaBytes: 4,
      metadataRequested: false
    }), (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    assert.deepEqual([...await fsPromises.readFile(collidingTempPath)], [9, 9]);
    await assert.rejects(fsPromises.stat(outputPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  });
});
