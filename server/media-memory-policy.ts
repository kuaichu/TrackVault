export const MEDIA_MEMORY_LIMIT_ERROR_CODE = "MEDIA_MEMORY_LIMIT_EXCEEDED" as const;
export const DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES = 96 * 1024 * 1024;
export const MIN_MAX_IN_MEMORY_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_MAX_IN_MEMORY_MEDIA_BYTES = 512 * 1024 * 1024;

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
    super(`媒体文件超过 ${limitMiB} MiB 的安全内存处理上限`);
    this.name = "MediaMemoryLimitExceededError";
    this.limitBytes = input.limitBytes;
    this.contentLength = input.contentLength;
    this.fallbackModes = input.fallbackModes ?? ["raw-direct", "server-raw"];
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      limitBytes: this.limitBytes,
      contentLength: this.contentLength,
      fallbackModes: this.fallbackModes
    };
  }
}

export function parseMaxInMemoryMediaBytes(rawValue: string | undefined) {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES;
  }

  const requestedMiB = Number(rawValue);
  if (!Number.isFinite(requestedMiB) || requestedMiB <= 0) {
    return DEFAULT_MAX_IN_MEMORY_MEDIA_BYTES;
  }

  const requestedBytes = Math.round(requestedMiB * 1024 * 1024);
  return Math.min(MAX_MAX_IN_MEMORY_MEDIA_BYTES, Math.max(MIN_MAX_IN_MEMORY_MEDIA_BYTES, requestedBytes));
}

export function getMaxInMemoryMediaBytes() {
  return parseMaxInMemoryMediaBytes(process.env.TRACKVAULT_MAX_IN_MEMORY_MEDIA_MB);
}

export function getResponseContentLength(response: Response): number | undefined {
  const rawValue = response.headers.get("content-length");
  if (!rawValue) {
    return undefined;
  }

  const contentLength = Number(rawValue);
  return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : undefined;
}

export type ServerMediaHandlingDecision =
  | { kind: "stream" }
  | { kind: "buffer-and-tag" }
  | { kind: "reject"; error: MediaMemoryLimitExceededError };

export function decideServerMediaHandling(input: {
  metadataRequested: boolean;
  metadataTarget: "mp3" | "flac" | null;
  contentLength?: number;
  limitBytes: number;
}): ServerMediaHandlingDecision {
  if (!input.metadataRequested) {
    return { kind: "stream" };
  }

  if (input.contentLength !== undefined && input.contentLength > input.limitBytes) {
    return {
      kind: "reject",
      error: new MediaMemoryLimitExceededError({
        limitBytes: input.limitBytes,
        contentLength: input.contentLength
      })
    };
  }

  return { kind: "buffer-and-tag" };
}

async function cancelExceededResponse(
  body: ReadableStream<Uint8Array> | null,
  error: MediaMemoryLimitExceededError,
  abortController?: AbortController
) {
  abortController?.abort(error);
  if (body) {
    await body.cancel(error).catch(() => undefined);
  }
}

export async function readResponseBytesWithLimit(
  response: Response,
  input: { limitBytes: number; abortController?: AbortController }
) {
  if (!Number.isSafeInteger(input.limitBytes) || input.limitBytes <= 0) {
    throw new Error("媒体内存上限必须是正整数");
  }

  const contentLength = getResponseContentLength(response);
  if (contentLength !== undefined && contentLength > input.limitBytes) {
    const error = new MediaMemoryLimitExceededError({ limitBytes: input.limitBytes, contentLength });
    await cancelExceededResponse(response.body, error, input.abortController);
    throw error;
  }

  if (!response.body) {
    throw new Error("上游媒体响应没有可读取的正文流");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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

let taggingTail = Promise.resolve();

export async function withMediaTaggingSlot<T>(operation: () => Promise<T>): Promise<T> {
  const previous = taggingTail;
  let release: () => void = () => {};
  taggingTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
