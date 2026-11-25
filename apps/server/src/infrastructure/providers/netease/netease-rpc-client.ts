import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import type { Song } from "#shared";
import { AppError } from "../../../domain/errors.js";
import type {
  CredentialVerificationResult,
  ProviderAuthContext,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { buildNeteaseCookieCacheKey, normalizeNeteaseCookie } from "./netease-cookie.js";
import { type RawNeteasePrivilege, type RawNeteaseSong, mapNeteaseSong } from "./netease-mapper.js";

export type NeteaseCall = (params: Record<string, unknown>) => Promise<{ body: Record<string, unknown> }>;

export interface NeteaseApiModule {
  login_status: NeteaseCall;
  vip_info: NeteaseCall;
  vip_info_v2: NeteaseCall;
  login_qr_key: NeteaseCall;
  login_qr_create: NeteaseCall;
  login_qr_check: NeteaseCall;
  cloudsearch: NeteaseCall;
  song_detail: NeteaseCall;
  personalized_newsong: NeteaseCall;
  personalized: NeteaseCall;
  personal_fm: NeteaseCall;
  personal_fm_mode?: NeteaseCall;
  fm_trash?: NeteaseCall;
  toplist: NeteaseCall;
  artists: NeteaseCall;
  artist_album: NeteaseCall;
  artist_detail: NeteaseCall;
  album: NeteaseCall;
  recommend_songs: NeteaseCall;
  user_cloud: NeteaseCall;
  user_playlist: NeteaseCall;
  playlist_detail: NeteaseCall;
  playlist_track_all: NeteaseCall;
  playlist_tracks: NeteaseCall;
  playlist_create: NeteaseCall;
  lyric_new: NeteaseCall;
  lyric: NeteaseCall;
  comment_music: NeteaseCall;
  comment_like: NeteaseCall;
  likelist: NeteaseCall;
  like: NeteaseCall;
  song_url_v1: NeteaseCall;
  song_download_url_v1: NeteaseCall;
}

export interface NeteaseAxiosRequestConfig {
  url?: string;
  method?: string;
  headers?: Record<string, unknown>;
  data?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  proxy?: false | Record<string, unknown>;
  httpAgent?: unknown;
  httpsAgent?: unknown;
  adapter?: (config: NeteaseAxiosRequestConfig) => Promise<{
    data: unknown;
    status: number;
    statusText: string;
    headers: Record<string, unknown>;
    config: NeteaseAxiosRequestConfig;
  }>;
  [key: string]: unknown;
}

export interface NeteaseAxiosInstance {
  (config: NeteaseAxiosRequestConfig): Promise<unknown>;
  defaults: {
    adapter?: unknown;
    [key: string]: unknown;
  };
  interceptors: {
    request: {
      use(
        onFulfilled: (
          config: NeteaseAxiosRequestConfig,
        ) => NeteaseAxiosRequestConfig | Promise<NeteaseAxiosRequestConfig>,
      ): number;
    };
  };
}

interface NeteaseRequestStore {
  readonly signal?: AbortSignal;
  readonly httpAgent: http.Agent;
  readonly httpsAgent: https.Agent;
}

const KEEP_ALIVE_AGENT_OPTIONS: http.AgentOptions = {
  keepAlive: true,
  maxSockets: 32,
  maxFreeSockets: 8,
};

const INTERCEPTOR_INSTALLED_SYMBOL = Symbol.for("trackvault.netease.axiosInterceptorInstalled");
const neteaseRequestAls = new AsyncLocalStorage<NeteaseRequestStore>();

const require = createRequire(import.meta.url);
const defaultNeteaseApi = require("NeteaseCloudMusicApi") as NeteaseApiModule;
const neteaseRequire = createRequire(require.resolve("NeteaseCloudMusicApi"));
const rawNeteaseAxios = neteaseRequire("axios") as {
  default?: NeteaseAxiosInstance;
} & NeteaseAxiosInstance;
export const neteaseAxios: NeteaseAxiosInstance = rawNeteaseAxios.default ?? rawNeteaseAxios;

function isPlainHttpAgent(agent: unknown): agent is http.Agent {
  return Boolean(agent) && Object.getPrototypeOf(agent) === http.Agent.prototype;
}

function isPlainHttpsAgent(agent: unknown): agent is https.Agent {
  return Boolean(agent) && Object.getPrototypeOf(agent) === https.Agent.prototype;
}

function ensureNeteaseAxiosInterceptor(): void {
  const carrier = neteaseAxios as unknown as Record<symbol, boolean | undefined>;
  if (carrier[INTERCEPTOR_INSTALLED_SYMBOL]) return;
  carrier[INTERCEPTOR_INSTALLED_SYMBOL] = true;

  neteaseAxios.interceptors.request.use((config) => {
    const store = neteaseRequestAls.getStore();
    if (!store) return config;

    if (store.signal) {
      config.signal = store.signal;
    }

    if (config.proxy === false) {
      if (config.httpAgent === undefined || isPlainHttpAgent(config.httpAgent)) {
        if (isPlainHttpAgent(config.httpAgent) && config.httpAgent !== store.httpAgent) {
          config.httpAgent.destroy();
        }
        config.httpAgent = store.httpAgent;
      }
      if (config.httpsAgent === undefined || isPlainHttpsAgent(config.httpsAgent)) {
        if (isPlainHttpsAgent(config.httpsAgent) && config.httpsAgent !== store.httpsAgent) {
          config.httpsAgent.destroy();
        }
        config.httpsAgent = store.httpsAgent;
      }
    }

    return config;
  });
}

ensureNeteaseAxiosInterceptor();

export const SONG_DETAIL_BATCH_SIZE = 500;

export function getNeteaseErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const rec = error as { status?: unknown; code?: unknown; body?: { code?: unknown } };
  const raw = rec.body?.code ?? rec.status ?? rec.code;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

export function extractNeteaseApiError(error: unknown, fallback: string): string {
  if (error instanceof AppError) return error.message;
  if (error && typeof error === "object") {
    const rec = error as {
      message?: unknown;
      body?: { message?: unknown; msg?: unknown; code?: unknown };
    };
    const msg =
      (typeof rec.body?.message === "string" && rec.body.message.trim()) ||
      (typeof rec.body?.msg === "string" && rec.body.msg.trim()) ||
      (typeof rec.message === "string" && rec.message.trim());
    if (msg) return msg;
    if (typeof rec.body?.code === "number") return `${fallback} (code ${rec.body.code})`;
  }
  return fallback;
}

export function isNeteaseCancellationError(error: unknown): boolean {
  if (error instanceof AppError) return error.code === "UPSTREAM_TIMEOUT";
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "CanceledError";
  }
  return false;
}

