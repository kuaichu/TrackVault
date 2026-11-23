import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AuthService } from "./application/auth/auth-service.js";
import { CatalogService } from "./application/catalog/catalog-service.js";
import { BackgroundJobManager } from "./application/jobs/background-job-manager.js";
import { MediaService } from "./application/media/media-service.js";
import { TransferService } from "./application/transfer/transfer-service.js";
import type { ServerConfig } from "./config/env.js";
import { AppError, isAppError } from "./domain/errors.js";
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
import {
  type SseConnectionRegistry,
  registerTransferAndJobRoutes,
} from "./interfaces/http/routes/transfer-and-jobs-routes.js";
import { registerUserStateRoutes } from "./interfaces/http/routes/user-state-routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATIC_ASSET_PATH_RE = /\.[a-z0-9]{1,8}(?:\?.*)?$/i;

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

  let sseRegistry: SseConnectionRegistry | null = null;

  const authService = new AuthService({
    sqlite,
    users: userRepo,
    credentials: credentialRepo,
    providers,
    sessionTtlMs: config.sessionTtlMs,
    onUserRevoked: (userId) => {
      jobs.cancelJobsForUser(userId);
      sseRegistry?.closeUserConnections(userId);
    },
    onUserDeleted: (userId) => {
      jobs.cancelJobsForUser(userId, { removeArtifactsDir: true });
      sseRegistry?.closeUserConnections(userId);
    },
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
  const trustProxyOption =
    typeof config.trustProxy === "number"
      ? (
          (maxHops: number) => (_address: string, hop: number) =>
            hop < maxHops
        )(config.trustProxy)
      : config.trustProxy;

  const app = Fastify({
    logger: config.nodeEnv === "production" ? { level: "info" } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: trustProxyOption,
  });

  const allowedOriginSet = new Set(config.allowedOrigins);
  const isAllowedOrigin = (origin: string, request: FastifyRequest): boolean => {
    if (allowedOriginSet.has(origin)) return true;
    const host = request.headers.host;
    if (!host) return false;
    return origin === `${request.protocol}://${host}`;
  };

  await app.register(fastifyCookie);

  // Attach verified ActorContext in onRequest (after fastifyCookie, BEFORE rate-limit keyGenerator)
  app.decorateRequest("actor", null);
  app.addHook("onRequest", async (request) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    request.actor = authService.resolveActorFromToken(token);
  });

  await app.register(fastifyHelmet, {
    crossOriginResourcePolicy: { policy: "cross-origin" },
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
          "https://*.y.qq.com",
          "https://y.qq.com",
          "https://*.qlogo.cn",
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
      allowList: (request) => !request.url.startsWith("/api/"),
      keyGenerator: (request) => (request.actor ? `user:${request.actor.userId}` : `ip:${request.ip}`),
      errorResponseBuilder: (_request, context) =>
        new AppError(
          context.statusCode === 403 ? "FORBIDDEN" : "RATE_LIMITED",
          "请求过于频繁，请稍后再试。",
          { statusCode: context.statusCode },
        ),
    });
  }

  // CSRF guard on mutating API routes (preserves non-browser/inject tests without Origin/Sec-Fetch-Site)
  app.addHook("preHandler", async (request) => {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    if (!request.url.startsWith("/api/")) return;

    const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : "";
    if (origin && !isAllowedOrigin(origin, request)) {
      throw new AppError("FORBIDDEN", "不允许的跨站写请求来源。");
    }

    const secFetchSite = request.headers["sec-fetch-site"];
    if (typeof secFetchSite === "string" && secFetchSite.trim().toLowerCase() === "cross-site") {
      throw new AppError("FORBIDDEN", "跨站写请求已被拦截。");
    }

    if (request.cookies?.[SESSION_COOKIE_NAME]) {
      const rawContentType = request.headers["content-type"];
      if (typeof rawContentType === "string") {
        const mime = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
        if (
          mime === "text/plain" ||
          mime === "application/x-www-form-urlencoded" ||
          mime === "multipart/form-data"
        ) {
          throw new AppError("FORBIDDEN", "不支持该内容类型的写请求。");
        }
      }
    }
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
  sseRegistry = registerTransferAndJobRoutes(app, { jobs, transferService, isAllowedOrigin });
  registerUserStateRoutes(app, { userStateRepo });

  // Serve built frontend bundle when present (self-hosted single-container / production mode)
  const webDistDir = path.resolve(__dirname, "../../web/dist");
  const hasStaticWeb = options.serveStaticWeb !== false && fs.existsSync(webDistDir);
  if (hasStaticWeb) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      wildcard: false,
    });
  }

  // Unconditional unified 404 handler (never serve index.html for /api, non-GET, or missing static assets)
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    const isApiPath = pathname === "/api" || pathname.startsWith("/api/");
    const method = request.method.toUpperCase();
    const isReadMethod = method === "GET" || method === "HEAD";

    if (isApiPath || !hasStaticWeb || !isReadMethod || STATIC_ASSET_PATH_RE.test(pathname)) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: isApiPath ? "接口不存在。" : "资源不存在。",
        },
      });
    }

    return reply.sendFile("index.html");
  });

  return {
    app,
    sqlite,
    jobs,
    async close() {
      sseRegistry?.closeAllConnections();
      jobs.stop();
      httpClient.close();
      await app.close();
      sqlite.close();
    },
  };
}
