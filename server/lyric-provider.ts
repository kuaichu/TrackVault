import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { LyricLine, SongLyrics } from "./types.js";

const require = createRequire(import.meta.url);
const { lyric, lyric_new } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type LyricBody = {
  lrc?: {
    lyric?: string;
  };
  tlyric?: {
    lyric?: string;
  };
  yrc?: {
    lyric?: string;
  };
};

const LYRIC_CACHE_TTL_MS = 30 * 60 * 1000;
const lyricCache = new Map<string, { savedAt: number; lyrics: SongLyrics }>();

function parseTimestamp(raw: string) {
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(match[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
  return minutes * 60 + seconds + fraction;
}

function parseLrc(raw: string | undefined) {
  if (!raw?.trim()) {
    return [];
  }

  const lines: LyricLine[] = [];

  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (stamps.length === 0) {
      continue;
    }

    const text = row.replace(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g, "").trim();
    if (!text) {
      continue;
    }

    for (const stamp of stamps) {
      const time = parseTimestamp(stamp[1]);
      if (time !== null) {
        lines.push({ time, text });
      }
    }
  }

  return lines.sort((left, right) => left.time - right.time);
}

function parseYrc(raw: string | undefined) {
  if (!raw?.trim()) {
    return [];
  }

  const lines: LyricLine[] = [];

  for (const row of raw.split(/\r?\n/)) {
    const trimmedRow = row.trim();
    if (!trimmedRow || trimmedRow.startsWith("{")) {
      continue;
    }

    const lineMatch = trimmedRow.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      continue;
    }

    const time = Number(lineMatch[1]) / 1000;
    const lyricContent = lineMatch[3] ?? "";
    const text = [...lyricContent.matchAll(/\((\d+),(\d+),\d+\)([^()]+)/g)]
      .map((match) => match[3]?.trim() ?? "")
      .join("")
      .trim();

    if (!Number.isFinite(time) || !text) {
      continue;
    }

    lines.push({ time, text });
  }

  return lines.sort((left, right) => left.time - right.time);
}

function mergeTranslations(lines: LyricLine[], translations: LyricLine[]) {
  if (translations.length === 0) {
    return lines;
  }

  const translationMap = new Map(translations.map((line) => [line.time.toFixed(3), line.text]));
  return lines.map((line) => ({
    ...line,
    translation: translationMap.get(line.time.toFixed(3))
  }));
}

async function requestLyrics(songId: string, source: "lyric_new" | "lyric") {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  const request = source === "lyric_new" ? lyric_new : lyric;
  let response: Awaited<ReturnType<typeof request>>;

  try {
    response = await request({
      id: songId,
      ...(cookie ? { cookie } : {})
    });
  } catch (error) {
    if (!cookie) {
      throw error;
    }

    response = await request({ id: songId });
  }

  const body = response.body as LyricBody;
  const baseLines = parseLrc(body.lrc?.lyric);
  const yrcLines = parseYrc(body.yrc?.lyric);
  const lines = mergeTranslations(baseLines.length > 0 ? baseLines : yrcLines, parseLrc(body.tlyric?.lyric));

  return {
    songId,
    lines,
    source
  };
}

export async function getSongLyrics(songId: string): Promise<SongLyrics> {
  const cached = lyricCache.get(songId);
  if (cached && Date.now() - cached.savedAt < LYRIC_CACHE_TTL_MS) {
    return cached.lyrics;
  }

  const attempts: Array<() => Promise<SongLyrics>> = [
    () => requestLyrics(songId, "lyric_new"),
    () => requestLyrics(songId, "lyric")
  ];
  const errors: Error[] = [];
  let emptyResult: SongLyrics | null = null;

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result.lines.length > 0) {
        lyricCache.set(songId, {
          savedAt: Date.now(),
          lyrics: result
        });
        return result;
      }

      emptyResult ??= result;
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error("歌词接口请求失败"));
    }
  }

  if (cached) {
    return cached.lyrics;
  }

  if (emptyResult) {
    return emptyResult;
  }

  throw new Error(errors[0]?.message || "获取歌词失败");
}
