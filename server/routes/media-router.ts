import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  addAudioMetadataToDownload,
  getAudioMetadataTarget,
  getHighResolutionCoverUrl
} from "../download-metadata.js";
import type { MediaMemoryLimitExceededError } from "../media-memory-policy.js";
import type {
  decideServerMediaHandling,
  getMaxInMemoryMediaBytes,
  getResponseContentLength,
  readResponseBytesWithLimit,
  withMediaTaggingSlot
} from "../media-memory-policy.js";
import type { MediaAccessError } from "../media-security.js";
import type { resolveQqSongStream } from "../qqmusic-provider.js";
import type { resolveDirectDownload, resolveSongStream } from "../task-store.js";
import type { DownloadQualityLevel, Song } from "../types.js";

const COVER_PROXY_MAX_BYTES = 5 * 1024 * 1024;

export type MediaRouterDependencies = {
  fetchImpl: typeof globalThis.fetch;
  getHighResolutionCoverUrl: typeof getHighResolutionCoverUrl;
  getAudioMetadataTarget: typeof getAudioMetadataTarget;
  addAudioMetadataToDownload: typeof addAudioMetadataToDownload;
  decideServerMediaHandling: typeof decideServerMediaHandling;
  getMaxInMemoryMediaBytes: typeof getMaxInMemoryMediaBytes;
  getResponseContentLength: typeof getResponseContentLength;
  readResponseBytesWithLimit: typeof readResponseBytesWithLimit;
  withMediaTaggingSlot: typeof withMediaTaggingSlot;
  resolveQqSongStream: typeof resolveQqSongStream;
  resolveSongStream: typeof resolveSongStream;
  resolveDirectDownload: typeof resolveDirectDownload;
  isMediaAccessError: (error: unknown) => error is MediaAccessError;
  isMediaMemoryLimitExceededError: (error: unknown) => error is MediaMemoryLimitExceededError;
};

function bindUpstreamAbort(request: express.Request, response: express.Response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("客户端已断开媒体传输"));
    }
  };
  const abortOnIncompleteClose = () => {
    if (!response.writableFinished) {
      abort();
    }
  };

  request.once("aborted", abort);
  response.once("close", abortOnIncompleteClose);

  return {
    controller,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abortOnIncompleteClose);
    }
  };
}

function toNodeReadable(body: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
}

function isAllowedCoverHost(hostname: string) {
  const normalizedHost = hostname.toLowerCase();
  return (
    normalizedHost === "music.126.net" ||
    normalizedHost.endsWith(".music.126.net") ||
    normalizedHost === "y.gtimg.cn" ||
    normalizedHost.endsWith(".y.gtimg.cn") ||
    normalizedHost === "qpic.y.qq.com" ||
    normalizedHost === "y.qq.com" ||
    normalizedHost === "thirdqq.qlogo.cn"
  );
}

function getAudioContentType(type: string | null | undefined) {
  const normalizedType = type?.replace(/^\./, "").toLowerCase();

  switch (normalizedType) {
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "aac":
      return "audio/aac";
    case "m4a":
      return "audio/mp4";
    case "mp3":
      return "audio/mpeg";
    default:
      return "";
  }
}

function buildContentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function getDownloadSongFromQuery(request: express.Request): Song {
  return {
    id: typeof request.query.id === "string" ? request.query.id : "",
    title: typeof request.query.title === "string" ? request.query.title : "",
    artist: typeof request.query.artist === "string" ? request.query.artist : "",
    album: typeof request.query.album === "string" ? request.query.album : "",
    mediaId: typeof request.query.mediaId === "string" ? request.query.mediaId : undefined,
    providerSongId: typeof request.query.providerSongId === "string" ? request.query.providerSongId : undefined,
    coverUrl: typeof request.query.coverUrl === "string" ? request.query.coverUrl : undefined,
    duration: typeof request.query.duration === "string" ? request.query.duration : "",
    quality: "",
    availableQualities: [],
    source: typeof request.query.source === "string" ? request.query.source : ""
  };
}

