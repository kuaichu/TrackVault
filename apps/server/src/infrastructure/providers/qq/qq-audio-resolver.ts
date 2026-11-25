import type { QualityLevel } from "#shared";
import { AppError } from "../../../domain/errors.js";
import { buildDownwardQualityOrder, isQualityDowngraded } from "../../../domain/policies/quality-policy.js";
import type {
  AudioResolveTarget,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import {
  type RawQqVkeyMidUrlInfo,
  type RawQqVkeyResponse,
  buildQqVkeyPayload,
  isQqAuthInvalidCode,
} from "./qq-cgi-endpoints.js";
import { parseQqAuthCookie } from "./qq-cookie.js";
import type { QqMusicHttpClient } from "./qq-http-client.js";

type QqFileSpec = { prefix: string; ext: string; bitrate: number; level: QualityLevel };

const QQ_QUALITY_SPECS: Record<"hires" | "flac" | "320" | "128" | "m4a", QqFileSpec> = {
  hires: { prefix: "RS01", ext: "flac", bitrate: 1_800_000, level: "hires" },
  flac: { prefix: "F000", ext: "flac", bitrate: 950_000, level: "lossless" },
  "320": { prefix: "M800", ext: "mp3", bitrate: 320_000, level: "exhigh" },
  "128": { prefix: "M500", ext: "mp3", bitrate: 128_000, level: "standard" },
  m4a: { prefix: "C400", ext: "m4a", bitrate: 96_000, level: "standard" },
};

function levelToQqSpecs(level: QualityLevel, availableLevels?: readonly QualityLevel[]): QqFileSpec[] {
  const ordered = buildDownwardQualityOrder(level, availableLevels);
  const specs: QqFileSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: QqFileSpec) => {
    if (!seen.has(spec.prefix)) {
      seen.add(spec.prefix);
      specs.push(spec);
    }
  };
  for (const item of ordered) {
    if (item === "hires" || item === "jymaster") {
      add(QQ_QUALITY_SPECS.hires);
      add(QQ_QUALITY_SPECS.flac);
    } else if (item === "lossless") {
      add(QQ_QUALITY_SPECS.flac);
    } else if (
      item === "exhigh" ||
      item === "jyeffect" ||
      item === "sky" ||
      item === "vivid" ||
      item === "dolby"
    ) {
      add(QQ_QUALITY_SPECS["320"]);
    } else {
      add(QQ_QUALITY_SPECS["128"]);
    }
  }
  add(QQ_QUALITY_SPECS["128"]);
  add(QQ_QUALITY_SPECS.m4a);
  return specs;
}

function inferQqTrialSpec(
  effectivePurl: string,
  fallbackSpec: QqFileSpec,
): { format: string; bitrate: number; level: QualityLevel } {
  const cleanPath = effectivePurl.split("?")[0] ?? effectivePurl;
  if (/(?:^|\/)(?:O4M0|C400)/i.test(cleanPath) || /\.m4a$/i.test(cleanPath)) {
    return { format: "m4a", bitrate: 96_000, level: "standard" };
  }
  if (/(?:^|\/)(?:RS02|M500|M800)/i.test(cleanPath) || /\.mp3$/i.test(cleanPath)) {
    return { format: "mp3", bitrate: 128_000, level: "standard" };
  }
  if (/\.ogg$/i.test(cleanPath)) {
    return { format: "ogg", bitrate: 128_000, level: "standard" };
  }
  if (/\.aac$/i.test(cleanPath)) {
    return { format: "aac", bitrate: 96_000, level: "standard" };
  }
  return fallbackSpec.ext === "m4a"
    ? { format: "m4a", bitrate: 96_000, level: "standard" }
    : { format: "mp3", bitrate: 128_000, level: "standard" };
}

export class QqAudioResolver {
  readonly #client: QqMusicHttpClient;

