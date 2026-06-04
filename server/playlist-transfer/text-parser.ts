import type { TransferTrack } from "./types.js";

const headerPrefixes = ["歌单", "来源", "生成时间", "已匹配", "未匹配", "未找到", "版权受限", "版权 / 权限受限"];

function stripListMarker(line: string) {
  return line
    .trim()
    .replace(/^\d+\s*[\.)、）]\s*/, "")
    .replace(/^[-*]\s*/, "")
    .trim();
}

function splitArtists(value: string) {
  return value
    .split(/\s*(?:\/|、|，|,|&| and )\s*/i)
    .map((artist) => artist.trim())
    .filter(Boolean);
}

function shouldSkipLine(line: string) {
  if (!line.trim()) {
    return true;
  }

  return headerPrefixes.some((prefix) => line.trim().startsWith(`${prefix}：`) || line.trim().startsWith(`${prefix}:`));
}

function parseDelimitedLine(line: string, index: number): TransferTrack {
  const rawText = stripListMarker(line);
  const parts = rawText
    .split(/\s+-\s+|\t|，|,/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 3) {
    return {
      source: "text",
      sourceTrackId: `text-${index}`,
      title: parts[0],
      artists: splitArtists(parts[1]),
      album: parts.slice(2).join(" - "),
      rawText
    };
  }

  if (parts.length === 2) {
    const leftLooksLikeArtists = /\/|、|&| and /i.test(parts[0]);
    return {
      source: "text",
      sourceTrackId: `text-${index}`,
      title: leftLooksLikeArtists ? parts[1] : parts[0],
      artists: splitArtists(leftLooksLikeArtists ? parts[0] : parts[1]),
      rawText
    };
  }

  return {
    source: "text",
    sourceTrackId: `text-${index}`,
    title: rawText,
    artists: [],
    rawText
  };
}

export function parseTextPlaylist(input: string): TransferTrack[] {
  const tracks: TransferTrack[] = [];

  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (shouldSkipLine(trimmed)) {
      continue;
    }

    tracks.push(parseDelimitedLine(trimmed, tracks.length + 1));
  }

  return tracks.filter((track) => track.title.trim());
}
