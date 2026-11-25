import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CompareStatusSchema,
  ExportFormatSchema,
  JobKindSchema,
  StartCompareInputSchema,
  StartImportAuditInputSchema,
  StartTransferInputSchema,
  UpdateTransferSelectionInputSchema,
} from "#shared";
import {
  SessionEventHub,
  type SseConnectionRegistry,
} from "../../../application/events/session-event-hub.js";
import type { BackgroundJobManager } from "../../../application/jobs/background-job-manager.js";
import type { TransferService } from "../../../application/transfer/transfer-service.js";
import { AppError } from "../../../domain/errors.js";
import { hashSessionToken } from "../../../infrastructure/security/password.js";
import { SESSION_COOKIE_NAME, requireActor } from "../auth-plugin.js";

function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerTransferAndJobRoutes(
  app: FastifyInstance,
  deps: {
    jobs: BackgroundJobManager;
    transferService: TransferService;
    sseRegistry?: SseConnectionRegistry;
    isAllowedOrigin: (origin: string, request: FastifyRequest) => boolean;
  },
): SseConnectionRegistry {
  const { jobs, transferService, isAllowedOrigin } = deps;
  const sseRegistry = deps.sseRegistry ?? new SessionEventHub();

  // --- Unified Owner-Scoped Background Jobs ---

  app.get("/api/jobs", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ kind: JobKindSchema.optional() }).parse(request.query);
    return jobs.listForActorWithRevision(actor, query.kind);
  });

  app.get("/api/jobs/:id", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { job: jobs.getOwnedJobView(actor, id) };
  });

  app.post("/api/jobs/:id/cancel", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { job: jobs.cancelOwnedJob(actor, id) };
  });

  app.delete("/api/jobs/finished", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ kind: JobKindSchema.optional() }).parse(request.query);
    return jobs.clearFinishedWithRevision(actor, query.kind);
  });

  app.get("/api/jobs/:id/file", async (request, reply) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { fileHandle, downloadFilename, sizeBytes } = await jobs.openOwnedArtifactFile(actor, id);

    let readStream: ReturnType<typeof fileHandle.createReadStream>;
    try {
      readStream = fileHandle.createReadStream();
    } catch (error) {
      await fileHandle.close().catch(() => undefined);
      throw error;
    }

    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(sizeBytes))
      .header("Content-Disposition", buildContentDisposition(downloadFilename))
      .header("Cache-Control", "no-store")
      .send(readStream);
  });

  // --- Real-time SSE Job Stream (replaces 1.2s permanent polling) ---

  app.get("/api/events", async (request, reply) => {
    const actor = requireActor(request);
    const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
    if (origin && !isAllowedOrigin(origin, request)) {
      throw new AppError("FORBIDDEN", "不允许的跨域事件流来源。");
    }

    reply.hijack();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      Vary: "Origin",
      ...(origin
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
        : {}),
    });

    const writeEvent = (payload: unknown) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];
    const sessionTokenHash = request.sessionTokenHash ?? (rawToken ? hashSessionToken(rawToken) : null);

    let closed = false;
    let unregister = () => {};
    const unsubscribe = jobs.subscribe(actor.userId, writeEvent);
    const heartbeat = setInterval(() => {
      writeEvent({ type: "heartbeat", timestamp: Date.now() });
    }, 25_000);
    heartbeat.unref();

    const closeConnection = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      unregister();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    unregister = sseRegistry.register({
      userId: actor.userId,
      sessionTokenHash,
      close: closeConnection,
    });
    writeEvent({ type: "heartbeat", timestamp: Date.now() });
    request.raw.once("close", closeConnection);
  });

  // --- Playlist Transfer / Import Audit / Compare ---

  app.post(
    "/api/transfer/jobs",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = StartTransferInputSchema.parse(request.body);
      const job = transferService.startTransferJob(actor, input);
      return reply.code(202).send({ job });
    },
  );

  app.post(
    "/api/transfer/audit/jobs",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = StartImportAuditInputSchema.parse(request.body);
      const job = transferService.startImportAuditJob(actor, input);
      return reply.code(202).send({ job });
    },
  );

  app.post(
    "/api/transfer/compare/jobs",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const input = StartCompareInputSchema.parse(request.body);
      const job = transferService.startCompareJob(actor, input);
      return reply.code(202).send({ job });
    },
  );

  app.post("/api/transfer/jobs/:id/export", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        format: ExportFormatSchema.default("markdown"),
        statuses: z.array(CompareStatusSchema).optional(),
      })
      .parse(request.body ?? {});

    return transferService.exportJob(actor, id, body.format, body.statuses);
  });

  app.patch("/api/transfer/jobs/:id/selection", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const input = UpdateTransferSelectionInputSchema.parse(request.body);
    return { job: transferService.updateTransferTrackSelection(actor, id, input) };
  });

  app.post("/api/transfer/jobs/:id/import", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z
      .object({
        name: z.string().trim().max(200).optional(),
        existingPlaylistId: z.string().trim().max(128).optional(),
      })
      .parse(request.body ?? {});

    return transferService.importTransferResultToPlatform(actor, id, body);
  });

  return sseRegistry;
}
