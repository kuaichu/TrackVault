import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AuthService } from "./application/auth/auth-service.js";
import { CatalogService } from "./application/catalog/catalog-service.js";
import { BackgroundJobManager } from "./application/jobs/background-job-manager.js";
import { MediaService } from "./application/media/media-service.js";
import { TransferService } from "./application/transfer/transfer-service.js";
import type { ServerConfig } from "./config/env.js";
import { isAppError } from "./domain/errors.js";
import { ProviderRegistry } from "./domain/ports/music-provider.js";
import { SqliteClient } from "./infrastructure/db/client.js";
import { CredentialRepository } from "./infrastructure/db/repositories/credential-repository.js";
import { JobRepository } from "./infrastructure/db/repositories/job-repository.js";
import { UserRepository } from "./infrastructure/db/repositories/user-repository.js";
import { UserStateRepository } from "./infrastructure/db/repositories/user-state-repository.js";
import { NeteaseAdapter } from "./infrastructure/providers/netease/netease-adapter.js";
import { QqMusicAdapter } from "./infrastructure/providers/qq/qq-adapter.js";
import { AesGcmCredentialVault, loadOrCreateMasterKey } from "./infrastructure/security/credential-vault.js";
import { SafeHttpClient } from "./infrastructure/security/safe-http-client.js";
import { SESSION_COOKIE_NAME } from "./interfaces/http/auth-plugin.js";
import { registerAuthRoutes } from "./interfaces/http/routes/auth-routes.js";
import { registerCatalogRoutes } from "./interfaces/http/routes/catalog-routes.js";
import { registerMediaRoutes } from "./interfaces/http/routes/media-routes.js";
import { registerTransferAndJobRoutes } from "./interfaces/http/routes/transfer-and-jobs-routes.js";
import { registerUserStateRoutes } from "./interfaces/http/routes/user-state-routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BuildAppOptions {
  config: ServerConfig;
  dbPathOverride?: string;
  providersOverride?: ProviderRegistry;
  httpClientOverride?: SafeHttpClient;
  disableRateLimit?: boolean;
  serveStaticWeb?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  sqlite: SqliteClient;
  jobs: BackgroundJobManager;
  close(): Promise<void>;
}

export async function buildServer(options: BuildAppOptions): Promise<BuiltServer> {
  const { config } = options;

  // 1) Infrastructure layer
  const sqlite = new SqliteClient(options.dbPathOverride ?? config.dbPath);
  const masterKey = loadOrCreateMasterKey(config.dataDir, config.masterKey);
  const vault = new AesGcmCredentialVault(masterKey);
  const httpClient =
    options.httpClientOverride ?? new SafeHttpClient({ defaultTimeoutMs: config.upstreamTimeoutMs });

  const userRepo = new UserRepository(sqlite);
  const credentialRepo = new CredentialRepository(sqlite, vault);
  const userStateRepo = new UserStateRepository(sqlite);
  const jobRepo = new JobRepository(sqlite);

  let providers: ProviderRegistry;
  if (options.providersOverride) {
    providers = options.providersOverride;
  } else {
    providers = new ProviderRegistry();
    providers.register(new NeteaseAdapter({ realIp: config.neteaseRealIp }));
    providers.register(new QqMusicAdapter(httpClient));
  }

  // 2) Application layer
  const jobs = new BackgroundJobManager({
    repo: jobRepo,
    tmpDownloadsDir: config.tmpDownloadsDir,
    globalMaxConcurrentDownloads: config.globalMaxConcurrentDownloads,
    globalMaxConcurrentJobs: config.globalMaxConcurrentJobs,
  });
  jobs.startPeriodicCleanup();

  const authService = new AuthService({
    users: userRepo,
    credentials: credentialRepo,
    providers,
    sessionTtlMs: config.sessionTtlMs,
  });
  const catalogService = new CatalogService({
    providers,
    credentials: credentialRepo,
    userState: userStateRepo,
  });
  const mediaService = new MediaService({
    providers,
    credentials: credentialRepo,
    userState: userStateRepo,
    http: httpClient,
    jobs,
    maxCoverBytes: config.maxCoverBytes,
    maxAudioBytes: config.maxDownloadAudioBytes,
  });
  const transferService = new TransferService({
    providers,
    credentials: credentialRepo,
    jobs,
  });

  // 3) Interface layer (Fastify 5)
  const app = Fastify({
    logger: config.nodeEnv === "production" ? { level: "info" } : false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.music.126.net",
          "https://*.gtimg.cn",
          "https://*.qpic.cn",
        ],
        mediaSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });

  const allowedOriginSet = new Set(config.allowedOrigins);
  await app.register(fastifyCors, {
    credentials: true,
    origin: (origin, callback) => {
      // Allow same-origin / server-to-server / curl requests with no Origin header
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOriginSet.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  if (!options.disableRateLimit) {
    await app.register(fastifyRateLimit, {
      max: 240,
      timeWindow: "1 minute",
      errorResponseBuilder: () => ({
        error: {
          code: "RATE_LIMITED",
          message: "请求过于频繁，请稍后再试。",
        },
      }),
    });
  }

  // Attach verified ActorContext from HttpOnly session cookie on every request
  app.decorateRequest("actor", null);
  app.addHook("preHandler", async (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    request.actor = authService.resolveActorFromToken(token);
  });

  // Unified structured error handler (catches all async throws cleanly)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: error.issues[0]?.message ?? "请求参数格式不正确。",
          details: { issues: error.issues },
        },
      });
    }

    if (isAppError(error)) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    const message =
      statusCode < 500 && error instanceof Error ? error.message : "服务端发生内部错误，请稍后重试。";

    return reply.code(statusCode).send({
      error: {
        code: statusCode === 429 ? "RATE_LIMITED" : "INTERNAL_ERROR",
        message,
      },
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    version: "2.0.0",
    timestamp: Date.now(),
  }));

  registerAuthRoutes(app, { authService, config });
  registerCatalogRoutes(app, { catalogService, providers });
  registerMediaRoutes(app, { mediaService });
  registerTransferAndJobRoutes(app, { jobs, transferService });
  registerUserStateRoutes(app, { userStateRepo });

  // Serve built frontend bundle when present (self-hosted single-container / production mode)
  const webDistDir = path.resolve(__dirname, "../../web/dist");
  if (options.serveStaticWeb !== false && fs.existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "接口不存在。" },
        });
      }
      return reply.sendFile("index.html");
    });
  }

  return {
    app,
    sqlite,
    jobs,
    async close() {
      jobs.stop();
      await app.close();
      sqlite.close();
    },
  };
}
