import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CompareStatusSchema,
  ExportFormatSchema,
  JobKindSchema,
  StartCompareInputSchema,
  StartImportAuditInputSchema,
  StartTransferInputSchema,
} from "#shared";
import type { BackgroundJobManager } from "../../../application/jobs/background-job-manager.js";
import type { TransferService } from "../../../application/transfer/transfer-service.js";
import { AppError } from "../../../domain/errors.js";
import { toJobView } from "../../../infrastructure/db/repositories/job-repository.js";
import { requireActor } from "../auth-plugin.js";

const MAX_SSE_CONNECTIONS_PER_USER = 8;

export interface SseConnectionRegistry {
  closeUserConnections(userId: string): void;
  closeAllConnections(): void;
}

function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerTransferAndJobRoutes(
  app: FastifyInstance,
  deps: {
    jobs: BackgroundJobManager;
    transferService: TransferService;
    isAllowedOrigin: (origin: string, request: FastifyRequest) => boolean;
  },
): SseConnectionRegistry {
  const { jobs, transferService, isAllowedOrigin } = deps;
  const activeSseByUser = new Map<string, Set<() => void>>();

  const closeUserConnections = (userId: string) => {
    const set = activeSseByUser.get(userId);
    if (!set) return;
    for (const closeFn of [...set]) {
      closeFn();
    }
    activeSseByUser.delete(userId);
  };

  const closeAllConnections = () => {
    for (const userId of [...activeSseByUser.keys()]) {
      closeUserConnections(userId);
    }
  };

  // --- Unified Owner-Scoped Background Jobs ---

  app.get("/api/jobs", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ kind: JobKindSchema.optional() }).parse(request.query);
    return { jobs: jobs.listForActor(actor, query.kind) };
  });

  app.get("/api/jobs/:id", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { job: toJobView(jobs.getOwnedJob(actor, id)) };
  });

  app.post("/api/jobs/:id/cancel", async (request) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return { job: jobs.cancelOwnedJob(actor, id) };
  });

  app.delete("/api/jobs/finished", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ kind: JobKindSchema.optional() }).parse(request.query);
    return { removedCount: jobs.clearFinished(actor, query.kind) };
  });

  app.get("/api/jobs/:id/file", async (request, reply) => {
    const actor = requireActor(request);
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { filePath, downloadFilename } = await jobs.resolveOwnedArtifactFile(actor, id);
    const stat = await fs.promises.stat(filePath);

    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", String(stat.size))
      .header("Content-Disposition", buildContentDisposition(downloadFilename))
      .header("Cache-Control", "no-store")
      .send(fs.createReadStream(filePath));
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

    const userConns = activeSseByUser.get(actor.userId) ?? new Set<() => void>();
    activeSseByUser.set(actor.userId, userConns);
    while (userConns.size >= MAX_SSE_CONNECTIONS_PER_USER) {
      const oldestClose = userConns.values().next().value;
      if (!oldestClose) break;
      oldestClose();
    }

    let closed = false;
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
      userConns.delete(closeConnection);
      if (userConns.size === 0) {
        activeSseByUser.delete(actor.userId);
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    userConns.add(closeConnection);
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

  return {
    closeUserConnections,
    closeAllConnections,
  };
}
