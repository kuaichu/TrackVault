const EXPIRE_KEY_HINTS = ["expire", "endtime", "end_time", "deadline", "duetime", "due_time", "validtime", "valid_time", "vipend"];
const MIN_REASONABLE_EXPIRE_MS = Date.UTC(2020, 0, 1);
const MAX_REASONABLE_EXPIRE_MS = Date.UTC(2100, 0, 1);

function normalizeExpireTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    return milliseconds >= MIN_REASONABLE_EXPIRE_MS && milliseconds <= MAX_REASONABLE_EXPIRE_MS ? milliseconds : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "0") {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return normalizeExpireTimestamp(Number(trimmed));
  }

  const parsed = Date.parse(trimmed.replace(/\./g, "-").replace(/\//g, "-"));
  return Number.isFinite(parsed) && parsed >= MIN_REASONABLE_EXPIRE_MS && parsed <= MAX_REASONABLE_EXPIRE_MS ? parsed : undefined;
}

function keyMayContainExpireTime(key: string) {
  const normalizedKey = key.toLocaleLowerCase();
  return EXPIRE_KEY_HINTS.some((hint) => normalizedKey.includes(hint));
}

export function findMembershipExpireAt(input: unknown, visited = new Set<unknown>()): number | undefined {
  if (!input || typeof input !== "object" || visited.has(input)) {
    return undefined;
  }

  visited.add(input);
  const record = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!keyMayContainExpireTime(key)) {
      continue;
    }

    const timestamp = normalizeExpireTimestamp(value);
    if (timestamp) {
      return timestamp;
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findMembershipExpireAt(item, visited);
        if (found) {
          return found;
        }
      }
      continue;
    }

    const found = findMembershipExpireAt(value, visited);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function formatMembershipExpireText(expireAt: number | undefined) {
  if (!expireAt) {
    return undefined;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(expireAt));
}
