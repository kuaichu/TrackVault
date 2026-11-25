import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { parseSafeHttpUrl } from "#shared";
import { AppError } from "../../domain/errors.js";
import { isPrivateOrReservedIp, stripIpBrackets } from "./ip-guard.js";

export { isPrivateOrReservedIp };

export interface SafeFetchOptions {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  allowedHostSuffixes: readonly string[];
  allowHttp?: boolean;
  maxRedirects?: number;
  /** "follow" (default) follows validated redirects up to maxRedirects; "manual" returns the 3xx response directly. */
  redirectMode?: "follow" | "manual";
  /** Timeout for DNS + connect + receiving response headers (ms). */
  timeoutMs?: number;
  /** Max idle gap between response body chunks (ms). Active streams reset this timer on every chunk. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  /** If true, drops Cookie/Authorization headers when redirecting to a different host. */
  stripSensitiveHeadersOnHostChange?: boolean;
}

export interface SafeBufferResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  status: number;
  headers: Headers;
}

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export function matchesHostSuffixes(hostname: string, suffixes: readonly string[]): boolean {
  const normalized = stripIpBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => {
    const clean = suffix.trim().toLowerCase().replace(/^\./, "");
    return normalized === clean || normalized.endsWith(`.${clean}`);
  });
}

function createTimeoutError(message: string): Error {
  const err = new Error(message);
  err.name = "TimeoutError";
  return err;
}

function wrapBodyWithIdleTimeout(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  onIdleTimeout: (err: Error) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: NodeJS.Timeout | null = null;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timeoutError: Error | null = null;
      const readPromise = reader.read();
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = createTimeoutError("上游音频或数据流读取空闲超时。");
          timeoutError = err;
          onIdleTimeout(err);
          reject(err);
          void reader.cancel(err).catch(() => undefined);
        }, idleTimeoutMs);
        timer.unref?.();
      });

      try {
        const result = await Promise.race([readPromise, timeoutPromise]);
        clearTimer();
        if (timeoutError) {
          throw timeoutError;
        }
        if (result.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        if (result.value) {
          controller.enqueue(result.value);
        }
      } catch (err) {
        clearTimer();
        if (!timeoutError) {
          reader.releaseLock();
        }
        controller.error(timeoutError ?? err);
      }
    },
    async cancel(reason) {
      clearTimer();
      await reader.cancel(reason).catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    },
  });
}

export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;

export class SafeHttpClient {
  readonly #defaultTimeoutMs: number;
  readonly #customFetchImpl?: typeof fetch;
  readonly #resolveHost: HostResolver;
  readonly #httpAgent: http.Agent;
  readonly #httpsAgent: https.Agent;

  constructor(options?: {
    defaultTimeoutMs?: number;
    fetchImpl?: typeof fetch;
    resolveHost?: HostResolver;
  }) {
    this.#defaultTimeoutMs = options?.defaultTimeoutMs ?? 15_000;
    this.#customFetchImpl = options?.fetchImpl;
    this.#resolveHost =
      options?.resolveHost ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
    this.#httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    this.#httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });
  }

  /**
   * Destroys pooled keep-alive sockets so server shutdown exits promptly without hanging.
   */
  close(): void {
    this.#httpAgent.destroy();
    this.#httpsAgent.destroy();
  }

