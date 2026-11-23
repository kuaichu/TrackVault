export const ALLOWED_COVER_HOST_SUFFIXES = [
  "music.126.net",
  "gtimg.cn",
  "qpic.cn",
  "y.qq.com",
  "qlogo.cn",
] as const;

export function parseSafeHttpUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (parsed.username || parsed.password) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function sanitizeExternalUrl(raw: string | null | undefined): string | null {
  const parsed = parseSafeHttpUrl(raw);
  return parsed ? parsed.toString() : null;
}

export function isAllowedCoverHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) return false;
  return ALLOWED_COVER_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function normalizeCoverUrl(raw: string | null | undefined, size = 400): string | undefined {
  const parsed = parseSafeHttpUrl(raw);
  if (!parsed) return undefined;
  if (!isAllowedCoverHost(parsed.hostname)) {
    return undefined;
  }
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "music.126.net" || host.endsWith(".music.126.net")) {
    parsed.searchParams.set("param", `${size}y${size}`);
  }
  return parsed.toString();
}

export function sanitizeDownloadFilename(
  raw: string,
  fallback = "TrackVault-Audio",
  maxLength = 120,
): string {
  let cleaned = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      cleaned += ch;
    }
  }
  cleaned = cleaned
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, maxLength)
    .trim();

  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

/**
 * RFC4180 CSV cell serializer with spreadsheet formula-injection protection.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function sanitizeCssUrl(raw: string | null | undefined): string | null {
  const safe = sanitizeExternalUrl(raw);
  if (!safe) return null;
  // Encode quotes, backslashes, and parentheses so the value can never break out of CSS url("...")
  return safe.replace(/["'()\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