export function createMediaRouter(dependencies: MediaRouterDependencies) {
  const router = express.Router();

  router.get("/api/media/cover", async (request, response) => {
    const rawUrl = typeof request.query.url === "string" ? request.query.url : "";

    try {
      const coverUrl = new URL(dependencies.getHighResolutionCoverUrl(rawUrl));
      if ((coverUrl.protocol !== "https:" && coverUrl.protocol !== "http:") || !isAllowedCoverHost(coverUrl.hostname)) {
        response.status(400).json({ message: "封面地址不在允许的音乐图片域名内" });
        return;
      }

      const upstream = await dependencies.fetchImpl(coverUrl);
      if (!upstream.ok) {
        response.status(upstream.status || 502).json({ message: "封面拉取失败" });
        return;
      }

      const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.toLowerCase().startsWith("image/")) {
        response.status(415).json({ message: "封面地址没有返回图片内容" });
        return;
      }

      const bytes = await dependencies.readResponseBytesWithLimit(upstream, { limitBytes: COVER_PROXY_MAX_BYTES });

      response.setHeader("Content-Type", contentType);
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (error) {
      response.status(dependencies.isMediaMemoryLimitExceededError(error) ? 413 : 502).json({
        message: dependencies.isMediaMemoryLimitExceededError(error) ? "封面文件过大" : error instanceof Error ? error.message : "封面拉取失败"
      });
    }
  });

  router.get("/api/stream", async (request, response) => {
    const songId = typeof request.query.id === "string" ? request.query.id : "";
    const level = typeof request.query.level === "string" ? request.query.level : "standard";
    const source = typeof request.query.source === "string" ? request.query.source : "netease";
    const mediaId = typeof request.query.mediaId === "string" ? request.query.mediaId : undefined;
    const expectedDurationSeconds = Number(request.query.expectedDuration ?? 0);
    const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

    if (!songId) {
      response.status(400).json({ message: "缺少歌曲 id" });
      return;
    }

    const upstreamAbort = bindUpstreamAbort(request, response);
    try {
      const resolved =
        source === "qqmusic"
          ? await dependencies.resolveQqSongStream(
              {
                id: songId,
                title: "",
                artist: "",
                album: "",
                mediaId,
                duration: "",
                quality: "",
                availableQualities: [],
                source
              },
              level as DownloadQualityLevel
            )
          : await dependencies.resolveSongStream(
              songId,
              level as DownloadQualityLevel,
              userCookieOverride,
              Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : 0
            );
      const upstream = await dependencies.fetchImpl(resolved.url, {
        headers: request.headers.range ? { Range: request.headers.range } : undefined,
        signal: upstreamAbort.controller.signal
      });

      if (!upstream.ok || !upstream.body) {
        response.status(upstream.status || 502).json({ message: "音频流获取失败" });
        return;
      }

      const headersToForward = [
        "accept-ranges",
        "content-length",
        "content-range",
        "content-type"
      ] as const;

      for (const headerName of headersToForward) {
        const value = upstream.headers.get(headerName);
        if (value) {
          response.setHeader(headerName, value);
        }
      }

      const resolvedType = "type" in resolved && typeof resolved.type === "string" ? resolved.type : undefined;
      const resolvedContentType = getAudioContentType(resolvedType);
      if (resolvedContentType) {
        response.setHeader("content-type", resolvedContentType);
      }

      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      response.setHeader("Pragma", "no-cache");
      response.setHeader("Expires", "0");
      response.status(upstream.status);
      await pipeline(toNodeReadable(upstream.body), response);
    } catch (error) {
      if (response.destroyed || response.headersSent) {
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }
      const status = dependencies.isMediaAccessError(error) ? error.status : source === "qqmusic" ? 409 : 502;
      response.status(status).json({
        message: error instanceof Error ? error.message : "音频流获取失败"
      });
    } finally {
      upstreamAbort.cleanup();
    }
  });

  router.get("/api/download/direct", async (request, response) => {
    const song = getDownloadSongFromQuery(request);
    const level = typeof request.query.level === "string" ? request.query.level : "standard";
    const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

    if (!song.id || !song.title || !song.artist) {
      response.status(400).json({ message: "缺少歌曲信息" });
      return;
    }

    try {
      const metadata = request.query.metadata === "tagged" ? "tagged" : request.query.metadata === "raw" ? "raw" : undefined;
      const directDownload = metadata
        ? await dependencies.resolveDirectDownload(song, level as DownloadQualityLevel, userCookieOverride, { metadata })
        : await dependencies.resolveDirectDownload(song, level as DownloadQualityLevel, userCookieOverride);
      if (metadata === "tagged" && !dependencies.getAudioMetadataTarget(directDownload)) {
        response.status(415).json({
          code: "METADATA_FORMAT_UNSUPPORTED",
          message: "当前仅有 M4A 或其他不可写标签格式；请选择方案 C 的服务器裸下载。",
          format: directDownload.type || "unknown",
          fallbackModes: ["server-raw"]
        });
        return;
      }
      response.json({
        ...directDownload,
        maxInMemoryMediaBytes: dependencies.getMaxInMemoryMediaBytes()
      });
    } catch (error) {
      response.status(dependencies.isMediaAccessError(error) ? error.status : 502).json({
        message: error instanceof Error ? error.message : "获取直连下载地址失败"
      });
    }
  });

  router.get("/api/download/proxy", async (request, response) => {
    const song = getDownloadSongFromQuery(request);
    const level = typeof request.query.level === "string" ? request.query.level : "standard";
    const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;
    const metadataRequested = request.query.metadata !== "raw";

    if (!song.id || !song.title || !song.artist) {
      response.status(400).json({ message: "缺少歌曲信息" });
      return;
    }

    if (request.headers.range && metadataRequested) {
      response.status(409).json({
        code: "METADATA_RANGE_UNSUPPORTED",
        message: "标签下载不支持 Range 续传；如需原样续传，请显式使用服务器裸下载。",
        fallbackModes: ["server-raw"]
      });
      return;
    }

    const upstreamAbort = bindUpstreamAbort(request, response);
    try {
      const directDownload = await dependencies.resolveDirectDownload(
        song,
        level as DownloadQualityLevel,
        userCookieOverride,
        { metadata: metadataRequested ? "tagged" : "raw" }
      );
      const upstream = await dependencies.fetchImpl(directDownload.url, {
        headers: request.headers.range ? { Range: request.headers.range } : undefined,
        signal: upstreamAbort.controller.signal
      });

      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => undefined);
        response.status(upstream.status || 502).json({ message: "备用下载拉取失败" });
        return;
      }

      const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
      const contentLength = upstream.headers.get("content-length");
      const contentRange = upstream.headers.get("content-range");
      const maxInMemoryMediaBytes = dependencies.getMaxInMemoryMediaBytes();
      const metadataTarget = metadataRequested ? dependencies.getAudioMetadataTarget({
        filename: directDownload.filename,
        type: directDownload.type,
        contentType
      }) : null;
      if (metadataRequested && !metadataTarget) {
        upstreamAbort.controller.abort(new Error("当前音频格式不支持写入标签"));
        await upstream.body.cancel().catch(() => undefined);
        response.status(415).json({
          code: "METADATA_FORMAT_UNSUPPORTED",
          message: "当前仅有 M4A 或其他不可写标签格式；可改用服务器裸下载。",
          format: directDownload.type || "unknown",
          fallbackModes: ["server-raw"]
        });
        return;
      }
      const decision = dependencies.decideServerMediaHandling({
        metadataRequested,
        metadataTarget,
        contentLength: dependencies.getResponseContentLength(upstream),
        limitBytes: maxInMemoryMediaBytes
      });

      if (decision.kind === "reject") {
        upstreamAbort.controller.abort(decision.error);
        await upstream.body.cancel(decision.error).catch(() => undefined);
        throw decision.error;
      }

      if (decision.kind === "stream") {
        response.setHeader("Content-Disposition", buildContentDisposition(directDownload.filename));
        if (directDownload.quality) {
          response.setHeader("X-TrackVault-Quality", directDownload.quality);
        }
        response.setHeader("X-TrackVault-Max-In-Memory-Media-Bytes", String(maxInMemoryMediaBytes));
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Range, X-TrackVault-Quality, X-TrackVault-Max-In-Memory-Media-Bytes");
        response.setHeader("Content-Type", contentType);
        if (contentLength) {
          response.setHeader("Content-Length", contentLength);
        }
        if (contentRange) {
          response.setHeader("Content-Range", contentRange);
        }
        response.status(upstream.status);
        await pipeline(toNodeReadable(upstream.body), response);
        return;
      }

      await dependencies.withMediaTaggingSlot(async () => {
        const originalBytes = await dependencies.readResponseBytesWithLimit(upstream, {
          limitBytes: maxInMemoryMediaBytes,
          abortController: upstreamAbort.controller
        });
        let metadataResult = { lyricsFetched: false, coverFetched: false };
        const taggedBytes = await dependencies.addAudioMetadataToDownload({
          song,
          bytes: originalBytes,
          filename: directDownload.filename,
          type: directDownload.type,
          contentType,
          onMetadataResult: (result) => { metadataResult = result; }
        });
        response.setHeader("Content-Disposition", buildContentDisposition(directDownload.filename));
        if (directDownload.quality) {
          response.setHeader("X-TrackVault-Quality", directDownload.quality);
        }
        response.setHeader("X-TrackVault-Max-In-Memory-Media-Bytes", String(maxInMemoryMediaBytes));
        response.setHeader("X-TrackVault-Lyrics", metadataResult.lyricsFetched ? "fetched" : "missing");
        response.setHeader("X-TrackVault-Cover", metadataResult.coverFetched ? "fetched" : "missing");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-TrackVault-Quality, X-TrackVault-Max-In-Memory-Media-Bytes, X-TrackVault-Lyrics, X-TrackVault-Cover");
        response.setHeader("Content-Type", metadataTarget === "flac" ? "audio/flac" : "audio/mpeg");
        response.setHeader("Content-Length", String(taggedBytes.byteLength));
        response.status(upstream.status);

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            response.off("error", fail);
            response.off("close", onClose);
          };
          const succeed = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const onClose = () => {
            if (response.writableFinished) {
              succeed();
            } else {
              fail(new Error("客户端在标签文件发送完成前断开"));
            }
          };

          response.once("error", fail);
          response.once("close", onClose);
          response.end(Buffer.from(taggedBytes.buffer, taggedBytes.byteOffset, taggedBytes.byteLength), succeed);
        });
      });
    } catch (error) {
      if (response.destroyed || response.headersSent) {
        console.warn("Proxy download stream interrupted:", error instanceof Error ? error.message : error);
        if (!response.destroyed) {
          response.destroy(error instanceof Error ? error : undefined);
        }
        return;
      }

      if (dependencies.isMediaMemoryLimitExceededError(error)) {
        response.status(413).json(error.toJSON());
        return;
      }

      response.status(dependencies.isMediaAccessError(error) ? error.status : 502).json({
        message: error instanceof Error ? error.message : "备用下载失败"
      });
    } finally {
      upstreamAbort.cleanup();
    }
  });

  return router;
}
