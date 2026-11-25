import crypto from "node:crypto";
import { parseCookieEntries, serializeCookieMap } from "../common/cookie-parser.js";

/**
 * Strips leading "Cookie:" header prefixes, line breaks, and Set-Cookie metadata attributes
 * and ensures a consistent mobile client identity so NeteaseCloudMusicApi eapi requests
 * do not mismatch os=pc with iPhone UA (-460).
 */
export function normalizeNeteaseCookie(rawCookie: string, options?: { ensureClientOs?: boolean }): string {
  const entries = parseCookieEntries(rawCookie);

  if (options?.ensureClientOs !== false && entries.size > 0) {
    const currentOs = entries.get("os")?.toLowerCase();
    if (!currentOs || currentOs === "pc") {
      entries.set("os", "android");
    }
  }

  return serializeCookieMap(entries);
}

export function buildNeteaseCookieCacheKey(cookie: string): string {
  const normalized = normalizeNeteaseCookie(cookie);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `uid:${digest}`;
}