  constructor(client: QqMusicHttpClient) {
    this.#client = client;
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    _mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    const cookieMap = parseQqAuthCookie(auth);
    const songMid = target.id.trim();
    const mediaMid = (target.mediaId || songMid).trim();
    const specs = levelToQqSpecs(level, target.availableLevels);
    const guid = String(Math.floor(Math.random() * 10_000_000));

    let lastUpstreamError: AppError | null = null;
    let firstTrialFallback: ResolvedAudio | null = null;

    let specIndex = 0;
    while (specIndex < specs.length) {
      const remainingSpecs = specs.slice(specIndex);
      const filenames = remainingSpecs.map(
        (spec) => `${spec.prefix}${mediaMid}${spec.ext ? `.${spec.ext}` : ""}`,
      );

      let res: RawQqVkeyResponse;
      try {
        res = await this.#client.musicu<RawQqVkeyResponse>(
          buildQqVkeyPayload({
            filenames,
            guid,
            songMid,
            uin: cookieMap?.uin ?? "0",
          }),
          cookieMap,
          auth.signal,
        );
      } catch (error) {
        if (error instanceof AppError) {
          if (
            error.code === "CREDENTIAL_INVALID" ||
            error.code === "CREDENTIAL_REQUIRED" ||
            error.code === "UPSTREAM_TIMEOUT"
          ) {
            throw error;
          }
          lastUpstreamError = error;
        } else {
          lastUpstreamError = new AppError("UPSTREAM_ERROR", "QQ 音乐音源解析请求失败。", { cause: error });
        }
        break;
      }

      const topCode = res.code;
      const innerCode = res.req_0?.code;
      if (isQqAuthInvalidCode(topCode) || isQqAuthInvalidCode(innerCode)) {
        throw new AppError("CREDENTIAL_INVALID", "QQ 音乐登录态已失效，请重新绑定。");
      }
      if ((topCode !== undefined && topCode !== 0) || (innerCode !== undefined && innerCode !== 0)) {
        lastUpstreamError = new AppError(
          "UPSTREAM_ERROR",
          `QQ 音乐音源服务返回异常状态 (code ${innerCode || topCode})。`,
        );
        break;
      }

      const vkeyData = res.req_0?.data;
      if (!vkeyData || !Array.isArray(vkeyData.midurlinfo) || vkeyData.midurlinfo.length === 0) {
        lastUpstreamError = new AppError("UPSTREAM_ERROR", "QQ 音乐音源服务返回结构缺失。");
        break;
      }

      const sipList = vkeyData.sip ?? [];
      const sip = sipList.find((s) => s.startsWith("https://")) ?? sipList[0];
      const infoByFilename = new Map<string, RawQqVkeyMidUrlInfo>();
      for (const entry of vkeyData.midurlinfo) {
        if (entry?.filename) {
          infoByFilename.set(entry.filename, entry);
        }
      }

      const answeredCount = Math.min(remainingSpecs.length, vkeyData.midurlinfo.length);
      for (let i = 0; i < answeredCount; i += 1) {
        const spec = remainingSpecs[i];
        const expectedFilename = filenames[i];
        if (!spec || !expectedFilename) continue;
        const info = infoByFilename.get(expectedFilename) ?? vkeyData.midurlinfo[i];
        const rawPurl = info?.purl?.trim() ?? "";
        const rawTrialUrl = info?.opi30surl?.trim() ?? "";

        const effectivePurl = rawPurl || rawTrialUrl;
        if (!effectivePurl) continue;
        if (!sip) {
          lastUpstreamError = new AppError("UPSTREAM_ERROR", "QQ 音乐音源服务未返回流媒体节点地址。");
          continue;
        }

        const isTrialUrl =
          !rawPurl ||
          (Boolean(rawTrialUrl) && rawPurl === rawTrialUrl) ||
          /(?:^|\/)(?:O4M0|RS02)/i.test(effectivePurl) ||
          (info?.result !== undefined && info.result !== 0);

        const fullUrl = `${sip.replace(/^http:\/\//i, "https://")}${effectivePurl}`;

        if (isTrialUrl) {
          if (!firstTrialFallback) {
            const trialSpec = inferQqTrialSpec(effectivePurl, spec);
            firstTrialFallback = {
              url: fullUrl,
              format: trialSpec.format,
              bitrate: trialSpec.bitrate,
              level: trialSpec.level,
              durationSeconds: 30,
              trial: true,
              downgraded: level !== "standard",
            };
          }
          continue;
        }

        const downgraded = isQualityDowngraded(level, {
          bitrate: spec.bitrate,
          format: spec.ext,
          level: spec.level,
        });
        return {
          url: fullUrl,
          format: spec.ext,
          bitrate: spec.bitrate,
          level: spec.level,
          durationSeconds: target.durationSeconds ?? null,
          trial: false,
          downgraded,
        };
      }

      specIndex += Math.max(1, answeredCount);
    }

    if (firstTrialFallback) return firstTrialFallback;
    if (lastUpstreamError) throw lastUpstreamError;

    throw new AppError(
      "COPYRIGHT_UNAVAILABLE",
      "QQ 音乐未返回可用音频链接，请检查 QQ 音乐账号绑定、绿钻权限或该曲目版权状态。",
    );
  }
}
