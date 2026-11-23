import type { LyricLine } from "#shared";

function parseTimestamp(raw: string): number | null {
  const match = raw.match(/^(\d{1,3}):(\d{2})(?:[.:](\d+))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60 || !Number.isFinite(fraction)) {
    return null;
  }
  return minutes * 60 + seconds + fraction;
}

export function parseLrc(raw: string | null | undefined): LyricLine[] {
  if (!raw?.trim()) return [];
  const rawLines: LyricLine[] = [];
  let offsetMs = 0;

  for (const row of raw.split(/\r?\n/)) {
    const offsetMatch = row.match(/\[offset\s*:\s*([+-]?\d+)\s*\]/i);
    if (offsetMatch?.[1]) {
      const parsedOffset = Number(offsetMatch[1]);
      if (Number.isFinite(parsedOffset)) {
        offsetMs = parsedOffset;
      }
    }

    const stamps = [...row.matchAll(/\[(\d{1,3}:\d{2}(?:[.:]\d+)?)\]/g)];
    if (stamps.length === 0) continue;

    const text = row.replace(/\[(\d{1,3}:\d{2}(?:[.:]\d+)?)\]/g, "").trim();

    for (const stamp of stamps) {
      const value = stamp[1];
      if (!value) continue;
      const time = parseTimestamp(value);
      if (time !== null) {
        rawLines.push({ time, text });
      }
    }
  }

  // Standard LRC [offset:+/-ms]: positive shifts timestamps earlier, negative delays them
  const offsetSec = offsetMs / 1000;
  const adjusted = rawLines
    .map((line) => ({
      ...line,
      time: offsetSec !== 0 ? Math.max(0, Math.round((line.time - offsetSec) * 1000) / 1000) : line.time,
    }))
    .sort((a, b) => a.time - b.time);

  // Strip leading empty interlude lines and collapse consecutive empty markers; return [] if no vocal lines exist
  const cleaned: LyricLine[] = [];
  let hasVocalLine = false;
  for (const line of adjusted) {
    if (!line.text) {
      if (hasVocalLine && cleaned.length > 0 && cleaned[cleaned.length - 1]?.text !== "") {
        cleaned.push(line);
      }
    } else {
      hasVocalLine = true;
      cleaned.push(line);
    }
  }

  return hasVocalLine ? cleaned : [];
}

/**
 * Parses Netease word-level YRC format while preserving parenthesized lyric text.
 */
export function parseYrc(raw: string | null | undefined): LyricLine[] {
  if (!raw?.trim()) return [];
  const lines: LyricLine[] = [];
  const tokenPattern = /\(-?\d+,-?\d+,-?\d+\)/g;

  for (const row of raw.split(/\r?\n/)) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith("{")) continue;

    const lineMatch = trimmed.match(/^\[(-?\d+),(-?\d+)\](.*)$/);
    if (!lineMatch) continue;

    const rawTime = Number(lineMatch[1]) / 1000;
    const content = lineMatch[3] ?? "";
    const text = content.replace(tokenPattern, "").replace(/\s+/g, " ").trim();

    if (!Number.isFinite(rawTime) || !text) continue;
    lines.push({ time: Math.max(0, rawTime), text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Merges translated lyrics using a +/-150ms tolerance window so slight timestamp drift does not drop translations.
 * Filters out "//" untranslated placeholders and consumes each translation line at most once.
 */
export function mergeLyricTranslations(
  lines: readonly LyricLine[],
  translations: readonly LyricLine[],
): LyricLine[] {
  const validTrans = translations
    .filter((item) => {
      const trimmed = item.text.trim();
      return Boolean(trimmed) && trimmed !== "//";
    })
    .sort((a, b) => a.time - b.time);

  if (validTrans.length === 0) {
    return lines.map((line) => ({ ...line }));
  }

  const used = new Set<number>();
  const TOLERANCE_SEC = 0.15;

  return lines.map((line) => {
    if (!line.text.trim()) {
      return { ...line };
    }

    let bestIndex = -1;
    let bestDiff = TOLERANCE_SEC + 1e-6;

    // Binary search for closest timestamp
    let lo = 0;
    let hi = validTrans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midItem = validTrans[mid];
      if (!midItem) break;
      if (midItem.time < line.time) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Check nearby candidates (scanning small window to skip already-consumed indices)
    for (let idx = Math.max(0, lo - 2); idx <= Math.min(validTrans.length - 1, lo + 2); idx += 1) {
      if (used.has(idx)) continue;
      const candidate = validTrans[idx];
      if (!candidate) continue;
      const diff = Math.abs(candidate.time - line.time);
      if (diff <= bestDiff) {
        bestDiff = diff;
        bestIndex = idx;
      }
    }

    if (bestIndex >= 0) {
      used.add(bestIndex);
      const matched = validTrans[bestIndex];
      if (matched) {
        return { ...line, translation: matched.text };
      }
    }
    return { ...line };
  });
}

function formatLrcTimestamp(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalCentiseconds = Math.round(safe * 100);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const wholeSeconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  return `[${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]`;
}

export function formatLyricsAsLrc(lines: readonly LyricLine[] | null | undefined): string {
  if (!lines || lines.length === 0) return "";
  return lines
    .map(
      (line) =>
        `${formatLrcTimestamp(line.time)}${line.text}${line.translation ? ` / ${line.translation}` : ""}`,
    )
    .join("\n");
}
