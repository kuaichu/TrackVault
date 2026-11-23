import dns from "node:dns/promises";
import net from "node:net";
import { parseSafeHttpUrl } from "#shared";
import { AppError } from "../../domain/errors.js";

export interface SafeFetchOptions {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  allowedHostSuffixes: readonly string[];
  allowHttp?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** If true, drops Cookie/Authorization headers when redirecting to a different host. */
  stripSensitiveHeadersOnHostChange?: boolean;
}

export interface SafeBufferResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  status: number;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, 127/8
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a >= 224) return true; // Multicast / reserved
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    if (normalized.startsWith("::ffff:")) {
      return isPrivateOrReservedIp(normalized.slice("::ffff:".length));
    }
    return false;
  }

  return true;
}

export function matchesHostSuffixes(hostname: string, suffixes: readonly string[]): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => {
    const clean = suffix.trim().toLowerCase().replace(/^\./, "");
    return normalized === clean || normalized.endsWith(`.${clean}`);
  });
}

export type HostResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export class SafeHttpClient {
  readonly #defaultTimeoutMs: number;
  readonly #fetchImpl: typeof fetch;
  readonly #resolveHost: HostResolver;

  constructor(options?: {
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    resolveHost?: HostResolver;
  }) {
    this.#defaultTimeoutMs = options?.defaultTimeoutMs ?? 15_000;
    this.#fetchImpl = options?.fetchImpl ?? fetch;
    this.#resolveHost =
      options?.resolveHost ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
  }

  async #assertSafeTarget(rawUrl: string, options: SafeFetchOptions): Promise<URL> {
    const parsed = parseSafeHttpUrl(rawUrl);
    if (!parsed) {
      throw new AppError("UNSAFE_URL", "非法的外部请求地址。");
    }
    if (!options.allowHttp && parsed.protocol !== "https:") {
      throw new AppError("UNSAFE_URL", "仅允许 HTTPS 外部地址。");
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new AppError("UNSAFE_URL", "禁止访问本机或局域网地址。");
    }
    if (net.isIP(hostname)) {
      throw new AppError("UNSAFE_URL", "禁止直接访问 IP 地址。");
    }
    if (!matchesHostSuffixes(hostname, options.allowedHostSuffixes)) {
      throw new AppError("UNSAFE_URL", `目标域名不在允许白名单内：${hostname}`);
    }

    // Resolve DNS and block any private/loopback/metadata IP targets (mitigates DNS rebinding / SSRF)
    const records = await this.#resolveHost(hostname).catch(() => null);
    if (!records || records.length === 0) {
      throw new AppError("UPSTREAM_ERROR", `无法解析目标域名：${hostname}`);
    }
    for (const record of records) {
      if (isPrivateOrReservedIp(record.address)) {
        throw new AppError("UNSAFE_URL", "目标域名解析到受限内网地址，已拦截。");
      }
    }

    return parsed;
  }

  async fetchResponse(
    rawUrl: string,
    options: SafeFetchOptions,
  ): Promise<{ response: Response; finalUrl: string }> {
    const maxRedirects = options.maxRedirects ?? 4;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let currentUrl = rawUrl;
    const headers = new Headers(options.headers ?? {});
    let previousHost: string | null = null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const safeUrl = await this.#assertSafeTarget(currentUrl, options);

      if (
        options.stripSensitiveHeadersOnHostChange !== false &&
        previousHost &&
        previousHost !== safeUrl.hostname.toLowerCase()
      ) {
        headers.delete("cookie");
        headers.delete("authorization");
      }
      previousHost = safeUrl.hostname.toLowerCase();

      let response: Response;
      try {
        response = await this.#fetchImpl(safeUrl.toString(), {
          method: hop === 0 ? (options.method ?? "GET") : "GET",
          headers,
          body: hop === 0 ? options.body : undefined,
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new AppError("UPSTREAM_TIMEOUT", "上游请求超时或已取消。", { cause: error });
        }
        throw new AppError("UPSTREAM_ERROR", "上游网络请求失败。", { cause: error });
      }

      const isRedirect = response.status >= 300 && response.status < 400;
      const location = response.headers.get("location");
      if (isRedirect && location) {
        if (hop >= maxRedirects) {
          throw new AppError("UPSTREAM_ERROR", "外部地址重定向次数过多。");
        }
        // Cancel redirect response body so sockets are released immediately
        await response.body?.cancel().catch(() => undefined);
        currentUrl = new URL(location, safeUrl).toString();
        continue;
      }

      return { response, finalUrl: safeUrl.toString() };
    }

    throw new AppError("UPSTREAM_ERROR", "外部请求超过最大跳转次数。");
  }

  /**
   * Streams response bytes incrementally and aborts immediately when maxBytes is exceeded,
   * preventing chunked/forged-header OOM attacks.
   */
  async fetchBoundedBytes(
    rawUrl: string,
    options: SafeFetchOptions & { maxBytes: number; requireContentTypePrefix?: string },
  ): Promise<SafeBufferResult> {
    const { response, finalUrl } = await this.fetchResponse(rawUrl, options);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("UPSTREAM_ERROR", `上游响应状态异常：${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (
      options.requireContentTypePrefix &&
      !contentType.toLowerCase().startsWith(options.requireContentTypePrefix.toLowerCase())
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("VALIDATION_ERROR", `上游返回了非预期的内容类型：${contentType}`);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("PAYLOAD_TOO_LARGE", "上游资源体积超过安全上限。");
    }

    if (!response.body) {
      return { bytes: new Uint8Array(), contentType, finalUrl, status: response.status };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new AppError("PAYLOAD_TOO_LARGE", "上游资源实际流大小超过安全上限。");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes: output, contentType, finalUrl, status: response.status };
  }
}
