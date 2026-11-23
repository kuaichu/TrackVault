import { ApiErrorBodySchema, type ErrorCode } from "#shared";

export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export async function apiRequest<T>(
  url: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const controller = new AbortController();
  let timedOut = false;

  const callerSignal = options.signal;
  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason);
  };

  if (callerSignal) {
    if (callerSignal.aborted) {
      throw createAbortError(callerSignal.reason);
    }
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const headers: Record<string, string> = {};
  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    serializedBody = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      credentials: "include",
      headers,
      body: serializedBody,
      signal: controller.signal,
    });
  } catch (error) {
    if (callerSignal?.aborted && !timedOut) {
      throw createAbortError(callerSignal.reason ?? error);
    }
    if (
      timedOut ||
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw new ApiClientError("UPSTREAM_TIMEOUT", "请求超时，请稍后重试。", 504);
    }
    throw new ApiClientError("UPSTREAM_ERROR", "网络连接失败，请检查服务是否在线。", 0);
  } finally {
    globalThis.clearTimeout(timeoutId);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const parsedErr = ApiErrorBodySchema.safeParse(json);
    const code: ErrorCode = parsedErr.success
      ? parsedErr.data.error.code
      : response.status === 401
        ? "UNAUTHORIZED"
        : response.status === 403
          ? "FORBIDDEN"
          : "INTERNAL_ERROR";
    const message = parsedErr.success ? parsedErr.data.error.message : `请求失败 (HTTP ${response.status})`;

    // Only local TrackVault session expiration (UNAUTHORIZED) should clear login state —
    // never log the user out on third-party platform cookie errors (401 CREDENTIAL_INVALID).
    if (code === "UNAUTHORIZED" && !url.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    throw new ApiClientError(code, message, response.status);
  }

  return json as T;
}