export class NeteaseRpcClient {
  readonly api: NeteaseApiModule;
  readonly #realIp?: string;
  readonly #timeoutMs?: number;
  readonly #uidCache = new ScopedLruCache<string>({ maxEntries: 50, defaultTtlMs: 10 * 60 * 1000 });
  readonly #httpAgent = new http.Agent(KEEP_ALIVE_AGENT_OPTIONS);
  readonly #httpsAgent = new https.Agent(KEEP_ALIVE_AGENT_OPTIONS);

  constructor(options?: { realIp?: string; timeoutMs?: number; apiOverride?: Partial<NeteaseApiModule> }) {
    this.#realIp = options?.realIp;
    this.#timeoutMs = options?.timeoutMs;
    this.api = options?.apiOverride ? { ...defaultNeteaseApi, ...options.apiOverride } : defaultNeteaseApi;
  }

  get timeoutMs(): number | undefined {
    return this.#timeoutMs;
  }

  close(): void {
    this.#httpAgent.destroy();
    this.#httpsAgent.destroy();
  }

  destroy(): void {
    this.close();
  }

  invalidateScope(scopeKey: string): void {
    this.#uidCache.invalidateScope(scopeKey);
  }

  getCachedUid(scopeKey: string, cookie: string): string | undefined {
    return this.#uidCache.get(scopeKey, buildNeteaseCookieCacheKey(cookie));
  }

