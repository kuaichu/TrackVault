import type { QualityLevel } from "#shared";
import { AppError } from "../../../domain/errors.js";
import { buildDownwardQualityOrder, isQualityDowngraded } from "../../../domain/policies/quality-policy.js";
import type {
  AudioResolveTarget,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { parseKugouAuthCookie } from "./kugou-cookie.js";
import { KUGOU_EDITION_CONFIGS, type KugouEdition, md5Hex } from "./kugou-crypto.js";
import type { KugouHttpClient } from "./kugou-http-client.js";
import { parseKugouMediaId } from "./kugou-mapper.js";

type KugouQualityTier = "high" | "flac" | "320" | "128";

interface KugouQualitySpec {
  readonly tier: KugouQualityTier;
  readonly level: QualityLevel;
  readonly fallbackFormat: string;
  readonly fallbackBitrate: number;
}

const KUGOU_SPECS: Record<KugouQualityTier, KugouQualitySpec> = {
  high: { tier: "high", level: "hires", fallbackFormat: "flac", fallbackBitrate: 1_800_000 },
  flac: { tier: "flac", level: "lossless", fallbackFormat: "flac", fallbackBitrate: 950_000 },
  "320": { tier: "320", level: "exhigh", fallbackFormat: "mp3", fallbackBitrate: 320_000 },
  "128": { tier: "128", level: "standard", fallbackFormat: "mp3", fallbackBitrate: 128_000 },
};

function levelToKugouSpecs(
  level: QualityLevel,
  availableLevels?: readonly QualityLevel[],
): KugouQualitySpec[] {
  const ordered = buildDownwardQualityOrder(level, availableLevels);
  const specs: KugouQualitySpec[] = [];
  const seen = new Set<KugouQualityTier>();
  const add = (spec: KugouQualitySpec) => {
    if (!seen.has(spec.tier)) {
      seen.add(spec.tier);
      specs.push(spec);
    }
  };
  for (const item of ordered) {
    if (item === "hires" || item === "jymaster") {
      add(KUGOU_SPECS.high);
      add(KUGOU_SPECS.flac);
    } else if (item === "lossless") {
      add(KUGOU_SPECS.flac);
    } else if (
      item === "exhigh" ||
      item === "jyeffect" ||
      item === "sky" ||
      item === "vivid" ||
      item === "dolby"
    ) {
      add(KUGOU_SPECS["320"]);
    } else {
      add(KUGOU_SPECS["128"]);
    }
  }
  add(KUGOU_SPECS["128"]);
  return specs;
}

interface CachedResourceHashes {
  albumId: number;
  mixSongId: number;
  hashes: Partial<Record<KugouQualityTier, string>>;
}

interface RawKugouV5UrlResponse {
  status?: number;
  err_code?: number;
  fail_process?: string[] | number;
  url?: string[];
  backupUrl?: string[];
  extName?: string;
  bitRate?: number;
  timeLength?: number;
}

interface RawKugouPrivUrlResponse {
  status?: number;
  data?: Array<{
    info?: {
      tracker_url?: string[];
      extname?: string;
      bitrate?: number;
      duration?: number;
    };
  }>;
}

function normalizeAudioUrl(urls: readonly (string | undefined)[]): string | null {
  for (const raw of urls) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^http:\/\//i, "https://");
  }
  return null;
}

