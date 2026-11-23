const ESSENTIAL_QQ_COOKIE_KEYS = new Set([
  "uin",
  "wxuin",
  "o_cookie",
  "qm_keyst",
  "qqmusic_key",
  "p_skey",
  "skey",
  "psrf_qqopenid",
  "psrf_qqaccess_token",
  "psrf_qqrefresh_token",
  "psrf_musickey_createtime",
  "euin",
  "login_type",
  "tmeLoginType",
]);

/**
 * Single canonical QQ cookie parser supporting ";" separators, line breaks, and Base64 values containing "=".
 */
export function parseQqCookie(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  const parts = raw
    .replace(/\r?\n+/g, "; ")
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const eqIndex = part.indexOf("=");
    const colonIndex = part.indexOf(":");
    const sep = eqIndex >= 0 ? eqIndex : colonIndex;
    if (sep <= 0) continue;

    const key = part
      .slice(0, sep)
      .trim()
      .replace(/^"+|"+$/g, "");
    const value = part
      .slice(sep + 1)
      .trim()
      .replace(/^"+|"+$/g, "");
    if (key && value) {
      map[key] = value;
    }
  }

  if (Number(map.login_type) === 2 && map.wxuin) {
    map.uin = map.wxuin;
  }
  const rawUin = map.uin || map.o_cookie || map.wxuin || "";
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
  return Object.entries(cookieMap)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

/**
 * Computes QQ Music CSRF token (g_tk / ptqrtoken) via DJB-style hash33.
 */
export function hash33(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash += (hash << 5) + input.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

export function computeQqGtk(cookieMap: Record<string, string>): number {
  const key = cookieMap.p_skey || cookieMap.skey || cookieMap.qm_keyst || "";
  if (!key) return 5381;
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash += (hash << 5) + key.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}
