import fs from "node:fs";
import fsPromises from "node:fs/promises";
import {
  formatLyricsAsLrc,
  getAllId3v2TagsLength,
  getMpegFrameByteLength,
  injectFlacMetadata,
  injectMp3Metadata,
  isFlacBytes,
  isMp3Bytes,
  isMpegAudioFrameSync,
  parseId3v2HeaderLength,
  readUint32BigEndian,
} from "#audio-tags";
import {
  ALLOWED_COVER_HOST_SUFFIXES,
  type CreateDownloadJobInput,
  type JobView,
  type MusicPlatform,
  QUALITY_RANK,
  type QualityLevel,
  type SongAudioProbe,
  getQualityLabel,
  normalizeCoverUrl,
  sanitizeDownloadFilename,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type {
  AudioResolveTarget,
  ProviderAuthContext,
  ProviderRegistry,
  ResolvedAudio,
} from "../../domain/ports/music-provider.js";
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";
import type { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";

// B34: Tightened audio CDN host allowlist (excludes generic web/API domains like 163.com / qq.com)
const AUDIO_STREAM_ALLOWED_SUFFIXES = [
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

class AsyncSemaphore {
  #active = 0;
  readonly #max: number;
  readonly #waiters: Array<() => void> = [];

  constructor(max: number) {
    this.#max = Math.max(1, max);
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
      });
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      const next = this.#waiters.shift();
      if (next) next();
    }
  }
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

function isAacAdtsSync(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4) return false;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  // 12-bit syncword 0xFFF, layer == 00, sample frequency index != 0x0F (forbidden)
  return b0 === 0xff && (b1 & 0xf6) === 0xf0 && ((b2 >>> 2) & 0x0f) !== 0x0f;
}

/**
 * J01: Magic-byte signature verification covering MP3, FLAC, M4A/MP4 (ftyp at offset 4), WAV, OGG, and AAC ADTS.
 */
export function hasValidAudioSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (isMp3Bytes(bytes) || isFlacBytes(bytes)) return true;

  // M4A / MP4 ISO Base Media File Format ("ftyp" at offset 4) — protects QQ C400 streams
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return true;
  }

  // WAV ("RIFF" ... "WAVE")
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return true;
  }

  // OGG ("OggS")
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return true;
  }

  // AAC ADTS (optional leading ID3v2 + zero padding followed by 0xFFF sync + layer == 00)
  let pos = getAllId3v2TagsLength(bytes);
  const maxScan = Math.min(bytes.length - 4, pos + 4096);
  while (pos <= maxScan && bytes[pos] === 0x00) {
    pos += 1;
  }
  if (isAacAdtsSync(bytes, pos)) {
    return true;
  }

  return false;
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

async function waitForWriteDrain(
  writeStream: fs.WriteStream,
  signal: AbortSignal,
  getWriteError: () => Error | null,
): Promise<void> {
  const existingErr = getWriteError();
  if (existingErr) throw existingErr;
  if (signal.aborted) {
    throw new AppError("INTERNAL_ERROR", "下载已取消。");
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writeStream.off("drain", onDrain);
      writeStream.off("error", onError);
      writeStream.off("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new AppError("INTERNAL_ERROR", "下载已取消。"));
    };

    writeStream.once("drain", onDrain);
    writeStream.once("error", onError);
    writeStream.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function finishWriteStream(
  writeStream: fs.WriteStream,
  getWriteError: () => Error | null,
): Promise<void> {
  const existingErr = getWriteError();
  if (existingErr) throw existingErr;
  if (writeStream.writableFinished) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writeStream.off("finish", onFinish);
      writeStream.off("error", onError);
      writeStream.off("close", onClose);
    };
    const onFinish = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      const err = getWriteError();
      if (err) reject(err);
      else resolve();
    };

    writeStream.once("finish", onFinish);
    writeStream.once("error", onError);
    writeStream.once("close", onClose);
    writeStream.end();
  });
}

function isPlausiblePostMpegBoundary(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length) return true;
  if (isMpegAudioFrameSync(bytes, offset)) return true;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  // Allow zero padding, trailing ID3v1 ("TAG"), APEv2 ("APET"), Lyrics3 ("LYRI"), or stacked ID3v2 ("ID3")
  if (b0 === 0x00) return true;
  if (b0 === 0x54 && b1 === 0x41 && b2 === 0x47) return true;
  if (b0 === 0x41 && b1 === 0x50 && b2 === 0x45 && b3 === 0x54) return true;
  if (b0 === 0x4c && b1 === 0x59 && b2 === 0x52 && b3 === 0x49) return true;
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true;
  return false;
}

