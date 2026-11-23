import fs from "node:fs";
import fsPromises from "node:fs/promises";
import {
  formatLyricsAsLrc,
  injectFlacMetadata,
  injectMp3Metadata,
  isFlacBytes,
  isMp3Bytes,
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
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";
import type { SafeHttpClient } from "../../infrastructure/security/safe-http-client.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";

const AUDIO_STREAM_ALLOWED_SUFFIXES = [
  "music.126.net",
  "126.net",
  "163.com",
  "qqmusic.qq.com",
  "stream.qqmusic.qq.com",
  "dl.stream.qqmusic.qq.com",
  "aqqmusic.tc.qq.com",
  "ws.stream.qqmusic.qq.com",
  "qq.com",
] as const;

export class MediaService {
  readonly #providers: ProviderRegistry;
  readonly #credentials: CredentialRepository;
  readonly #userState: UserStateRepository;
  readonly #http: SafeHttpClient;
  readonly #jobs: BackgroundJobManager;
  readonly #maxCoverBytes: number;
  readonly #maxAudioBytes: number;

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

  async resolveAudioWithFallback(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
  ): Promise<ResolvedAudio> {
    const adapter = this.#providers.get(platform);
    const plan = this.#buildCredentialPlan(actor, platform);

    const tryWithCookie = async (cookie: string): Promise<ResolvedAudio> => {
      const auth: ProviderAuthContext = { platform, cookie, scopeKey: actor.userId };
      return adapter.resolveAudio(target, level, mode, auth);
    };

    let primaryError: unknown = null;
    let primaryResult: ResolvedAudio | null = null;

    if (plan.primaryCookie) {
      try {
        primaryResult = await tryWithCookie(plan.primaryCookie);
        const acceptable = !primaryResult.trial && (mode === "playback" || !primaryResult.downgraded);
        if (acceptable || !plan.fallbackCookie) {
          return primaryResult;
        }
      } catch (error) {
        primaryError = error;
        if (!plan.fallbackCookie) throw error;
      }
    }

    if (plan.fallbackCookie) {
      try {
        return await tryWithCookie(plan.fallbackCookie);
      } catch (error) {
        if (primaryResult) return primaryResult;
        throw error instanceof Error ? error : primaryError;
      }
    }

    throw primaryError ?? new AppError("CREDENTIAL_REQUIRED", "没有可用的媒体访问凭证。");
  }

  async openAudioStream(
    actor: ActorContext,
    platform: MusicPlatform,
    target: AudioResolveTarget,
    level: QualityLevel,
    rangeHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<{ response: Response; resolved: ResolvedAudio }> {
    const resolved = await this.resolveAudioWithFallback(actor, platform, target, level, "playback");
    if (resolved.trial) {
      throw new AppError("TRIAL_ONLY", "当前仅返回试听片段，需要对应平台会员权限或更换音质。");
    }

    const { response } = await this.#http.fetchResponse(resolved.url, {
      headers: rangeHeader ? { Range: rangeHeader } : undefined,
      allowedHostSuffixes: AUDIO_STREAM_ALLOWED_SUFFIXES,
      allowHttp: true,
      maxRedirects: 3,
      timeoutMs: 30_000,
      signal,
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("UPSTREAM_ERROR", `上游音频流获取失败 (HTTP ${response.status})`);
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
    const mins = resolved.durationSeconds ? Math.floor(resolved.durationSeconds / 60) : 0;
    const secs = resolved.durationSeconds ? resolved.durationSeconds % 60 : 0;

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
      actualDuration: resolved.durationSeconds
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
   * - `tagged_server` (default): bounded disk streaming -> safe FLAC/MP3 tag & cover embedding -> ready for download.
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
        const resolved = await this.resolveAudioWithFallback(
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
        );

        if (resolved.trial) {
          throw new AppError("TRIAL_ONLY", "目标仅提供试听片段，已中止下载。");
        }

        const ext = resolved.format || "mp3";
        const filename = `${baseName}.${ext}`;

        if (input.mode === "direct_link") {
          return {
            subtitle: `${getQualityLabel(resolved.level)} 直链已就绪`,
            artifactFilename: filename,
            directUrl: resolved.url,
            metadata: {
              songId: input.song.id,
              platform: input.song.platform,
              level: resolved.level,
              mode: input.mode,
              downgraded: resolved.downgraded,
            },
          };
        }

        handle.updateProgress(12, "拉取音频流...");
        const { response } = await this.#http.fetchResponse(resolved.url, {
          allowedHostSuffixes: AUDIO_STREAM_ALLOWED_SUFFIXES,
          allowHttp: true,
          maxRedirects: 3,
          timeoutMs: 120_000,
          signal: handle.signal,
        });

        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          throw new AppError("UPSTREAM_ERROR", `下载音频流失败 (HTTP ${response.status})`);
        }

        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > this.#maxAudioBytes) {
          await response.body.cancel().catch(() => undefined);
          throw new AppError("PAYLOAD_TOO_LARGE", "音频文件超过服务端安全体积上限。");
        }

        const { filePath } = await handle.getArtifactPath(ext);
        const writeStream = fs.createWriteStream(filePath);
        const reader = response.body.getReader();
        let received = 0;

        try {
          while (true) {
            if (handle.signal.aborted) {
              await reader.cancel();
              throw new AppError("INTERNAL_ERROR", "下载已取消。");
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            received += value.byteLength;
            if (received > this.#maxAudioBytes) {
              await reader.cancel();
              throw new AppError("PAYLOAD_TOO_LARGE", "音频流实际大小超过服务端上限。");
            }

            if (!writeStream.write(value)) {
              await new Promise<void>((resolve, reject) => {
                writeStream.once("drain", resolve);
                writeStream.once("error", reject);
              });
            }

            if (declaredLength > 0) {
              const pct = Math.min(84, Math.max(12, Math.round((received / declaredLength) * 72) + 12));
              handle.updateProgress(pct, `下载中 ${Math.round((received / 1024 / 1024) * 10) / 10} MB`);
            }
          }

          await new Promise<void>((resolve, reject) => {
            writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
          });
        } catch (error) {
          writeStream.destroy();
          await fsPromises.unlink(filePath).catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }

        // Embed cover & lyrics metadata for FLAC / MP3 files safely
        if (ext === "flac" || ext === "mp3") {
          handle.updateProgress(88, "写入歌曲封面与歌词标签...");
          const auth: ProviderAuthContext = {
            platform: input.song.platform,
            cookie: this.#credentials.getDecryptedCookie(actor.userId, input.song.platform),
            scopeKey: actor.userId,
          };

          const [coverResult, lyricsResult] = await Promise.allSettled([
            input.song.coverUrl ? this.fetchSafeCover(input.song.coverUrl) : Promise.resolve(null),
            this.#providers.get(input.song.platform).getLyrics(input.song.id, input.song.mediaId, auth),
          ]);

          const cover =
            coverResult.status === "fulfilled" && coverResult.value
              ? { mimeType: coverResult.value.contentType, bytes: coverResult.value.bytes }
              : null;
          const lyricsText =
            lyricsResult.status === "fulfilled" ? formatLyricsAsLrc(lyricsResult.value.lines) : "";

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
        }

        const finalStat = await fsPromises.stat(filePath);
        return {
          subtitle: `${getQualityLabel(resolved.level)} · ${(finalStat.size / 1024 / 1024).toFixed(1)} MB`,
          artifactFilename: filename,
          metadata: {
            songId: input.song.id,
            platform: input.song.platform,
            level: resolved.level,
            mode: input.mode,
            fileSizeBytes: finalStat.size,
            downgraded: resolved.downgraded,
          },
        };
      },
    });
  }
}