export class KugouAudioResolver {
  readonly #client: KugouHttpClient;
  readonly #resourceCache = new ScopedLruCache<CachedResourceHashes>({
    maxEntries: 300,
    defaultTtlMs: 30 * 60 * 1000,
  });

  constructor(client: KugouHttpClient) {
    this.#client = client;
  }

  async #resolveResourceHashes(
    baseHash: string,
    initialMixId: number,
    initialAlbumId: number,
    edition: KugouEdition,
    auth: ProviderAuthContext,
  ): Promise<CachedResourceHashes> {
    const cleanHash = baseHash.toLowerCase();
    const cached = this.#resourceCache.get("public", cleanHash);
    if (cached) return cached;

    const conf = KUGOU_EDITION_CONFIGS[edition];
    try {
      const res = await this.#client.request<{
        data?: Array<{
          album_id?: number | string;
          album_audio_id?: number | string;
          relate_goods?: Array<{ hash?: string; level?: number; quality?: string }>;
        }>;
      }>({
        path: "/v2/get_res_privilege/lite",
        method: "POST",
        data: {
          appid: conf.appid,
          area_code: 1,
          behavior: "play",
          clientver: conf.clientver,
          need_hash_offset: 1,
          relate: 1,
          support_verify: 1,
          resource: [{ type: "audio", page_id: 0, hash: cleanHash, album_id: initialAlbumId }],
          qualities: ["128", "320", "flac", "high"],
        },
        headers: { "x-router": "media.store.kugou.com" },
        edition,
        signal: auth.signal,
      });

      const node = res.data?.[0];
      const goods = node?.relate_goods ?? [];
      const pick = (lvl: number, q: string) =>
        goods
          .find((g) => (g.level === lvl || g.quality === q) && typeof g.hash === "string" && g.hash.trim())
          ?.hash?.trim()
          .toLowerCase();

      const resolved: CachedResourceHashes = {
        albumId: Number(node?.album_id ?? initialAlbumId) || initialAlbumId,
        mixSongId: Number(node?.album_audio_id ?? initialMixId) || initialMixId,
        hashes: {
          "128": pick(2, "128") || cleanHash,
          "320": pick(4, "320"),
          flac: pick(5, "flac"),
          high: pick(6, "high"),
        },
      };
      this.#resourceCache.set("public", cleanHash, resolved);
      return resolved;
    } catch {
      return {
        albumId: initialAlbumId,
        mixSongId: initialMixId,
        hashes: { "128": cleanHash },
      };
    }
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    _mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    const baseHash = target.id.trim().toLowerCase();
    if (!baseHash) {
      throw new AppError("VALIDATION_ERROR", "缺少有效的酷狗歌曲 Hash。");
    }

    const cookieMap = parseKugouAuthCookie(auth);
    const edition: KugouEdition = cookieMap?.kg_edition ?? "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const parsedMedia = parseKugouMediaId(target.mediaId);
    const initialMixId = parsedMedia.mixSongId || Number(target.providerSongId ?? 0) || 0;

    const specs = levelToKugouSpecs(level, target.availableLevels);
    const needsMultiHash = specs.some((s) => s.tier !== "128") || !initialMixId;
    const resource = needsMultiHash
      ? await this.#resolveResourceHashes(baseHash, initialMixId, parsedMedia.albumId, edition, auth)
      : { albumId: parsedMedia.albumId, mixSongId: initialMixId, hashes: { "128": baseHash } };

    const dfid = cookieMap?.dfid || (await this.#client.ensureDfid(edition, auth.signal));
    const effectiveCookie = cookieMap ? { ...cookieMap, dfid } : { dfid, kg_edition: edition };

    let sawVipRestriction = false;
    let lastError: AppError | null = null;

    for (const spec of specs) {
      const tierHash = resource.hashes[spec.tier] ?? (spec.tier === "128" ? baseHash : undefined);
      if (!tierHash) continue;

      let res: RawKugouV5UrlResponse;
      try {
        res = await this.#client.request<RawKugouV5UrlResponse>({
          path: "/v5/url",
          method: "GET",
          params: {
            album_id: resource.albumId,
            area_code: 1,
            hash: tierHash,
            ssa_flag: "is_fromtrack",
            version: 11430,
            page_id: conf.pageId,
            quality: spec.tier === "128" ? 128 : spec.tier === "320" ? 320 : spec.tier,
            album_audio_id: resource.mixSongId,
            behavior: "play",
            pid: conf.pid,
            cmd: 26,
            pidversion: 3001,
            IsFreePart: 0,
            ppage_id: conf.ppageId,
            cdnBackup: 1,
            module: "",
            clientver: 11430,
          },
          headers: { "x-router": "trackercdn.kugou.com" },
          cookieMap: effectiveCookie,
          edition,
          encryptKey: true,
          requireRegisteredDfid: true,
          signal: auth.signal,
        });
      } catch (error) {
        if (error instanceof AppError) {
          if (
            error.code === "CREDENTIAL_INVALID" ||
            error.code === "CREDENTIAL_REQUIRED" ||
            error.code === "UPSTREAM_TIMEOUT"
          ) {
            throw error;
          }
          lastError = error;
        } else {
          lastError = new AppError("UPSTREAM_ERROR", "酷狗音源解析请求失败。", { cause: error });
        }
        continue;
      }

      const fullUrl = normalizeAudioUrl([...(res.url ?? []), ...(res.backupUrl ?? [])]);
      if (res.status === 1 && fullUrl) {
        const format = (res.extName || spec.fallbackFormat).replace(/^\./, "").toLowerCase();
        const rawBr = Number(res.bitRate ?? 0) || spec.fallbackBitrate;
        const bitrate = rawBr < 10_000 ? rawBr * 1000 : rawBr;
        const downgraded = isQualityDowngraded(level, { bitrate, format, level: spec.level });
        return {
          url: fullUrl,
          format,
          bitrate,
          level: spec.level,
          durationSeconds: Number(res.timeLength ?? 0) || target.durationSeconds || null,
          trial: false,
          downgraded,
        };
      }

      const failList = Array.isArray(res.fail_process) ? res.fail_process : [];
      if (res.status === 2 || failList.includes("pkg") || failList.includes("vip")) {
        sawVipRestriction = true;
      }
    }

    // Concept Edition (`lite`) logged-in fallback via `/v6/priv_url` for free-listen 128K tracks
    if (edition === "lite" && cookieMap?.userid && cookieMap.token) {
      try {
        const hash128 = resource.hashes["128"] ?? baseHash;
        const privUrlRes = await this.#client.request<RawKugouPrivUrlResponse>({
          path: "/v6/priv_url",
          method: "POST",
          data: {
            area_code: "1",
            behavior: "play",
            qualities: ["128", "320", "flac", "high"],
            resource: {
              album_audio_id: resource.mixSongId,
              collect_list_id: "3",
              collect_time: Date.now(),
              hash: hash128,
              id: 0,
              page_id: 1,
              type: "audio",
            },
            token: cookieMap.token,
            tracker_param: {
              all_m: 1,
              auth: "",
              is_free_part: 0,
              key: md5Hex(
                `${hash128}185672dd44712f60bb1736df5a377e82${KUGOU_EDITION_CONFIGS.lite.appid}${this.#client.deviceMid}${cookieMap.userid}`,
              ),
              module_id: 0,
              need_climax: 1,
              need_xcdn: 1,
              open_time: "",
              pid: "411",
              pidversion: "3001",
              priv_vip_type: "6",
              viptoken: cookieMap.vip_token ?? "",
            },
            userid: cookieMap.userid,
            vip: Number(cookieMap.vip_type ?? 0) || 0,
          },
          headers: { "x-router": "tracker.kugou.com" },
          cookieMap: effectiveCookie,
          edition: "lite",
          requireRegisteredDfid: true,
          signal: auth.signal,
        });

        const firstInfo = privUrlRes.data?.find((d) => (d.info?.tracker_url?.length ?? 0) > 0)?.info;
        const privFullUrl = normalizeAudioUrl(firstInfo?.tracker_url ?? []);
        if (privFullUrl) {
          const format = (firstInfo?.extname || "mp3").replace(/^\./, "").toLowerCase();
          const rawBr = Number(firstInfo?.bitrate ?? 128_000) || 128_000;
          const bitrate = rawBr < 10_000 ? rawBr * 1000 : rawBr;
          return {
            url: privFullUrl,
            format,
            bitrate,
            level: "standard",
            durationSeconds:
              (firstInfo?.duration ? Math.round(firstInfo.duration / 1000) : 0) ||
              target.durationSeconds ||
              null,
            trial: false,
            downgraded: level !== "standard",
          };
        }
      } catch {
        // Ignore fallback failure and proceed to trial / error reporting
      }
    }

    // Probe 60s trial clip (`IsFreePart: 1`) so transfer probe & UI accurately surface trial/VIP status
    try {
      const trialRes = await this.#client.request<RawKugouV5UrlResponse>({
        path: "/v5/url",
        method: "GET",
        params: {
          album_id: resource.albumId,
          area_code: 1,
          hash: resource.hashes["128"] ?? baseHash,
          ssa_flag: "is_fromtrack",
          version: 11430,
          page_id: conf.pageId,
          quality: 128,
          album_audio_id: resource.mixSongId,
          behavior: "play",
          pid: conf.pid,
          cmd: 26,
          pidversion: 3001,
          IsFreePart: 1,
          ppage_id: conf.ppageId,
          cdnBackup: 1,
          module: "",
          clientver: 11430,
        },
        headers: { "x-router": "trackercdn.kugou.com" },
        cookieMap: effectiveCookie,
        edition,
        encryptKey: true,
        requireRegisteredDfid: true,
        signal: auth.signal,
      });

      const trialUrl = normalizeAudioUrl([...(trialRes.url ?? []), ...(trialRes.backupUrl ?? [])]);
      if (trialRes.status === 1 && trialUrl) {
        return {
          url: trialUrl,
          format: (trialRes.extName || "mp3").replace(/^\./, "").toLowerCase(),
          bitrate: 128_000,
          level: "standard",
          durationSeconds: Number(trialRes.timeLength ?? 60) || 60,
          trial: true,
          downgraded: level !== "standard",
        };
      }
    } catch {
      // Ignore trial fallback error
    }

    if (lastError) throw lastError;
    if (sawVipRestriction) {
      throw new AppError(
        "VIP_REQUIRED",
        "该酷狗曲目需要酷狗音乐 VIP 权限（或使用概念版账号登录）才能播放完整版。",
      );
    }

    throw new AppError(
      "COPYRIGHT_UNAVAILABLE",
      "酷狗音乐未返回可用音频链接，请检查酷狗账号绑定、会员权限或该曲目版权状态。",
    );
  }
}
