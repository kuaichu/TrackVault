import net from "node:net";
import { QUALITY_RANK, parseSafeHttpUrl } from "#shared";
import { AppError } from "../../domain/errors.js";
import type { ResolvedAudio } from "../../domain/ports/music-provider.js";
import { matchesHostSuffixes } from "../../infrastructure/security/safe-http-client.js";

// B34: Tightened audio CDN host allowlist (excludes generic web/API domains like 163.com / qq.com)
export const AUDIO_STREAM_ALLOWED_SUFFIXES = [
  "music.126.net",
  "vod.126.net",
  "ymusic.126.net",
  "stream.qqmusic.qq.com",
  "dl.stream.qqmusic.qq.com",
  "ws.stream.qqmusic.qq.com",
  "aqqmusic.tc.qq.com",
  "isure.stream.qqmusic.qq.com",
  "szmicxp.tc.qq.com",
  "shmicxp.tc.qq.com",
  "qqmusic.qq.com",
] as const;

export function assertSafeDirectDownloadUrl(rawUrl: string): string {
  const parsed = parseSafeHttpUrl(rawUrl);
  if (!parsed || parsed.protocol !== "https:") {
    throw new AppError("UPSTREAM_ERROR", "直链地址仅允许安全的 HTTPS 音频域名，已中止下载。");
  }
  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    net.isIP(hostname) !== 0
  ) {
    throw new AppError("UPSTREAM_ERROR", "直链地址包含受限主机或裸 IP，已中止下载。");
  }
  if (!matchesHostSuffixes(hostname, AUDIO_STREAM_ALLOWED_SUFFIXES)) {
    throw new AppError("UPSTREAM_ERROR", `直链地址域名不在允许的音频 CDN 白名单内：${hostname}`);
  }
  return parsed.toString();
}

export function isAcceptableAudioContentType(rawContentType: string | null | undefined): boolean {
  if (!rawContentType) return true;
  const mime = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime) return true;
  if (
    mime.startsWith("text/") ||
    mime.startsWith("image/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript"
  ) {
    return false;
  }
  return (
    mime.startsWith("audio/") ||
    mime === "application/octet-stream" ||
    mime === "binary/octet-stream" ||
    mime === "video/mp4" ||
    mime === "application/mp4" ||
    mime === "application/ogg" ||
    mime === "application/x-flac"
  );
}

/**
 * J02: Deterministic comparator ensuring full non-trial audio ALWAYS outranks trial previews.
 */
export function isBetterResolvedAudio(candidate: ResolvedAudio, current: ResolvedAudio): boolean {
  if (candidate.trial !== current.trial) {
    return !candidate.trial;
  }
  if (candidate.downgraded !== current.downgraded) {
    return !candidate.downgraded;
  }
  const candidateRank = QUALITY_RANK[candidate.level] ?? 0;
  const currentRank = QUALITY_RANK[current.level] ?? 0;
  if (candidateRank !== currentRank) {
    return candidateRank > currentRank;
  }
  const candidateBr = candidate.bitrate ?? 0;
  const currentBr = current.bitrate ?? 0;
  return candidateBr > currentBr;
}