/**
 * J01: Bounded offset-aware audio file signature & first-frame / container header completeness check.
 * Skips up to 16 consecutive ID3v2 headers (requiring each declared length < remaining fileSize),
 * then reads at most 4,096 bytes at the actual audio stream offset and verifies that at least one complete
 * MPEG/ADTS frame or valid FLAC/M4A/WAV/OGG container header is present (rejecting truncated partial frames).
 */
export async function verifyDownloadedAudioFile(filePath: string, knownFileSize?: number): Promise<boolean> {
  const fileSize = knownFileSize ?? (await fsPromises.stat(filePath)).size;
  if (fileSize < 8) return false;

  const handle = await fsPromises.open(filePath, "r");
  try {
    let audioOffset = 0;
    const headerBuf = Buffer.alloc(10);
    for (let i = 0; i < 16; i += 1) {
      if (audioOffset + 10 >= fileSize) break;
      const { bytesRead } = await handle.read(headerBuf, 0, 10, audioOffset);
      if (bytesRead < 10) break;
      const tagLen = parseId3v2HeaderLength(headerBuf, 0, fileSize - audioOffset);
      if (tagLen <= 0) break;
      audioOffset += tagLen;
    }

    const remainingTotal = fileSize - audioOffset;
    const readLen = Math.min(4096, remainingTotal);
    if (readLen < 7) return false;

    const windowBuf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(windowBuf, 0, readLen, audioOffset);
    if (bytesRead < 7) return false;
    const windowBytes = new Uint8Array(windowBuf.buffer, windowBuf.byteOffset, bytesRead);

    // 1. FLAC: 4B "fLaC" + 4B metadata block header (type 0 STREAMINFO) + 34B STREAMINFO >= 42 bytes
    if (isFlacBytes(windowBytes)) {
      if (remainingTotal < 42 || windowBytes.length < 8) return false;
      const firstBlockType = (windowBytes[4] ?? 0x7f) & 0x7f;
      return firstBlockType === 0;
    }

    if (audioOffset === 0) {
      // 2. M4A / MP4: "ftyp" at offset 4, declared box length >= 8 and <= fileSize
      if (
        windowBytes.length >= 8 &&
        windowBytes[4] === 0x66 &&
        windowBytes[5] === 0x74 &&
        windowBytes[6] === 0x79 &&
        windowBytes[7] === 0x70
      ) {
        const ftypSize = readUint32BigEndian(windowBytes, 0);
        if (ftypSize === 1) {
          return windowBytes.length >= 16 && remainingTotal >= 16;
        }
        return ftypSize >= 8 && ftypSize <= remainingTotal;
      }

      // 3. WAV: "RIFF" ... "WAVE" + minimal fmt/data chunk headers >= 44 bytes
      if (
        windowBytes.length >= 12 &&
        windowBytes[0] === 0x52 &&
        windowBytes[1] === 0x49 &&
        windowBytes[2] === 0x46 &&
        windowBytes[3] === 0x46 &&
        windowBytes[8] === 0x57 &&
        windowBytes[9] === 0x41 &&
        windowBytes[10] === 0x56 &&
        windowBytes[11] === 0x45
      ) {
        return remainingTotal >= 44;
      }

      // 4. OGG: "OggS" 27-byte page header + segment table
      if (
        windowBytes[0] === 0x4f &&
        windowBytes[1] === 0x67 &&
        windowBytes[2] === 0x67 &&
        windowBytes[3] === 0x53
      ) {
        if (windowBytes.length < 27 || remainingTotal < 27) return false;
        const pageSegments = windowBytes[26] ?? 0;
        return remainingTotal >= 27 + pageSegments;
      }
    }

    // 5. MPEG audio (MP3) or AAC ADTS (after optional leading zero padding)
    let pos = 0;
    const maxScan = windowBytes.length - 4;
    while (pos <= maxScan && windowBytes[pos] === 0x00) {
      pos += 1;
    }

    const remainingFromFrame = fileSize - (audioOffset + pos);

    if (isMpegAudioFrameSync(windowBytes, pos)) {
      const frameByteLength = getMpegFrameByteLength(windowBytes, pos);
      if (frameByteLength === null) return false;
      const minRequiredBytes = frameByteLength > 0 ? frameByteLength : 24;
      if (remainingFromFrame < minRequiredBytes) {
        return false;
      }
      if (frameByteLength > 0 && remainingFromFrame - frameByteLength >= 4) {
        const nextOffsetInWindow = pos + frameByteLength;
        if (
          nextOffsetInWindow + 4 <= windowBytes.length &&
          !isPlausiblePostMpegBoundary(windowBytes, nextOffsetInWindow)
        ) {
          return false;
        }
      }
      return true;
    }

    if (isAacAdtsSync(windowBytes, pos)) {
      if (windowBytes.length < pos + 7) return false;
      const b3 = windowBytes[pos + 3] ?? 0;
      const b4 = windowBytes[pos + 4] ?? 0;
      const b5 = windowBytes[pos + 5] ?? 0;
      const aacFrameLength = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >>> 5) & 0x07);
      return aacFrameLength >= 7 && remainingFromFrame >= aacFrameLength;
    }

    return false;
  } finally {
    await handle.close();
  }
}

