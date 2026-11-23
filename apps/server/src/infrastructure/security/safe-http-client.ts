import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import zlib from "node:zlib";
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

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

function stripIpBrackets(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, "");
}

function parseIpv4ToUint32(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isPrivateOrReservedIpv4Uint32(val: number): boolean {
  const a = (val >>> 24) & 0xff;
  const b = (val >>> 16) & 0xff;
  const c = (val >>> 8) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // Link-local / cloud metadata 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113/24
  if (a >= 224) return true; // Multicast & reserved 224/4, 240/4
  return false;
}

function parseIpv6ToGroups(raw: string): number[] | null {
  const clean = stripIpBrackets(raw).split("%")[0]?.toLowerCase() ?? "";
  if (!net.isIPv6(clean)) return null;

  let work = clean;
  const lastColon = work.lastIndexOf(":");
  if (lastColon >= 0 && work.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4ToUint32(work.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = work.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;

  const full = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (full.length !== 8) return null;

  const groups = full.map((g) => Number.parseInt(g, 16));
  if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return groups;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = stripIpBrackets(ip).toLowerCase();
  const ipv4 = parseIpv4ToUint32(normalized);
  if (ipv4 !== null) {
    return isPrivateOrReservedIpv4Uint32(ipv4);
  }

  const g = parseIpv6ToGroups(normalized);
  if (!g) {
    return true;
  }

  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const lower32 = ((g6 << 16) | g7) >>> 0;

  // ::/128 unspecified & ::1/128 loopback
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
    // Deprecated IPv4-compatible ::/96
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // IPv4-mapped ::ffff:0:0/96 (both dotted and fully expanded hex forms)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateOrReservedIpv4Uint32(lower32);
  }
  // NAT64 local-use prefix 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) {
    return true;
  }
  // Discard prefix 100::/64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true;
  }
  // Documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }
  // 6to4 2002::/16 (check embedded IPv4 in bits 16..47)
  if (g0 === 0x2002) {
    const embeddedV4 = ((g1 << 16) | g2) >>> 0;
    return isPrivateOrReservedIpv4Uint32(embeddedV4);
  }
  // Unique Local Addresses fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // Link-local fe80::/10 & deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) {
    return true;
  }
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

export function matchesHostSuffixes(hostname: string, suffixes: readonly string[]): boolean {
  const normalized = stripIpBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return suffixes.some((suffix) => {
    const clean = suffix.trim().toLowerCase().replace(/^\./, "");
    return normalized === clean || normalized.endsWith(`.${clean}`);
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
    const maxRedirects = options.maxRedirects ?? 4;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let currentUrl = rawUrl;
    const headers = new Headers(options.headers ?? {});
    let previousHost: string | null = null;

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
        if (hop >= maxRedirects) {
          await response.body?.cancel().catch(() => undefined);
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

    return { bytes: output, contentType, finalUrl, status: response.status };
  }
}
