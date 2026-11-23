import type { LyricLine } from "#shared";

function parseTimestamp(raw: string): number | null {
  const match = raw.match(/^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(match[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(fraction)) {
    return null;
  }
  return minutes * 60 + seconds + fraction;
}

export function parseLrc(raw: string | null | undefined): LyricLine[] {
  if (!raw?.trim()) return [];
  const lines: LyricLine[] = [];

  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (stamps.length === 0) continue;

    const text = row.replace(/\[(\d{1,3}:\d{2}(?:[.:]\d{1,3})?)\]/g, "").trim();
    if (!text) continue;

    for (const stamp of stamps) {
      const value = stamp[1];
      if (!value) continue;
      const time = parseTimestamp(value);
      if (time !== null) {
        lines.push({ time, text });
      }
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Parses Netease word-level YRC format while preserving parenthesized lyric text.
 */
export function parseYrc(raw: string | null | undefined): LyricLine[] {
  if (!raw?.trim()) return [];
  const lines: LyricLine[] = [];
  const tokenPattern = /\(\d+,\d+,\d+\)/g;

  for (const row of raw.split(/\r?\n/)) {
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith("{")) continue;

    const lineMatch = trimmed.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) continue;

    const time = Number(lineMatch[1]) / 1000;
    const content = lineMatch[3] ?? "";
    const text = content.replace(tokenPattern, "").replace(/\s+/g, " ").trim();

    if (!Number.isFinite(time) || !text) continue;
    lines.push({ time, text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Merges translated lyrics using a +/-150ms tolerance window so slight timestamp drift does not drop translations.
 */
export function mergeLyricTranslations(
  lines: readonly LyricLine[],
  translations: readonly LyricLine[],
): LyricLine[] {
  if (translations.length === 0) {
    return lines.map((line) => ({ ...line }));
  }

  const sortedTrans = [...translations].sort((a, b) => a.time - b.time);
  const TOLERANCE_SEC = 0.15;

  return lines.map((line) => {
    let bestText: string | undefined;
    let bestDiff = TOLERANCE_SEC + 1e-6;

    // Binary search for closest timestamp
    let lo = 0;
    let hi = sortedTrans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midItem = sortedTrans[mid];
      if (!midItem) break;
      if (midItem.time < line.time) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    for (const idx of [lo - 1, lo, lo + 1]) {
      const candidate = sortedTrans[idx];
      if (!candidate) continue;
      const diff = Math.abs(candidate.time - line.time);
      if (diff <= bestDiff) {
        bestDiff = diff;
        bestText = candidate.text;
      }
    }

    return bestText ? { ...line, translation: bestText } : { ...line };
  });
}

function formatLrcTimestamp(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
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
