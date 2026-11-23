import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateDownloadJobInputSchema, MusicPlatformSchema, QualityLevelSchema } from "#shared";
import type { MediaService } from "../../../application/media/media-service.js";
import { requireActor } from "../auth-plugin.js";

function mimeForAudioFormat(format: string): string {
  switch (format.replace(/^\./, "").toLowerCase()) {
    case "flac":
      return "audio/flac";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    default:
      return "audio/mpeg";
  }
}

export function registerMediaRoutes(app: FastifyInstance, deps: { mediaService: MediaService }): void {
  const { mediaService } = deps;

  app.get("/api/media/cover", async (request, reply) => {
    requireActor(request);
    const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(request.query);
    const { bytes, contentType } = await mediaService.fetchSafeCover(url);
    return reply
      .header("Content-Type", contentType)
      .header("Cache-Control", "private, max-age=86400")
      .send(Buffer.from(bytes));
  });

  app.get(
    "/api/media/stream",
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const query = z
        .object({
          platform: MusicPlatformSchema.default("netease"),
          id: z.string().min(1).max(128),
          mediaId: z.string().max(128).optional(),
          level: QualityLevelSchema.default("exhigh"),
          durationSeconds: z.coerce.number().nonnegative().optional(),
        })
        .parse(request.query);

      const abortController = new AbortController();
      request.raw.once("close", () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
      const { response, resolved } = await mediaService.openAudioStream(
        actor,
        query.platform,
        { id: query.id, mediaId: query.mediaId, durationSeconds: query.durationSeconds },
        query.level,
        range,
        abortController.signal,
      );

      const forwardHeaders = ["accept-ranges", "content-length", "content-range"] as const;
      for (const key of forwardHeaders) {
        const value = response.headers.get(key);
        if (value) reply.header(key, value);
      }

      reply
        .code(response.status)
        .header("Content-Type", mimeForAudioFormat(resolved.format))
        .header("Cache-Control", "no-store");

      if (!response.body) {
        return reply.send();
      }

      const nodeStream = Readable.fromWeb(response.body as never);
      nodeStream.on("error", () => {
        abortController.abort();
      });
      return reply.send(nodeStream);
    },
  );

  app.post("/api/media/probe", async (request) => {
    const actor = requireActor(request);
    const body = z
      .object({
        platform: MusicPlatformSchema,
        id: z.string().min(1).max(128),
        mediaId: z.string().max(128).optional(),
        durationSeconds: z.number().nonnegative().optional(),
        level: QualityLevelSchema.default("exhigh"),
        mode: z.enum(["playback", "download"]).default("playback"),
      })
      .parse(request.body);

    const probe = await mediaService.probeAudio(
      actor,
      body.platform,
      { id: body.id, mediaId: body.mediaId, durationSeconds: body.durationSeconds },
      body.level,
      body.mode,
    );
    return { probe };
  });

  app.post(
    "/api/downloads",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = CreateDownloadJobInputSchema.parse(request.body);
      const job = mediaService.enqueueDownload(actor, input);
      return reply.code(202).send({ job });
    },
  );
}
