import crypto from "node:crypto";
import { AppError } from "../../../domain/errors.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import type { KugouCookieMap } from "./kugou-cookie.js";
import {
  KUGOU_EDITION_CONFIGS,
  type KugouEdition,
  calculateKugouMid,
  kugouRegisterAesDecrypt,
  kugouRegisterAesEncrypt,
  kugouRsaPkcs1EncryptHex,
  md5Hex,
  randomAlphaNum,
  signKugouAndroidParams,
  signKugouTrackKey,
  signKugouWebParams,
} from "./kugou-crypto.js";

export const KUGOU_ALLOWED_HOST_SUFFIXES = ["kugou.com", "weixin.qq.com", "qq.com"] as const;

const KUGOU_ANDROID_UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi";
const MAX_KUGOU_JSON_BYTES = 8 * 1024 * 1024;
const DFID_TTL_MS = 12 * 60 * 60 * 1000;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

function isKugouAuthInvalidCode(errorCode: unknown): boolean {
  const num = Number(errorCode);
  return num === 20018 || num === 20019 || num === 30001 || num === 30005 || num === 200014;
}

export interface KugouRequestOptions {
  readonly baseUrl?: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly params?: Record<string, string | number | boolean | undefined>;
  readonly data?: Record<string, unknown> | string;
  readonly headers?: Record<string, string>;
  readonly cookieMap?: Partial<KugouCookieMap> | null;
  readonly edition?: KugouEdition;
  readonly encryptType?: "android" | "web";
  readonly encryptKey?: boolean;
  readonly clearDefaultParams?: boolean;
  readonly notSignature?: boolean;
  readonly requireRegisteredDfid?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class KugouHttpClient {
  readonly #http: SafeHttpClient;
  readonly deviceGuid: string;
  readonly deviceMid: string;
  readonly deviceDev: string;
  readonly deviceMac = "02:00:00:00:00:00";

  #dfidCache = new Map<KugouEdition, { dfid: string; expiresAt: number }>();
  #dfidInflight = new Map<KugouEdition, Promise<string>>();

  constructor(http: SafeHttpClient, seedGuid?: string) {
    this.#http = http;
    this.deviceGuid = md5Hex(seedGuid ?? crypto.randomUUID());
    this.deviceMid = calculateKugouMid(this.deviceGuid);
    this.deviceDev = randomAlphaNum(10, false);
  }

  async ensureDfid(edition: KugouEdition = "lite", signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    const cached = this.#dfidCache.get(edition);
    if (cached && cached.expiresAt > now) {
      return cached.dfid;
    }

    const inflight = this.#dfidInflight.get(edition);
    if (inflight) {
      return inflight;
    }

    const task = this.#registerDeviceDfid(edition, signal).finally(() => {
      this.#dfidInflight.delete(edition);
    });
    this.#dfidInflight.set(edition, task);
    return task;
  }

  async #registerDeviceDfid(edition: KugouEdition, signal?: AbortSignal): Promise<string> {
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const clienttime = Math.floor(Date.now() / 1000);
    const devPayload: Record<string, unknown> = {
      availableRamSize: 4_983_533_568,
      availableRomSize: 48_114_719,
      availableSDSize: 48_114_717,
      basebandVer: "",
      batteryLevel: 100,
      batteryStatus: 3,
      brand: "Redmi",
      buildSerial: "unknown",
      device: "marble",
      imei: this.deviceGuid,
      imsi: "",
      manufacturer: "Xiaomi",
      uuid: this.deviceGuid,
      accelerometer: false,
      accelerometerValue: "",
      gravity: false,
      gravityValue: "",
      gyroscope: false,
      gyroscopeValue: "",
      light: false,
      lightValue: "",
      magnetic: false,
      magneticValue: "",
      orientation: false,
      orientationValue: "",
      pressure: false,
      pressureValue: "",
      step_counter: false,
      step_counterValue: "",
      temperature: false,
      temperatureValue: "",
    };

    const { key: aesSeed, base64Body } = kugouRegisterAesEncrypt(devPayload);
    const p = kugouRsaPkcs1EncryptHex({ aes: aesSeed, uid: 0, token: "" }, edition);

    const queryParams: Record<string, string | number> = {
      dfid: "-",
      mid: this.deviceMid,
      uuid: "-",
      appid: conf.appid,
      clientver: conf.clientver,
      clienttime,
      part: 1,
      platid: 1,
      p,
    };
    queryParams.signature = signKugouAndroidParams(queryParams, base64Body, edition);

    try {
      const url = new URL("https://userservice.kugou.com/risk/v3/r_register_dev");
      for (const [k, v] of Object.entries(queryParams)) {
        url.searchParams.set(k, String(v));
      }

      const { bytes } = await this.#http.fetchBoundedBytes(url.toString(), {
        method: "POST",
        headers: {
          "User-Agent": KUGOU_ANDROID_UA,
          "Content-Type": "text/plain;charset=UTF-8",
          dfid: "-",
          mid: this.deviceMid,
          clienttime: String(clienttime),
        },
        body: base64Body,
        allowedHostSuffixes: KUGOU_ALLOWED_HOST_SUFFIXES,
        allowHttp: false,
        maxRedirects: 2,
        maxBytes: 256 * 1024,
        timeoutMs: 8_000,
        signal,
      });

      const decrypted = kugouRegisterAesDecrypt(bytes, aesSeed);
      const dataNode = decrypted?.data as { dfid?: unknown } | undefined;
      const dfid = typeof dataNode?.dfid === "string" ? dataNode.dfid.trim() : "";
      if (dfid && dfid !== "-") {
        this.#dfidCache.set(edition, { dfid, expiresAt: Date.now() + DFID_TTL_MS });
        return dfid;
      }
    } catch {
      // Fall back to synthetic random dfid so non-strict endpoints remain operational
    }

    return randomAlphaNum(24, true);
  }

  async request<T>(options: KugouRequestOptions): Promise<T> {
    const edition: KugouEdition = options.edition ?? options.cookieMap?.kg_edition ?? "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const clienttime = Math.floor(Date.now() / 1000);

    let dfid = options.cookieMap?.dfid?.trim() || "-";
    if ((dfid === "-" || !dfid) && options.requireRegisteredDfid) {
      dfid = await this.ensureDfid(edition, options.signal);
    }

    const userid = options.cookieMap?.userid?.trim() || "";
    const token = options.cookieMap?.token?.trim() || "";

    const mergedParams: Record<string, string | number | boolean> = {};
    if (!options.clearDefaultParams) {
      mergedParams.dfid = dfid;
      mergedParams.mid = this.deviceMid;
      mergedParams.uuid = "-";
      mergedParams.appid = conf.appid;
      mergedParams.clientver = conf.clientver;
      mergedParams.clienttime = clienttime;
      if (token) mergedParams.token = token;
      if (userid && userid !== "0") mergedParams.userid = userid;
    }

    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined) {
          mergedParams[k] = v;
        }
      }
    }

    if (options.encryptKey && typeof mergedParams.hash === "string") {
      const appidForKey = typeof mergedParams.appid === "number" ? mergedParams.appid : conf.appid;
      mergedParams.key = signKugouTrackKey(
        mergedParams.hash,
        String(mergedParams.mid ?? this.deviceMid),
        userid || 0,
        edition,
        appidForKey,
      );
    }

    const bodyString =
      options.data === undefined
        ? ""
        : typeof options.data === "string"
          ? options.data
          : JSON.stringify(options.data);

    if (!options.notSignature && mergedParams.signature === undefined) {
      if (options.encryptType === "web") {
        mergedParams.signature = signKugouWebParams(mergedParams, bodyString);
      } else {
        mergedParams.signature = signKugouAndroidParams(mergedParams, bodyString, edition);
      }
    }

    const baseUrl = (options.baseUrl ?? "https://gateway.kugou.com").replace(/^http:\/\//i, "https://");
    const targetUrl = new URL(options.path, baseUrl);
    for (const [k, v] of Object.entries(mergedParams)) {
      targetUrl.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      "User-Agent": KUGOU_ANDROID_UA,
      dfid,
      mid: this.deviceMid,
      clienttime: String(mergedParams.clienttime ?? clienttime),
      "kg-rc": "1",
      "kg-thash": "5d816a0",
      "kg-rec": "1",
      "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
      ...(bodyString ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(options.headers ?? {}),
    };

    let bytes: Uint8Array;
    try {
      const fetched = await this.#http.fetchBoundedBytes(targetUrl.toString(), {
        method: options.method ?? "GET",
        headers,
        body: bodyString || undefined,
        allowedHostSuffixes: KUGOU_ALLOWED_HOST_SUFFIXES,
        allowHttp: false,
        maxRedirects: 2,
        maxBytes: MAX_KUGOU_JSON_BYTES,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      bytes = fetched.bytes;
    } catch (error) {
      if (error instanceof AppError) {
        const status = (error.details as { status?: unknown } | undefined)?.status;
        if (Boolean(token) && (status === 401 || status === 403 || /\b(?:401|403)\b/.test(error.message))) {
          throw new AppError("CREDENTIAL_INVALID", "酷狗音乐登录态已失效或无权访问，请重新绑定。", {
            cause: error,
            details: error.details,
          });
        }
      }
      throw error;
    }

    const rawText = textDecoder.decode(bytes).trim();
    if (!rawText) {
      throw new AppError("UPSTREAM_ERROR", "酷狗音乐服务返回了空响应。");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", "酷狗音乐响应 JSON 解析失败。", { cause: error });
    }

    if (Boolean(token) && isKugouAuthInvalidCode(parsed.error_code ?? parsed.errcode)) {
      throw new AppError("CREDENTIAL_INVALID", "酷狗音乐登录凭证已过期，请重新扫码绑定。");
    }

    return parsed as T;
  }

  async requestExternalJson<T>(
    url: string,
    options?: {
      method?: "GET" | "POST";
      query?: Record<string, string | number | undefined>;
      headers?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const parsedUrl = new URL(url);
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined) parsedUrl.searchParams.set(k, String(v));
      }
    }
    const { bytes } = await this.#http.fetchBoundedBytes(parsedUrl.toString(), {
      method: options?.method ?? "GET",
      headers: options?.headers,
      allowedHostSuffixes: KUGOU_ALLOWED_HOST_SUFFIXES,
      allowHttp: false,
      maxRedirects: 2,
      maxBytes: MAX_KUGOU_JSON_BYTES,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
    });
    const text = textDecoder.decode(bytes).trim();
    if (!text) {
      throw new AppError("UPSTREAM_ERROR", "第三方授权接口返回了空响应。");
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", "第三方授权接口响应解析失败。", { cause: error });
    }
  }
}
