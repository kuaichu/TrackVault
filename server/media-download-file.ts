import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withMediaTaggingSlot } from "./media-memory-policy.js";
import type { DownloadMetadataStatus } from "./types.js";

export type DownloadedMediaFileResult = {
  fileSizeBytes: number;
  metadataStatus: DownloadMetadataStatus;
  warning?: string;
  memoryLimitBytes: number;
};

function buildTaskTempPath(outputPath: string, tempId: string, kind: "raw" | "tagged") {
  const safeTempId = tempId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${safeTempId}.${kind}.part`);
}

async function removeTaskTempFile(filePath: string) {
  try {
    await fsPromises.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function downloadMediaResponseToFile(input: {
  response: Response;
  outputPath: string;
  tempId: string;
  maxInMemoryMediaBytes: number;
  metadataRequested: boolean;
  writeMetadata?: (bytes: Uint8Array) => Promise<Uint8Array>;
  abortController?: AbortController;
  onProgress?: (receivedBytes: number, contentLength?: number) => void;
}): Promise<DownloadedMediaFileResult> {
  if (!input.response.body) {
    throw new Error("上游媒体响应没有可下载的正文流");
  }

  const rawTempPath = buildTaskTempPath(input.outputPath, input.tempId, "raw");
  const taggedTempPath = buildTaskTempPath(input.outputPath, input.tempId, "tagged");
  const declaredLengthValue = Number(input.response.headers.get("content-length") ?? "");
  const contentLength = Number.isSafeInteger(declaredLengthValue) && declaredLengthValue >= 0
    ? declaredLengthValue
    : undefined;
  let receivedBytes = 0;
  let rawTempCreated = false;
  let taggedTempCreated = false;

  try {
    try {
      const rawFileHandle = await fsPromises.open(rawTempPath, "wx");
      rawTempCreated = true;
      await rawFileHandle.close();
      const rawWriteStream = fs.createWriteStream(rawTempPath, { flags: "w" });
      const source = Readable.fromWeb(input.response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          receivedBytes += chunk.byteLength;
          input.onProgress?.(receivedBytes, contentLength);
          callback(null, chunk);
        }
      });
      await pipeline(source, progress, rawWriteStream);
    } catch (error) {
      input.abortController?.abort(error);
      throw error;
    }

    if (!input.metadataRequested || !input.writeMetadata) {
      await fsPromises.rename(rawTempPath, input.outputPath);
      rawTempCreated = false;
      return {
        fileSizeBytes: receivedBytes,
        metadataStatus: "not-requested",
        memoryLimitBytes: input.maxInMemoryMediaBytes
      };
    }

    if (receivedBytes > input.maxInMemoryMediaBytes) {
      await fsPromises.rename(rawTempPath, input.outputPath);
      rawTempCreated = false;
      return {
        fileSizeBytes: receivedBytes,
        metadataStatus: "skipped-size-limit",
        warning: `文件已完整下载；因超过 ${Math.round(input.maxInMemoryMediaBytes / 1024 / 1024)} MiB 安全内存上限，未写入标签。`,
        memoryLimitBytes: input.maxInMemoryMediaBytes
      };
    }

    try {
      const taggedFileSizeBytes = await withMediaTaggingSlot(async () => {
        const originalBytes = await fsPromises.readFile(rawTempPath);
        if (originalBytes.byteLength > input.maxInMemoryMediaBytes) {
          throw new Error("媒体文件在标签处理前超过安全内存上限");
        }
        const taggedBytes = await (input.writeMetadata?.(originalBytes) ?? originalBytes);
        const taggedFileHandle = await fsPromises.open(taggedTempPath, "wx");
        taggedTempCreated = true;
        await taggedFileHandle.close();
        const taggedWriteStream = fs.createWriteStream(taggedTempPath, { flags: "w" });
        await pipeline(Readable.from([taggedBytes]), taggedWriteStream);
        return taggedBytes.byteLength;
      });
      await fsPromises.rename(taggedTempPath, input.outputPath);
      taggedTempCreated = false;
      await removeTaskTempFile(rawTempPath);
      rawTempCreated = false;
      return {
        fileSizeBytes: taggedFileSizeBytes,
        metadataStatus: "written",
        memoryLimitBytes: input.maxInMemoryMediaBytes
      };
    } catch (error) {
      if (taggedTempCreated) {
        await removeTaskTempFile(taggedTempPath);
        taggedTempCreated = false;
      }
      await fsPromises.rename(rawTempPath, input.outputPath);
      rawTempCreated = false;
      return {
        fileSizeBytes: receivedBytes,
        metadataStatus: "failed",
        warning: `文件已完整下载，但标签写入失败，已保留原始音频：${error instanceof Error ? error.message : "未知错误"}`,
        memoryLimitBytes: input.maxInMemoryMediaBytes
      };
    }
  } finally {
    if (rawTempCreated) {
      await removeTaskTempFile(rawTempPath);
    }
    if (taggedTempCreated) {
      await removeTaskTempFile(taggedTempPath);
    }
  }
}
