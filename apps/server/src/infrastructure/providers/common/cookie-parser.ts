export const SET_COOKIE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "max-age",
  "expires",
  "path",
  "domain",
  "httponly",
  "secure",
  "samesite",
  "priority",
]);

export interface ParseCookieOptions {
  readonly allowColonSeparator?: boolean;
  readonly stripQuotes?: boolean;
}

/**
 * Safely parses raw Cookie or Set-Cookie header strings into key-value pairs:
 * - Strips leading "Cookie:" prefixes and line breaks
 * - Filters out Set-Cookie metadata attributes (Path, Domain, Expires, Max-Age, Secure, HttpOnly, SameSite, Priority)
 * - Preserves "=" characters inside values (e.g. Base64 padding)
 */
export function parseCookieEntries(raw: string, options?: ParseCookieOptions): Map<string, string> {
  const entries = new Map<string, string>();
  const cleanedRaw = raw
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^cookie\s*:\s*/i, ""))
    .filter(Boolean)
    .join("; ");

  const allowColon = Boolean(options?.allowColonSeparator);
  const stripQuotes = Boolean(options?.stripQuotes);

  for (const part of cleanedRaw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf("=");
    const colonIndex = allowColon ? trimmed.indexOf(":") : -1;
    const sep = eqIndex >= 0 ? eqIndex : colonIndex;
    if (sep <= 0) continue;

    let key = trimmed.slice(0, sep).trim();
    let value = trimmed.slice(sep + 1).trim();
    if (stripQuotes) {
      key = key.replace(/^"+|"+$/g, "");
      value = value.replace(/^"+|"+$/g, "");
    }
    if (!key || !value || SET_COOKIE_ATTRIBUTES.has(key.toLowerCase())) {
      continue;
    }
    entries.set(key, value);
  }

  return entries;
}

export function serializeCookieMap(cookies: Map<string, string> | Record<string, string>): string {
  const entries = cookies instanceof Map ? cookies.entries() : Object.entries(cookies);
  const pairs: string[] = [];
  for (const [key, value] of entries) {
    if (key && value) {
      pairs.push(`${key}=${value}`);
    }
  }
  return pairs.join("; ");
}
