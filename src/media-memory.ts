export const MEDIA_MEMORY_LIMIT_ERROR_CODE = "MEDIA_MEMORY_LIMIT_EXCEEDED" as const;

export type MediaMemoryFallbackMode = "raw-direct" | "server-raw";

export class MediaMemoryLimitExceededError extends Error {
  readonly code = MEDIA_MEMORY_LIMIT_ERROR_CODE;
  readonly limitBytes: number;
  readonly contentLength?: number;
  readonly fallbackModes: MediaMemoryFallbackMode[];

  constructor(input: {
    limitBytes: number;
    contentLength?: number;
    fallbackModes?: MediaMemoryFallbackMode[];
  }) {
    const limitMiB = Math.round(input.limitBytes / 1024 / 1024);
    super(`文件超过浏览器安全标签处理上限（${limitMiB} MiB），未生成部分文件`);
    this.name = "MediaMemoryLimitExceededError";
    this.limitBytes = input.limitBytes;
    this.contentLength = input.contentLength;
    this.fallbackModes = input.fallbackModes ?? ["raw-direct", "server-raw"];
  }
}

export function isMediaMemoryLimitExceededError(error: unknown): error is MediaMemoryLimitExceededError {
  return error instanceof MediaMemoryLimitExceededError || (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === MEDIA_MEMORY_LIMIT_ERROR_CODE
  );
}

export function getBrowserMediaDeliveryKind(mode: "tagged" | "raw" | "server") {
  return mode === "tagged" ? "bounded-buffer" as const : "native-download" as const;
}

function getContentLength(response: Response) {
  const rawValue = response.headers.get("content-length");
  if (!rawValue) {
    return undefined;
  }

  const contentLength = Number(rawValue);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
}

export async function readResponseBytesWithLimit(
  response: Response,
  input: {
    limitBytes: number;
    abortController?: AbortController;
    onProgress?: (progress: number) => void;
  }
) {
  if (!Number.isSafeInteger(input.limitBytes) || input.limitBytes <= 0) {
    throw new Error("服务端没有返回有效的媒体内存上限");
  }

  const contentLength = getContentLength(response);
  if (contentLength !== undefined && contentLength > input.limitBytes) {
    const error = new MediaMemoryLimitExceededError({ limitBytes: input.limitBytes, contentLength });
    input.abortController?.abort(error);
    await response.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  if (!response.body) {
    throw new Error("浏览器无法安全读取媒体流");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value?.byteLength) {
        continue;
      }

      const nextReceivedBytes = receivedBytes + value.byteLength;
      if (nextReceivedBytes > input.limitBytes) {
        const error = new MediaMemoryLimitExceededError({ limitBytes: input.limitBytes, contentLength });
        input.abortController?.abort(error);
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }

      chunks.push(value);
      receivedBytes = nextReceivedBytes;
      if (contentLength && contentLength > 0) {
        input.onProgress?.(Math.max(1, Math.min(99, Math.round((receivedBytes / contentLength) * 100))));
      }
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