  baseParams(
    auth?: Pick<ProviderAuthContext, "cookie" | "signal">,
    extra: Record<string, unknown> = {},
    signalOverride?: AbortSignal,
  ): Record<string, unknown> {
    const normalizedCookie = auth?.cookie ? normalizeNeteaseCookie(auth.cookie) : "";
    const signal = signalOverride ?? auth?.signal;
    return {
      ...extra,
      ...(normalizedCookie ? { cookie: normalizedCookie } : {}),
      ...(this.#realIp ? { realIP: this.#realIp } : {}),
      ...(this.#timeoutMs && this.#timeoutMs > 0 ? { timeout: this.#timeoutMs } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  async call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
    }
    const store: NeteaseRequestStore = {
      ...(signal ? { signal } : {}),
      httpAgent: this.#httpAgent,
      httpsAgent: this.#httpsAgent,
    };
    const execution = neteaseRequestAls.run(store, fn);
    return signal ? this.raceWithSignal(execution, signal) : execution;
  }

  raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) {
      promise.catch(() => undefined);
      return Promise.reject(new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  assertBusinessSuccess(body: Record<string, unknown>, fallback: string): void {
    const outerCode = body.code !== undefined && body.code !== null ? Number(body.code) : 200;
    const nested = body.body as { code?: unknown; message?: unknown; msg?: unknown } | undefined;
    const innerCode = nested?.code !== undefined && nested.code !== null ? Number(nested.code) : 200;

    const failedCode = outerCode !== 200 ? outerCode : innerCode !== 200 ? innerCode : 200;
    if (failedCode === 200) return;

    const msg =
      (typeof nested?.message === "string" && nested.message.trim()) ||
      (typeof nested?.msg === "string" && nested.msg.trim()) ||
      (typeof body.message === "string" && body.message.trim()) ||
      (typeof body.msg === "string" && body.msg.trim()) ||
      `${fallback} (code ${failedCode})`;

    if (failedCode === 301 || failedCode === 401) {
      throw new AppError("CREDENTIAL_INVALID", msg);
    }
    throw new AppError("UPSTREAM_ERROR", msg);
  }

  wrapUpstreamError(error: unknown, fallback: string): AppError {
    if (error instanceof AppError) return error;
    if (isNeteaseCancellationError(error)) {
      return new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。", { cause: error });
    }
    const code = getNeteaseErrorCode(error);
    if (code === 301 || code === 401) {
      return new AppError(
        "CREDENTIAL_INVALID",
        extractNeteaseApiError(error, "网易云登录态已失效，请重新绑定。"),
        {
          cause: error,
        },
      );
    }
    return new AppError("UPSTREAM_ERROR", extractNeteaseApiError(error, fallback), { cause: error });
  }

  assertAuthed(auth: ProviderAuthContext): string {
    if (!auth.cookie?.trim()) {
      throw new AppError("CREDENTIAL_REQUIRED", "该操作需要先绑定网易云音乐账号。");
    }
    return auth.cookie.trim();
  }

  async resolveUid(
    auth: ProviderAuthContext,
    verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>,
  ): Promise<string> {
    if (auth.accountUid?.trim()) {
      return auth.accountUid.trim();
    }
    const cookie = this.assertAuthed(auth);
    const uidKey = buildNeteaseCookieCacheKey(cookie);
    const cached = this.#uidCache.get(auth.scopeKey, uidKey);
    if (cached) return cached;

    const uidEpoch = this.#uidCache.getEpoch(auth.scopeKey);
    const verified = await verifyCredential(cookie);
    if (!verified.ok || !verified.accountUid) {
      throw new AppError("CREDENTIAL_INVALID", "网易云登录态已失效，请重新绑定。");
    }
    this.#uidCache.setIfEpoch(auth.scopeKey, uidKey, verified.accountUid, uidEpoch);
    return verified.accountUid;
  }

  /**
   * PP-08: Unified privilege hydration and Song mapping across search, discover, daily,
   * personal FM, artist hot songs, and album tracks.
   */
  async hydrateAndMapNeteaseSongs(
    rawSongs: readonly RawNeteaseSong[],
    auth: ProviderAuthContext,
    options?: {
      privileges?: readonly RawNeteasePrivilege[];
      isCloud?: boolean;
    },
  ): Promise<Song[]> {
    if (rawSongs.length === 0) return [];

    const privMap = new Map<string, RawNeteasePrivilege>();
    for (const priv of options?.privileges ?? []) {
      if (priv.id !== undefined && priv.id !== null) {
        privMap.set(String(priv.id), priv);
      }
    }

    if (!options?.isCloud) {
      const missingPrivIds: string[] = [];
      const seenMissing = new Set<string>();
      for (const rawSong of rawSongs) {
        if (rawSong.id === undefined || rawSong.id === null) continue;
        const id = String(rawSong.id).trim();
        if (!id || privMap.has(id)) continue;
        const embedded = rawSong.privilege;
        const hasUsefulPrivilege =
          Boolean(embedded) && (embedded?.pl !== undefined || embedded?.fee !== undefined);
        if (!hasUsefulPrivilege && !seenMissing.has(id)) {
          seenMissing.add(id);
          missingPrivIds.push(id);
        }
      }

      for (let i = 0; i < missingPrivIds.length; i += SONG_DETAIL_BATCH_SIZE) {
        if (auth.signal?.aborted) {
          throw new AppError("UPSTREAM_TIMEOUT", "上游请求已取消。");
        }
        const batch = missingPrivIds.slice(i, i + SONG_DETAIL_BATCH_SIZE);
        try {
          const detail = await this.call(
            () => this.api.song_detail(this.baseParams(auth, { ids: batch.join(",") })),
            auth.signal,
          );
          const fetchedPrivs = (detail.body.privileges as RawNeteasePrivilege[] | undefined) ?? [];
          for (const priv of fetchedPrivs) {
            if (priv.id !== undefined && priv.id !== null) {
              privMap.set(String(priv.id), priv);
            }
          }
        } catch (error) {
          if (
            isNeteaseCancellationError(error) ||
            (error instanceof AppError && error.code === "CREDENTIAL_INVALID")
          ) {
            throw error;
          }
          // Non-fatal enrichment failure falls back to raw song fields
        }
      }
    }

    return rawSongs
      .map((song) => {
        const id = song.id !== undefined && song.id !== null ? String(song.id).trim() : "";
        const priv = id ? (privMap.get(id) ?? song.privilege) : song.privilege;
        return mapNeteaseSong(song, { privilege: priv, isCloud: options?.isCloud });
      })
      .filter((song): song is Song => song !== null);
  }
}
