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
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

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
      signal,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ApiClientError("UPSTREAM_TIMEOUT", "请求超时或已取消。", 504);
    }
    throw new ApiClientError("UPSTREAM_ERROR", "网络连接失败，请检查服务是否在线。", 0);
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

    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      unauthorizedHandler?.();
    }
    throw new ApiClientError(code, message, response.status);
  }

  return json as T;
}
