import fsPromises from "node:fs/promises";
import {
  formatLyricsAsLrc,
  hasValidAudioSignature,
  injectAudioFileMetadata,
  verifyDownloadedAudioFile,
} from "#audio-tags";
import {
  ALLOWED_COVER_HOST_SUFFIXES,
  type CreateDownloadJobInput,
  type JobView,
  type MusicPlatform,
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
import type { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";
import {
  AUDIO_STREAM_ALLOWED_SUFFIXES,
  assertSafeDirectDownloadUrl,
  isAcceptableAudioContentType,
  isBetterResolvedAudio,
} from "./audio-stream-policy.js";
import { writeStreamToFileWithLimit } from "./bounded-file-writer.js";

export {
  assertSafeDirectDownloadUrl,
  hasValidAudioSignature,
  isAcceptableAudioContentType,
  isBetterResolvedAudio,
  verifyDownloadedAudioFile,
};

export interface MediaUserSettingsReader {
  getSettings(userId: string): { maxConcurrentDownloads: number };
}

export class MediaService {
  readonly #providers: ProviderRegistry;
  readonly #authResolver: ProviderAuthResolver;
  readonly #userState: MediaUserSettingsReader;
  readonly #http: SafeHttpClient;
  readonly #jobs: BackgroundJobManager;
  readonly #maxCoverBytes: number;
  readonly #maxAudioBytes: number;

  constructor(deps: {
    providers: ProviderRegistry;
    authResolver: ProviderAuthResolver;
    userState: MediaUserSettingsReader;
    http: SafeHttpClient;
    jobs: BackgroundJobManager;
    maxCoverBytes: number;
    maxAudioBytes: number;
  }) {
    this.#providers = deps.providers;
    this.#authResolver = deps.authResolver;
    this.#userState = deps.userState;
    this.#http = deps.http;
    this.#jobs = deps.jobs;
    this.#maxCoverBytes = deps.maxCoverBytes;
    this.#maxAudioBytes = deps.maxAudioBytes;
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
    const plan = this.#authResolver.buildMediaCredentialPlan(actor, platform, signal);

    let primaryError: unknown = null;
    let primaryAttempt: { resolved: ResolvedAudio; auth: ProviderAuthContext } | null = null;

    if (plan.primary) {
      try {
        const resolved = await adapter.resolveAudio(target, level, mode, plan.primary);
        primaryAttempt = { resolved, auth: plan.primary };
        const acceptable =
          !primaryAttempt.resolved.trial && (mode === "playback" || !primaryAttempt.resolved.downgraded);
        if (acceptable || !plan.fallback) {
          return primaryAttempt;
        }
      } catch (error) {
        primaryError = error;
        if (!plan.fallback) throw error;
      }
    }

    if (plan.fallback) {
      try {
        const resolved = await adapter.resolveAudio(target, level, mode, plan.fallback);
        const fallbackAttempt = { resolved, auth: plan.fallback };
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
   * - `tagged_server` (default): bounded disk streaming -> signature validation -> streaming FLAC/MP3 tag & cover embedding.
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
            availableLevels: input.song.availableQualities.map((q) => q.level),
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
          const safeDirectUrl = assertSafeDirectDownloadUrl(resolved.url);
          return {
            subtitle: `${getQualityLabel(resolved.level, resolved.bitrate, resolved.format)} 直链已就绪`,
            artifactFilename: filename,
            directUrl: safeDirectUrl,
            metadata: {
              songId: input.song.id,
              platform: input.song.platform,
              level: resolved.level,
              bitrate: resolved.bitrate,
              format: resolved.format,
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
        await writeStreamToFileWithLimit({
          body: response.body,
          filePath,
          maxBytes: this.#maxAudioBytes,
          signal: handle.signal,
          onChunkWritten: (received) => {
            if (declaredLength > 0) {
              const pct = Math.min(84, Math.max(12, Math.round((received / declaredLength) * 72) + 12));
              handle.updateProgress(pct, `下载中 ${Math.round((received / 1024 / 1024) * 10) / 10} MB`);
            }
          },
        });

        // J01: Verify non-empty file & valid audio container signature (bounded ID3v2 offset-aware)
        const downloadedStat = await fsPromises.stat(filePath);
        const isValidAudio =
          downloadedStat.size > 0 && (await verifyDownloadedAudioFile(filePath, downloadedStat.size));
        if (!isValidAudio) {
          await fsPromises.unlink(filePath).catch(() => undefined);
          throw new AppError("UPSTREAM_ERROR", "下载内容校验失败，上游未返回有效的音频文件。");
        }

        // Embed cover & lyrics metadata for FLAC / MP3 files via bounded-memory header streaming
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

          if (handle.signal.aborted) {
            throw new AppError("INTERNAL_ERROR", "下载已取消。");
          }

          await injectAudioFileMetadata(filePath, {
            formatHint: ext,
            meta: {
              title: input.song.title,
              artist: input.song.artist,
              artists: input.song.artists,
              album: input.song.album,
              source: input.song.platform,
            },
            lyricsText,
            cover,
          });
        }

        const finalStat = await fsPromises.stat(filePath);
        return {
          subtitle: `${getQualityLabel(resolved.level, resolved.bitrate, resolved.format)} · ${(finalStat.size / 1024 / 1024).toFixed(1)} MB`,
          artifactFilename: filename,
          metadata: {
            songId: input.song.id,
            platform: input.song.platform,
            level: resolved.level,
            bitrate: resolved.bitrate,
            format: resolved.format,
            mode: input.mode,
            fileSizeBytes: finalStat.size,
            downgraded: resolved.downgraded,
          },
        };
      },
    });
  }
}
