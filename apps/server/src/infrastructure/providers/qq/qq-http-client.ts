import { AppError } from "../../../domain/errors.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { computeQqGtk, serializeQqCookie } from "./qq-cookie.js";

export const QQ_ALLOWED_HOST_SUFFIXES = ["qq.com", "y.qq.com", "gtimg.cn", "qpic.cn"] as const;
const QQ_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Single JSONP unwrapper used across all QQ Music endpoints.
 */
export function parseJsonpOrJson<T>(rawText: string): T {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new AppError("UPSTREAM_ERROR", "QQ 音乐返回了空响应。");
  }
  const jsonText =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? trimmed
      : trimmed.replace(/^[\w.$]+\s*\(/, "").replace(/\)\s*;?$/, "");

  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    throw new AppError("UPSTREAM_ERROR", "QQ 音乐响应解析失败。", { cause: error });
  }
}

const MAX_QQ_JSON_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Completely stateless QQ Music HTTP client.
 * Every request explicitly receives its own cookieMap — zero process-wide global singleton state.
 */
export class QqMusicHttpClient {
  readonly #http: SafeHttpClient;

  constructor(http: SafeHttpClient) {
    this.#http = http;
  }

  async requestJson<T>(input: {
    url: string;
    method?: "GET" | "POST";
    query?: Record<string, string | number | undefined>;
    body?: string;
    referer?: string;
    contentType?: string;
    cookieMap?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<T> {
    const parsedUrl = new URL(input.url);
    if (input.query) {
      for (const [k, v] of Object.entries(input.query)) {
        if (v !== undefined) parsedUrl.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      "User-Agent": QQ_USER_AGENT,
      Referer: input.referer ?? "https://y.qq.com/",
      Origin: "https://y.qq.com",
    };

    if (input.contentType) {
      headers["Content-Type"] = input.contentType;
    }

    if (input.cookieMap && Object.keys(input.cookieMap).length > 0) {
      headers.Cookie = serializeQqCookie(input.cookieMap);
    }

    const { bytes } = await this.#http.fetchBoundedBytes(parsedUrl.toString(), {
      method: input.method ?? "GET",
      headers,
      body: input.body,
      allowedHostSuffixes: QQ_ALLOWED_HOST_SUFFIXES,
      allowHttp: false,
      maxRedirects: 2,
      maxBytes: MAX_QQ_JSON_BYTES,
      signal: input.signal,
    });

    const text = textDecoder.decode(bytes);
    return parseJsonpOrJson<T>(text);
  }

  async musicu<T>(
    payload: Record<string, unknown>,
    cookieMap?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const uin = cookieMap?.uin ?? "0";
    const key = cookieMap?.qm_keyst || cookieMap?.qqmusic_key || "";
    const body = JSON.stringify({
      comm: {
        uin,
        format: "json",
        ct: 19,
        cv: 0,
        ...(key ? { authst: key } : {}),
      },
      ...payload,
    });

    return this.requestJson<T>({
      url: "https://u.y.qq.com/cgi-bin/musicu.fcg",
      method: "POST",
      query: {
        g_tk: cookieMap ? computeQqGtk(cookieMap) : 5381,
        loginUin: uin,
        hostUin: 0,
        format: "json",
        inCharset: "utf8",
        outCharset: "utf-8",
        platform: "yqq.json",
        needNewCode: 0,
      },
      body,
      contentType: "application/json; charset=utf-8",
      cookieMap,
      signal,
    });
  }
}
