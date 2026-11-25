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

function toWellFormedString(raw: string): string {
  const nativeFn = (raw as { toWellFormed?: () => string }).toWellFormed;
  if (typeof nativeFn === "function") {
    return nativeFn.call(raw);
  }
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = raw.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += `${raw[i] ?? ""}${raw[i + 1] ?? ""}`;
        i += 1;
      } else {
        out += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD";
    } else {
      out += raw[i] ?? "";
    }
  }
  return out;
}

export function sanitizeDownloadFilename(
  raw: string,
  fallback = "TrackVault-Audio",
  maxLength = 120,
): string {
  const wellFormed = toWellFormedString(raw);
  let cleaned = "";
  for (const ch of wellFormed) {
    const code = ch.codePointAt(0) ?? 0;
    // Strip C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F) control characters
    if (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)) {
      cleaned += ch;
    }
  }
  cleaned = cleaned
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");

  // Truncate by Unicode code points so surrogate pairs (emoji / CJK Extension B) are never split
  const safeMax = Math.max(1, Math.floor(maxLength));
  const codePoints = Array.from(cleaned);
  if (codePoints.length > safeMax) {
    cleaned = codePoints.slice(0, safeMax).join("");
  }

  // Re-strip trailing/leading dots, spaces, and dashes exposed by truncation
  cleaned = cleaned.replace(/^[.\s-]+|[.\s-]+$/g, "").trim();

  // Reject Windows reserved device names both bare (CON) and with extensions (CON.mp3)
  const stem = cleaned.split(".")[0] ?? cleaned;
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) {
    return fallback;
  }
  return cleaned;
}

/**
 * RFC4180 CSV cell serializer with spreadsheet formula-injection protection.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^(?:[\t\r\n]|[\s]*[=+\-@])/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function sanitizeCssUrl(raw: string | null | undefined): string | null {
  const safe = sanitizeExternalUrl(raw);
  if (!safe) return null;
  // Encode quotes, backslashes, and parentheses so the value can never break out of CSS url("...")
  return safe.replace(/["'()\\]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Truncates text by Unicode code points so surrogate pairs (e.g. emoji) are never split.
 */
export function truncateCodePoints(value: string, maxCodePoints: number): string {
  const safeMax = Number.isFinite(maxCodePoints) ? Math.max(0, Math.floor(maxCodePoints)) : 0;
  if (safeMax === 0) return "";
  const safe = toWellFormedString(value);
  const chars = Array.from(safe);
  if (chars.length <= safeMax) return safe;
  return safeMax > 3 ? `${chars.slice(0, safeMax - 3).join("")}...` : chars.slice(0, safeMax).join("");
}

/**
 * Formats duration in seconds as `MM:SS`, or `HH:MM:SS` when >= 3600 seconds.
 */
export function formatDurationSeconds(seconds: number | null | undefined): string {
  const safe = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (safe >= 3600) {
    const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
    const mins = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
    const secs = String(safe % 60).padStart(2, "0");
    return `${hours}:${mins}:${secs}`;
  }
  const mins = String(Math.floor(safe / 60)).padStart(2, "0");
  const secs = String(safe % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

const shanghaiTimestampFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Formats a Unix timestamp (seconds or milliseconds) in Asia/Shanghai as `YYYY-MM-DD HH:mm`,
 * or empty string when missing/invalid.
 */
export function formatTimestampText(timestampMsOrSec: number | null | undefined): string {
  if (typeof timestampMsOrSec !== "number" || !Number.isFinite(timestampMsOrSec) || timestampMsOrSec <= 0) {
    return "";
  }
  const ms = timestampMsOrSec > 10_000_000_000 ? timestampMsOrSec : timestampMsOrSec * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = shanghaiTimestampFormatter.formatToParts(date);
  let year = "";
  let month = "";
  let day = "";
  let hour = "";
  let minute = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
    else if (part.type === "hour") hour = part.value;
    else if (part.type === "minute") minute = part.value;
  }
  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