export class MediaService {
  readonly #providers: ProviderRegistry;
  readonly #credentials: CredentialRepository;
  readonly #userState: UserStateRepository;
  readonly #http: SafeHttpClient;
  readonly #jobs: BackgroundJobManager;
  readonly #maxCoverBytes: number;
  readonly #maxAudioBytes: number;
  // B33: Limit concurrent in-memory FLAC/MP3 tag rewrites to 2 to bound RAM spikes
  readonly #tagSemaphore = new AsyncSemaphore(2);

  constructor(deps: {
    providers: ProviderRegistry;
    credentials: CredentialRepository;
    userState: UserStateRepository;
    http: SafeHttpClient;
    jobs: BackgroundJobManager;
    maxCoverBytes: number;
    maxAudioBytes: number;
  }) {
    this.#providers = deps.providers;
    this.#credentials = deps.credentials;
    this.#userState = deps.userState;
    this.#http = deps.http;
    this.#jobs = deps.jobs;
    this.#maxCoverBytes = deps.maxCoverBytes;
    this.#maxAudioBytes = deps.maxAudioBytes;
  }

  #buildCredentialPlan(
    actor: ActorContext,
    platform: MusicPlatform,
  ): {
    primaryCookie: string | null;
    fallbackCookie: string | null;
  } {
    const primaryCookie = this.#credentials.getDecryptedCookie(actor.userId, platform);
    const fallbackCookie = actor.trustedFallback
      ? this.#credentials.getDecryptedSystemFallbackCookie(platform)
      : null;

    if (!primaryCookie && !fallbackCookie) {
      throw new AppError(
        "CREDENTIAL_REQUIRED",
        `请先在「账号绑定」中绑定你的 ${platform === "netease" ? "网易云音乐" : "QQ 音乐"} 账号后再播放或下载。`,
      );
    }

    return {
      primaryCookie,
      fallbackCookie: fallbackCookie && fallbackCookie !== primaryCookie ? fallbackCookie : null,
    };
  }

  async #resolveAudioWithFallbackContext(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    signal?: AbortSignal,
  ): Promise<{ resolved: ResolvedAudio; auth: ProviderAuthContext }> {
    const adapter = this.#providers.get(platform);
    const plan = this.#buildCredentialPlan(actor, platform);

    const tryWithCookie = async (
      cookie: string,
      isFallback: boolean,
    ): Promise<{ resolved: ResolvedAudio; auth: ProviderAuthContext }> => {
      // C017: Keep system fallback requests in an isolated "system-fallback" cache scope
      const auth: ProviderAuthContext = {
        platform,
        cookie,
        scopeKey: isFallback ? "system-fallback" : actor.userId,
        signal,
      };
      const resolved = await adapter.resolveAudio(target, level, mode, auth);
      return { resolved, auth };
    };

    let primaryError: unknown = null;
    let primaryAttempt: { resolved: ResolvedAudio; auth: ProviderAuthContext } | null = null;

    if (plan.primaryCookie) {
      try {
        primaryAttempt = await tryWithCookie(plan.primaryCookie, false);
        const acceptable =
          !primaryAttempt.resolved.trial && (mode === "playback" || !primaryAttempt.resolved.downgraded);
        if (acceptable || !plan.fallbackCookie) {
          return primaryAttempt;
        }
      } catch (error) {
        primaryError = error;
        if (!plan.fallbackCookie) throw error;
      }
    }

    if (plan.fallbackCookie) {
      try {
        const fallbackAttempt = await tryWithCookie(plan.fallbackCookie, true);
        if (!primaryAttempt) {
          return fallbackAttempt;
        }
        // J02: Only adopt fallback when it strictly outranks the user's primary result (full ALWAYS beats trial)
        return isBetterResolvedAudio(fallbackAttempt.resolved, primaryAttempt.resolved)
          ? fallbackAttempt
          : primaryAttempt;
      } catch (error) {
        if (primaryAttempt) return primaryAttempt;
        throw error instanceof Error ? error : primaryError;
      }
    }

    throw primaryError ?? new AppError("CREDENTIAL_REQUIRED", "没有可用的媒体访问凭证。");
  }

  async resolveAudioWithFallback(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    signal?: AbortSignal,
  ): Promise<ResolvedAudio> {
    const { resolved } = await this.#resolveAudioWithFallbackContext(
      actor,
      platform,
      target,
      level,
      mode,
      signal,
    );
    return resolved;
  }

  async openAudioStream(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    rangeHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<{ response: Response; resolved: ResolvedAudio }> {
    const resolved = await this.resolveAudioWithFallback(actor, platform, target, level, "playback", signal);
    if (resolved.trial) {
      throw new AppError("TRIAL_ONLY", "当前仅返回试听片段，需要对应平台会员权限或更换音质。");
    }

    const reqHeaders: Record<string, string> = { "Accept-Encoding": "identity" };
    if (rangeHeader) {
      reqHeaders.Range = rangeHeader;
    }

    // J03: Split connect/header timeout (15s) from active stream idle timeout (30s)
    const { response } = await this.#http.fetchResponse(resolved.url, {
      headers: reqHeaders,
      allowedHostSuffixes: AUDIO_STREAM_ALLOWED_SUFFIXES,
      allowHttp: true,
      maxRedirects: 3,
      timeoutMs: 15_000,
      idleTimeoutMs: 30_000,
      signal,
    });

    // C031: Pass through 416 Range Not Satisfiable directly to audio element instead of wrapping as 502
    if (response.status === 416) {
      await response.body?.cancel().catch(() => undefined);
      return { response, resolved };
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("UPSTREAM_ERROR", `上游音频流获取失败 (HTTP ${response.status})`);
    }

    // J01: Refuse non-media error pages masquerading as 200 OK audio streams
    const contentType = response.headers.get("content-type");
    if (!isAcceptableAudioContentType(contentType)) {
      await response.body.cancel().catch(() => undefined);
      throw new AppError("UPSTREAM_ERROR", `上游返回了非音频响应类型 (${contentType ?? "unknown"})。`);
    }

    return { response, resolved };
  }

  async probeAudio(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
  ): Promise<SongAudioProbe> {
    const resolved = await this.resolveAudioWithFallback(actor, platform, target, level, mode);
    const bitrateLabel = resolved.bitrate ? `${Math.round(resolved.bitrate / 1000)}K` : "";
    const actualLabel = [resolved.format.toUpperCase(), bitrateLabel].filter(Boolean).join(" ") || "未知";
    const roundedDuration =
      resolved.durationSeconds !== null && Number.isFinite(resolved.durationSeconds)
        ? Math.max(0, Math.round(resolved.durationSeconds))
        : null;
    const mins = roundedDuration !== null ? Math.floor(roundedDuration / 60) : 0;
    const secs = roundedDuration !== null ? roundedDuration % 60 : 0;

    return {
      songId: target.id,
      platform,
      mode,
      requestedLevel: level,
      requestedLabel: getQualityLabel(level),
      actualLabel,
      actualLevel: resolved.level,
      actualBitrate: resolved.bitrate,
      actualType: resolved.format.toUpperCase(),
      actualDuration:
        roundedDuration !== null && roundedDuration > 0
          ? `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
          : null,
      trial: resolved.trial,
      downgraded: resolved.downgraded,
    };
  }

  async fetchSafeCover(rawUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const normalized = normalizeCoverUrl(rawUrl, 600);
    if (!normalized) {
      throw new AppError("UNSAFE_URL", "非法的封面图片地址。");
    }

    const result = await this.#http.fetchBoundedBytes(normalized, {
      allowedHostSuffixes: ALLOWED_COVER_HOST_SUFFIXES,
      allowHttp: false,
      maxRedirects: 2,
      maxBytes: this.#maxCoverBytes,
      requireContentTypePrefix: "image/",
      timeoutMs: 10_000,
    });
    return { bytes: result.bytes, contentType: result.contentType };
  }

  /**
   * Unified download pipeline (replaces 5 conflicting download paths in v1).
   * Supports:
   * - `tagged_server` (default): bounded disk streaming -> signature validation -> safe FLAC/MP3 tag & cover embedding.
   * - `direct_link` (optional): resolves verified HTTPS URL for instant untagged browser download.
   */
  enqueueDownload(actor: ActorContext, input: CreateDownloadJobInput): JobView {
    const settings = this.#userState.getSettings(actor.userId);
    const baseName = sanitizeDownloadFilename(`${input.song.title} - ${input.song.artist}`);

    return this.#jobs.enqueue({
      actor,
      kind: "download",
      title: baseName,
      subtitle: `${getQualityLabel(input.level)} · 排队中`,
      maxUserConcurrency: settings.maxConcurrentDownloads,
      metadata: {
        songId: input.song.id,
        platform: input.song.platform,
        level: input.level,
        mode: input.mode,
        songTitle: input.song.title,
        artist: input.song.artist,
      },
      runner: async (handle) => {
        handle.updateProgress(5, "解析音源...");
        const { resolved, auth: resolvedAuth } = await this.#resolveAudioWithFallbackContext(
          actor,
          input.song.platform,
          {
            id: input.song.id,
            providerSongId: input.song.providerSongId,
            mediaId: input.song.mediaId,
            title: input.song.title,
            durationSeconds: input.song.durationSeconds,
          },
          input.level,
          "download",
          handle.signal,
        );

        if (resolved.trial) {
          throw new AppError("TRIAL_ONLY", "目标仅提供试听片段，已中止下载。");
        }

        const ext = (resolved.format || "mp3").replace(/^\./, "").toLowerCase();
        const filename = `${baseName}.${ext}`;

        if (input.mode === "direct_link") {
          return {
            subtitle: `${getQualityLabel(resolved.level, resolved.bitrate)} 直链已就绪`,
            artifactFilename: filename,
            directUrl: resolved.url,
            metadata: {
              songId: input.song.id,
              platform: input.song.platform,
              level: resolved.level,
              bitrate: resolved.bitrate,
              mode: input.mode,
              downgraded: resolved.downgraded,
            },
          };
        }

        handle.updateProgress(12, "拉取音频流...");
        // J03: Split connect/header timeout (20s) from active stream idle timeout (45s)
        const { response } = await this.#http.fetchResponse(resolved.url, {
          headers: { "Accept-Encoding": "identity" },
          allowedHostSuffixes: AUDIO_STREAM_ALLOWED_SUFFIXES,
          allowHttp: true,
          maxRedirects: 3,
          timeoutMs: 20_000,
          idleTimeoutMs: 45_000,
          signal: handle.signal,
        });

        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new AppError("UPSTREAM_ERROR", `下载音频流失败 (HTTP ${response.status})`);
        }

        // J01: Reject non-media responses (e.g. text/plain, text/html, application/json error payloads)
        const contentType = response.headers.get("content-type");
        if (!isAcceptableAudioContentType(contentType)) {
          await response.body.cancel().catch(() => undefined);
          throw new AppError(
            "UPSTREAM_ERROR",
            `上游返回了非音频内容类型 (${contentType ?? "unknown"})，已中止下载。`,
          );
        }

        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > this.#maxAudioBytes) {
          await response.body.cancel().catch(() => undefined);
          throw new AppError("PAYLOAD_TOO_LARGE", "音频文件超过服务端安全体积上限。");
        }

        const { filePath } = await handle.getArtifactPath(ext);
        const writeStream = fs.createWriteStream(filePath);
        // BUG-25: Attach permanent error listener immediately so async FS errors never crash Node
        let writeError: Error | null = null;
        writeStream.on("error", (err) => {
          writeError = err instanceof Error ? err : new Error(String(err));
        });

        const reader = response.body.getReader();
        let received = 0;

        try {
          while (true) {
            if (writeError) {
              await reader.cancel().catch(() => undefined);
              throw writeError;
            }
            if (handle.signal.aborted) {
              await reader.cancel().catch(() => undefined);
              throw new AppError("INTERNAL_ERROR", "下载已取消。");
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            received += value.byteLength;
            if (received > this.#maxAudioBytes) {
              await reader.cancel().catch(() => undefined);
              throw new AppError("PAYLOAD_TOO_LARGE", "音频流实际大小超过服务端上限。");
            }

            if (writeError) {
              await reader.cancel().catch(() => undefined);
              throw writeError;
            }

            // J07 + C018: Clean paired drain/error/abort listener handling with zero accumulation
            if (!writeStream.write(value)) {
              await waitForWriteDrain(writeStream, handle.signal, () => writeError);
            }

            if (declaredLength > 0) {
              const pct = Math.min(84, Math.max(12, Math.round((received / declaredLength) * 72) + 12));
              handle.updateProgress(pct, `下载中 ${Math.round((received / 1024 / 1024) * 10) / 10} MB`);
            }
          }

          await finishWriteStream(writeStream, () => writeError);
        } catch (error) {
          writeStream.destroy();
          await fsPromises.unlink(filePath).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }

        // J01: Verify non-empty file & valid audio container signature (bounded ID3v2 offset-aware)
        const downloadedStat = await fsPromises.stat(filePath);
        const isValidAudio =
          downloadedStat.size > 0 && (await verifyDownloadedAudioFile(filePath, downloadedStat.size));
        if (!isValidAudio) {
          await fsPromises.unlink(filePath).catch(() => undefined);
          throw new AppError("UPSTREAM_ERROR", "下载内容校验失败，上游未返回有效的音频文件。");
        }

        // Embed cover & lyrics metadata for FLAC / MP3 files safely
        if (ext === "flac" || ext === "mp3") {
          handle.updateProgress(88, "写入歌曲封面与歌词标签...");
          // B35: Reuse the credential context that resolved audio (including trusted fallback) for lyrics
          const lyricsAuth: ProviderAuthContext = {
            platform: input.song.platform,
            cookie: resolvedAuth.cookie,
            scopeKey: resolvedAuth.scopeKey,
            signal: handle.signal,
          };

          const [coverResult, lyricsResult] = await Promise.allSettled([
            input.song.coverUrl ? this.fetchSafeCover(input.song.coverUrl) : Promise.resolve(null),
            this.#providers.get(input.song.platform).getLyrics(input.song.id, input.song.mediaId, lyricsAuth),
          ]);

          const cover =
            coverResult.status === "fulfilled" && coverResult.value
              ? { mimeType: coverResult.value.contentType, bytes: coverResult.value.bytes }
              : null;
          const lyricsText =
            lyricsResult.status === "fulfilled" ? formatLyricsAsLrc(lyricsResult.value.lines) : "";

          // B33: Concurrency-bounded in-memory tag rewrite
          await this.#tagSemaphore.run(async () => {
            if (handle.signal.aborted) {
              throw new AppError("INTERNAL_ERROR", "下载已取消。");
            }
            const rawBytes = new Uint8Array(await fsPromises.readFile(filePath));
            const meta = {
              title: input.song.title,
              artist: input.song.artist,
              artists: input.song.artists,
              album: input.song.album,
              source: input.song.platform,
            };

            let tagged: Uint8Array = rawBytes;
            if (ext === "flac" && isFlacBytes(rawBytes)) {
              tagged = injectFlacMetadata(rawBytes, meta, lyricsText, cover);
            } else if (ext === "mp3" && isMp3Bytes(rawBytes)) {
              tagged = injectMp3Metadata(rawBytes, meta, lyricsText, cover);
            }

            if (tagged !== rawBytes) {
              await fsPromises.writeFile(filePath, tagged);
            }
          });
        }

        const finalStat = await fsPromises.stat(filePath);
        return {
          subtitle: `${getQualityLabel(resolved.level, resolved.bitrate)} · ${(finalStat.size / 1024 / 1024).toFixed(1)} MB`,
          artifactFilename: filename,
          metadata: {
            songId: input.song.id,
            platform: input.song.platform,
            level: resolved.level,
            bitrate: resolved.bitrate,
            mode: input.mode,
            fileSizeBytes: finalStat.size,
            downgraded: resolved.downgraded,
          },
        };
      },
    });
  }
}
