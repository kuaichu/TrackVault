import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3010),
  DATA_DIR: z.string().trim().min(1).default("data"),
  ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173,http://localhost:3010,http://127.0.0.1:3010"),
  TRACKVAULT_MASTER_KEY: z.string().trim().optional(),
  NETEASE_REAL_IP: z.string().trim().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  COOKIE_SECURE: z.enum(["true", "false", "auto"]).default("auto"),
  TRUST_PROXY: z.string().trim().default("false"),
  MAX_COVER_BYTES: z.coerce
    .number()
    .int()
    .min(65_536)
    .max(20 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  MAX_DOWNLOAD_AUDIO_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .max(512 * 1024 * 1024)
    .default(250 * 1024 * 1024),
  GLOBAL_MAX_CONCURRENT_DOWNLOADS: z.coerce.number().int().min(1).max(16).default(6),
  GLOBAL_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(16).default(4),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
});

export interface ServerConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  tmpDownloadsDir: string;
  allowedOrigins: string[];
  masterKey?: string;
  neteaseRealIp?: string;
  sessionTtlMs: number;
  cookieSecure: "true" | "false" | "auto";
  trustProxy: boolean | number;
  maxCoverBytes: number;
  maxDownloadAudioBytes: number;
  globalMaxConcurrentDownloads: number;
  globalMaxConcurrentJobs: number;
  upstreamTimeoutMs: number;
}

function parseTrustProxy(raw: string): boolean | number {
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized === "false" || normalized === "0") return false;
  if (normalized === "true") return true;
  if (/^\d+$/.test(normalized)) {
    const hops = Number(normalized);
    if (Number.isSafeInteger(hops) && hops > 0) return hops;
  }
  return false;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = EnvSchema.parse(env);
  const dataDir = path.resolve(process.cwd(), parsed.DATA_DIR);
  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    dbPath: path.join(dataDir, "trackvault-v2.db"),
    tmpDownloadsDir: path.join(dataDir, "tmp-downloads"),
    allowedOrigins,
    masterKey: parsed.TRACKVAULT_MASTER_KEY || undefined,
    neteaseRealIp: parsed.NETEASE_REAL_IP || undefined,
    sessionTtlMs: parsed.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    cookieSecure: parsed.COOKIE_SECURE,
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
    maxCoverBytes: parsed.MAX_COVER_BYTES,
    maxDownloadAudioBytes: parsed.MAX_DOWNLOAD_AUDIO_BYTES,
    globalMaxConcurrentDownloads: parsed.GLOBAL_MAX_CONCURRENT_DOWNLOADS,
    globalMaxConcurrentJobs: parsed.GLOBAL_MAX_CONCURRENT_JOBS,
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
  };
}
