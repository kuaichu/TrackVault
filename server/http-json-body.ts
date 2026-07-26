import express from "express";
import type { Application } from "express";

export const HTTP_JSON_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export const RELAXED_JSON_BODY_PATHS = [
  "/api/playlist-transfer/jobs",
  "/api/playlist-transfer/jobs/progress"
] as const;

export function registerHttpJsonBodyParsers(app: Application): void {
  app.post(
    [...RELAXED_JSON_BODY_PATHS],
    express.json({ limit: HTTP_JSON_BODY_LIMIT_BYTES, strict: false })
  );
  app.use(express.json({ limit: HTTP_JSON_BODY_LIMIT_BYTES }));
}