  async #assertSafeTarget(
    rawUrl: string,
    options: SafeFetchOptions,
  ): Promise<{ safeUrl: URL; pinnedAddresses: PinnedAddress[] }> {
    const parsed = parseSafeHttpUrl(rawUrl);
    if (!parsed) {
      throw new AppError("UNSAFE_URL", "非法的外部请求地址。");
    }
    if (!options.allowHttp && parsed.protocol !== "https:") {
      throw new AppError("UNSAFE_URL", "仅允许 HTTPS 外部地址。");
    }

    const hostname = stripIpBrackets(parsed.hostname).toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
      throw new AppError("UNSAFE_URL", "禁止访问本机或局域网地址。");
    }
    if (net.isIP(hostname)) {
      throw new AppError("UNSAFE_URL", "禁止直接访问 IP 地址。");
    }
    if (!matchesHostSuffixes(hostname, options.allowedHostSuffixes)) {
      throw new AppError("UNSAFE_URL", `目标域名不在允许白名单内：${hostname}`);
    }

    // Resolve DNS once, reject any private/reserved IP, and pin validated records for connection establishment.
    const records = await this.#resolveHost(hostname).catch(() => null);
    if (!records || records.length === 0) {
      throw new AppError("UPSTREAM_ERROR", `无法解析目标域名：${hostname}`);
    }

    const pinnedAddresses: PinnedAddress[] = [];
    for (const record of records) {
      const addr = stripIpBrackets(record.address);
      if (isPrivateOrReservedIp(addr)) {
        throw new AppError("UNSAFE_URL", "目标域名解析到受限内网地址，已拦截。");
      }
      const family: 4 | 6 = record.family === 6 || net.isIPv6(addr) ? 6 : 4;
      pinnedAddresses.push({ address: addr, family });
    }

    return { safeUrl: parsed, pinnedAddresses };
  }

  async #performPinnedRequest(
    safeUrl: URL,
    method: "GET" | "POST" | "HEAD",
    headers: Headers,
    body: string | undefined,
    signal: AbortSignal,
    pinnedAddresses: readonly PinnedAddress[],
  ): Promise<Response> {
    const isHttps = safeUrl.protocol === "https:";
    const hostname = stripIpBrackets(safeUrl.hostname);
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    if (body !== undefined && !headers.has("content-length")) {
      headerRecord["content-length"] = String(Buffer.byteLength(body, "utf8"));
    }

    // Support both `{ all: true }` (array callback) and single-address lookup signatures.
    const pinnedLookup: net.LookupFunction = (_lookupHost, opts, callback) => {
      const cb = typeof opts === "function" ? opts : callback;
      const wantAll = typeof opts === "object" && opts !== null && Boolean(opts.all);
      const requestedFamily = typeof opts === "object" && opts !== null ? opts.family : undefined;
      const filtered =
        requestedFamily === 4 || requestedFamily === 6
          ? pinnedAddresses.filter((item) => item.family === requestedFamily)
          : pinnedAddresses;
      const chosen = filtered.length > 0 ? filtered : pinnedAddresses;
      if (chosen.length === 0) {
        (cb as (err: NodeJS.ErrnoException | null) => void)(new Error("No validated upstream addresses"));
        return;
      }
      if (wantAll) {
        (
          cb as (
            err: NodeJS.ErrnoException | null,
            addresses: Array<{ address: string; family: number }>,
          ) => void
        )(
          null,
          chosen.map((item) => ({ address: item.address, family: item.family })),
        );
        return;
      }
      const first = chosen[0];
      if (!first) {
        (cb as (err: NodeJS.ErrnoException | null) => void)(new Error("No validated upstream addresses"));
        return;
      }
      (cb as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
        null,
        first.address,
        first.family,
      );
    };

    return new Promise<Response>((resolve, reject) => {
      const reqOptions: https.RequestOptions = {
        protocol: safeUrl.protocol,
        hostname,
        port: safeUrl.port ? Number(safeUrl.port) : undefined,
        path: `${safeUrl.pathname}${safeUrl.search}`,
        method,
        headers: headerRecord,
        agent: isHttps ? this.#httpsAgent : this.#httpAgent,
        lookup: pinnedLookup,
        signal,
        ...(isHttps ? { servername: hostname } : {}),
      };

      const req = (isHttps ? https.request : http.request)(reqOptions, (res) => {
        const status = res.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const [key, rawValue] of Object.entries(res.headers)) {
          if (rawValue === undefined) continue;
          if (Array.isArray(rawValue)) {
            for (const entry of rawValue) {
              responseHeaders.append(key, entry);
            }
          } else {
            responseHeaders.set(key, rawValue);
          }
        }

        const isBodyless = method === "HEAD" || status === 204 || status === 205 || status === 304;
        if (isBodyless) {
          res.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }

        let stream: Readable = res;
        const isRedirect = status >= 300 && status < 400;
        const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
        if (!isRedirect && encoding) {
          if (encoding === "gzip" || encoding === "x-gzip") {
            const gunzip = zlib.createGunzip();
            res.pipe(gunzip);
            res.on("error", (err) => gunzip.destroy(err));
            stream = gunzip;
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
          } else if (encoding === "deflate") {
            const inflate = zlib.createInflate();
            res.pipe(inflate);
            res.on("error", (err) => inflate.destroy(err));
            stream = inflate;
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
          } else if (encoding === "br") {
            const brotli = zlib.createBrotliDecompress();
            res.pipe(brotli);
            res.on("error", (err) => brotli.destroy(err));
            stream = brotli;
            responseHeaders.delete("content-encoding");
            responseHeaders.delete("content-length");
          }
        }

        const onAbort = () => {
          const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
          stream.destroy(reason);
          res.destroy(reason);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          const cleanup = () => signal.removeEventListener("abort", onAbort);
          stream.once("close", cleanup);
          stream.once("end", cleanup);
          stream.once("error", cleanup);
        }

        const webStream = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
        resolve(new Response(webStream, { status, headers: responseHeaders }));
      });

      req.once("error", (err) => {
        reject(err);
      });

      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  async fetchResponse(
    rawUrl: string,
    options: SafeFetchOptions,
  ): Promise<{ response: Response; finalUrl: string }> {
    const redirectMode = options.redirectMode ?? "follow";
    const maxRedirects = options.maxRedirects ?? 4;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const idleTimeoutMs = options.idleTimeoutMs ?? timeoutMs;

    // Separate header/connect timeout from body idle timeout (J03) so active streams are never cut off
    const headerTimeoutController = new AbortController();
    let headerTimer: NodeJS.Timeout | null = setTimeout(() => {
      headerTimeoutController.abort(createTimeoutError("上游连接或响应头超时。"));
    }, timeoutMs);
    headerTimer.unref?.();
    const clearHeaderTimer = () => {
      if (headerTimer) {
        clearTimeout(headerTimer);
        headerTimer = null;
      }
    };

    const signal = options.signal
      ? AbortSignal.any([options.signal, headerTimeoutController.signal])
      : headerTimeoutController.signal;

    let currentUrl = rawUrl;
    const headers = new Headers(options.headers ?? {});
    let previousHost: string | null = null;

    try {
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const { safeUrl, pinnedAddresses } = await this.#assertSafeTarget(currentUrl, options);

        if (
          options.stripSensitiveHeadersOnHostChange !== false &&
          previousHost &&
          previousHost !== safeUrl.hostname.toLowerCase()
        ) {
          headers.delete("cookie");
          headers.delete("authorization");
        }
        previousHost = safeUrl.hostname.toLowerCase();

        const hopMethod = hop === 0 ? (options.method ?? "GET") : "GET";
        const hopBody = hop === 0 ? options.body : undefined;

        let response: Response;
        try {
          if (this.#customFetchImpl) {
            response = await this.#customFetchImpl(safeUrl.toString(), {
              method: hopMethod,
              headers,
              body: hopBody,
              redirect: "manual",
              signal,
            });
          } else {
            response = await this.#performPinnedRequest(
              safeUrl,
              hopMethod,
              headers,
              hopBody,
              signal,
              pinnedAddresses,
            );
          }
        } catch (error) {
          if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            throw new AppError("UPSTREAM_TIMEOUT", "上游请求超时或已取消。", { cause: error });
          }
          throw new AppError("UPSTREAM_ERROR", "上游网络请求失败。", { cause: error });
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");
        if (isRedirect && location) {
          if (redirectMode === "manual") {
            clearHeaderTimer();
            return { response, finalUrl: safeUrl.toString() };
          }
          if (hop >= maxRedirects) {
            await response.body?.cancel().catch(() => undefined);
            throw new AppError("UPSTREAM_ERROR", "外部地址重定向次数过多。");
          }
          // Cancel redirect response body so sockets are released immediately
          await response.body?.cancel().catch(() => undefined);
          currentUrl = new URL(location, safeUrl).toString();
          continue;
        }

        // Response headers arrived: disarm connect/header timer and guard body reads with per-chunk idle timeout
        clearHeaderTimer();
        if (response.body && idleTimeoutMs > 0) {
          const guardedBody = wrapBodyWithIdleTimeout(response.body, idleTimeoutMs, (err) => {
            headerTimeoutController.abort(err);
          });
          const guardedResponse = new Response(guardedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          return { response: guardedResponse, finalUrl: safeUrl.toString() };
        }

        return { response, finalUrl: safeUrl.toString() };
      }

      throw new AppError("UPSTREAM_ERROR", "外部请求超过最大跳转次数。");
    } catch (error) {
      clearHeaderTimer();
      throw error;
    }
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
      throw new AppError("UPSTREAM_ERROR", `上游响应状态异常：${response.status}`, {
        details: { status: response.status },
      });
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
      return {
        bytes: new Uint8Array(),
        contentType,
        finalUrl,
        status: response.status,
        headers: response.headers,
      };
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
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new AppError("UPSTREAM_TIMEOUT", "读取上游响应超时或已取消。", { cause: error });
      }
      throw new AppError("UPSTREAM_ERROR", "读取上游响应流失败。", { cause: error });
    } finally {
      reader.releaseLock();
    }

    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { bytes: output, contentType, finalUrl, status: response.status, headers: response.headers };
  }
}
