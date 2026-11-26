import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { parseCookieEntries, serializeCookieMap } from "../common/cookie-parser.js";

const ESSENTIAL_QQ_COOKIE_KEYS = new Set([
  "uin",
  "qqmusic_uin",
  "wxuin",
  "o_cookie",
  "qm_keyst",
  "qqmusic_key",
  "p_skey",
  "skey",
  "psrf_qqopenid",
  "psrf_qqaccess_token",
  "psrf_qqrefresh_token",
  "psrf_qqrefresh_key",
  "psrf_qqunionid",
  "psrf_musickey_createtime",
  "euin",
  "login_type",
  "tmeLoginType",
]);

/**
 * Single canonical QQ cookie parser supporting "Cookie:" prefixes, ";" separators,
 * line breaks, Set-Cookie attribute filtering, and Base64 values containing "=".
 */
export function parseQqCookie(raw: string): Record<string, string> {
  const entries = parseCookieEntries(raw, { allowColonSeparator: true, stripQuotes: true });
  const map: Record<string, string> = {};
  for (const [key, value] of entries.entries()) {
    map[key] = value;
  }

  if (Number(map.login_type) === 2 && map.wxuin) {
    map.uin = map.wxuin;
  }
  const rawUin = map.uin || map.qqmusic_uin || map.o_cookie || map.wxuin || "";
  const numericUin = rawUin.replace(/\D/g, "");
  if (numericUin) {
    map.uin = numericUin;
  }

  return map;
}

export function extractEssentialQqCookie(raw: string): Record<string, string> {
  const parsed = parseQqCookie(raw);
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (ESSENTIAL_QQ_COOKIE_KEYS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

export function serializeQqCookie(cookieMap: Record<string, string>): string {
  return serializeCookieMap(cookieMap);
}

/**
 * Computes QQ Music CSRF token (g_tk / ptqrtoken) via DJB-style hash33.
 */
export function hash33(input: string, seed = 0): number {
  let hash = seed;
  for (let i = 0; i < input.length; i += 1) {
    hash += (hash << 5) + input.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

export function computeQqGtk(cookieMap: Record<string, string>): number {
  const key = cookieMap.qm_keyst || cookieMap.qqmusic_key || cookieMap.p_skey || cookieMap.skey || "";
  if (!key) return 5381;
  return hash33(key, 5381);
}

export function parseQqAuthCookie(auth: ProviderAuthContext): Record<string, string> | undefined {
  if (!auth.cookie?.trim()) return undefined;
  const parsed = parseQqCookie(auth.cookie);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function requireQqAuthCookie(auth: ProviderAuthContext): Record<string, string> {
  const parsed = parseQqAuthCookie(auth);
  if (!parsed?.uin || !(parsed.qm_keyst || parsed.qqmusic_key)) {
    throw new AppError("CREDENTIAL_REQUIRED", "请先绑定有效的 QQ 音乐账号凭证。");
  }
  return parsed;
}
