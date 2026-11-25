import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { AppError } from "../../domain/errors.js";

export async function waitForWriteDrain(
  writeStream: fs.WriteStream,
  signal: AbortSignal,
  getWriteError: () => Error | null,
): Promise<void> {
  const existingErr = getWriteError();
  if (existingErr) throw existingErr;
  if (signal.aborted) {
    throw new AppError("INTERNAL_ERROR", "下载已取消。");
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writeStream.off("drain", onDrain);
      writeStream.off("error", onError);
      writeStream.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new AppError("INTERNAL_ERROR", "下载已取消。"));
    };

    writeStream.once("drain", onDrain);
    writeStream.once("error", onError);
    writeStream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function finishWriteStream(
  writeStream: fs.WriteStream,
  getWriteError: () => Error | null,
): Promise<void> {
  const existingErr = getWriteError();
  if (existingErr) throw existingErr;
  if (writeStream.writableFinished) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writeStream.off("finish", onFinish);
      writeStream.off("error", onError);
      writeStream.off("close", onClose);
    };
    const onFinish = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };

    writeStream.once("finish", onFinish);
    writeStream.once("error", onError);
    writeStream.once("close", onClose);
    writeStream.end();
  });
}

export interface BoundedFileWriteOptions {
  body: ReadableStream<Uint8Array>;
  filePath: string;
  maxBytes: number;
  signal: AbortSignal;
  onChunkWritten?: (receivedBytes: number) => void;
}

/**
 * Streams a Web ReadableStream to disk with strict byte-limit enforcement,
 * backpressure drain synchronization, paired listener cleanup, and partial-file rollback.
 */
export async function writeStreamToFileWithLimit(options: BoundedFileWriteOptions): Promise<number> {
  const { body, filePath, maxBytes, signal, onChunkWritten } = options;
  const writeStream = fs.createWriteStream(filePath);
  // BUG-25: Attach permanent error listener immediately so async FS errors never crash Node
  let writeError: Error | null = null;
  writeStream.on("error", (err) => {
    writeError = err instanceof Error ? err : new Error(String(err));
  });

  const reader = body.getReader();
  let received = 0;

  try {
    while (true) {
      if (writeError) {
        await reader.cancel().catch(() => undefined);
        throw writeError;
      }
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new AppError("INTERNAL_ERROR", "下载已取消。");
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppError("PAYLOAD_TOO_LARGE", "音频流实际大小超过服务端上限。");
      }

      if (writeError) {
        await reader.cancel().catch(() => undefined);
        throw writeError;
      }

      // J07 + C018: Clean paired drain/error/abort listener handling with zero accumulation
      if (!writeStream.write(value)) {
        await waitForWriteDrain(writeStream, signal, () => writeError);
      }

      onChunkWritten?.(received);
    }

    await finishWriteStream(writeStream, () => writeError);
    return received;
  } catch (error) {
    writeStream.destroy();
    await fsPromises.unlink(filePath).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
