import { getSongLyrics } from "./lyric-provider.js";
import { getQqSongLyrics } from "./qqmusic-provider.js";
import { formatLyricsAsLrc, injectFlacMetadata, isFlacBytes, type FlacCoverData } from "./flac-metadata.js";
import { injectMp3Metadata, isMp3Bytes } from "./mp3-metadata.js";
import { readResponseBytesWithLimit } from "./media-memory-policy.js";
import type { Song } from "./types.js";

const COVER_MAX_BYTES = 5 * 1024 * 1024;
const METADATA_REQUEST_TIMEOUT_MS = 15_000;

function normalizeAudioType(type: string | null | undefined) {
  return type?.replace(/^\./, "").toLowerCase() ?? "";
}

export function isFlacDownloadTarget(input: {
  filename?: string | null;
  type?: string | null;
  contentType?: string | null;
  bytes?: Uint8Array | null;
}) {
  const filename = input.filename?.toLowerCase() ?? "";
  const type = normalizeAudioType(input.type);
  const contentType = input.contentType?.toLowerCase() ?? "";

  return (
    type === "flac" ||
    filename.endsWith(".flac") ||
    contentType.includes("audio/flac") ||
    contentType.includes("audio/x-flac") ||
    Boolean(input.bytes && isFlacBytes(input.bytes))
  );
}

export function isMp3DownloadTarget(input: {
  filename?: string | null;
  type?: string | null;
  contentType?: string | null;
  bytes?: Uint8Array | null;
}) {
  const filename = input.filename?.toLowerCase() ?? "";
  const type = normalizeAudioType(input.type);
  const contentType = input.contentType?.toLowerCase() ?? "";

  return (
    type === "mp3" ||
    filename.endsWith(".mp3") ||
    contentType.includes("audio/mpeg") ||
    contentType.includes("audio/mp3") ||
    Boolean(input.bytes && isMp3Bytes(input.bytes))
  );
}

export function getAudioMetadataTarget(input: {
  filename?: string | null;
  type?: string | null;
  contentType?: string | null;
  bytes?: Uint8Array | null;
}): "flac" | "mp3" | null {
  if (input.bytes) {
    if (isFlacBytes(input.bytes)) return "flac";
    if (isMp3Bytes(input.bytes)) return "mp3";
    return null;
  }

  if (isFlacDownloadTarget(input)) {
    return "flac";
  }

  if (isMp3DownloadTarget(input)) {
    return "mp3";
  }

  return null;
}

function isAllowedCoverHost(hostname: string) {
  const normalizedHost = hostname.toLowerCase();
  return (
    normalizedHost === "music.126.net" ||
    normalizedHost.endsWith(".music.126.net") ||
    normalizedHost === "y.gtimg.cn" ||
    normalizedHost.endsWith(".y.gtimg.cn") ||
    normalizedHost === "qpic.y.qq.com" ||
    normalizedHost === "y.qq.com" ||
    normalizedHost === "thirdqq.qlogo.cn"
  );
}

async function fetchCover(song: Song, signal: AbortSignal): Promise<FlacCoverData | null> {
  if (!song.coverUrl?.trim()) {
    return null;
  }

  const coverUrl = new URL(getHighResolutionCoverUrl(song.coverUrl));
  if ((coverUrl.protocol !== "https:" && coverUrl.protocol !== "http:") || !isAllowedCoverHost(coverUrl.hostname)) {
    return null;
  }

  const response = await fetch(coverUrl, { signal });
  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.toLowerCase().startsWith("image/")) {
    return null;
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > COVER_MAX_BYTES) {
    return null;
  }

  const bytes = await readResponseBytesWithLimit(response, { limitBytes: COVER_MAX_BYTES });

  return {
    mimeType: contentType,
    bytes
  };
}

export function getHighResolutionCoverUrl(rawUrl: string) {
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    return trimmedUrl;
  }

  try {
    const url = new URL(trimmedUrl);
    const host = url.hostname.toLowerCase();

    if (host === "music.126.net" || host.endsWith(".music.126.net")) {
      url.searchParams.set("param", "1400y1400");
      return url.toString();
    }

    if (host === "y.gtimg.cn" || host.endsWith(".y.gtimg.cn")) {
      url.pathname = url.pathname.replace(/R\d+x\d+M000/i, "R800x800M000");
      return url.toString();
    }

    return trimmedUrl;
  } catch {
    return trimmedUrl;
  }
}

async function fetchLyricsText(song: Song, signal: AbortSignal) {
  try {
    const lyrics = song.source === "qqmusic"
      ? await getQqSongLyrics(song.id, song.mediaId, song.providerSongId, undefined, signal)
      : await getSongLyrics(song.id, signal);
    return formatLyricsAsLrc(lyrics);
  } catch (error) {
    if (signal.aborted) throw error;
    return "";
  }
}

export async function addAudioMetadataToDownload(input: {
  song: Song;
  bytes: Uint8Array;
  filename?: string | null;
  type?: string | null;
  contentType?: string | null;
  signal?: AbortSignal;
  onMetadataResult?: (result: { lyricsFetched: boolean; coverFetched: boolean }) => void;
}) {
  const target = getAudioMetadataTarget(input);
  if (!target) {
    return input.bytes;
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new Error("歌词或封面请求超时")), METADATA_REQUEST_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutController.signal]) : timeoutController.signal;
  try {
    const [lyricsText, cover] = await Promise.all([
      fetchLyricsText(input.song, signal),
      fetchCover(input.song, signal).catch((error) => {
        if (signal.aborted) throw error;
        return null;
      })
    ]);
    input.onMetadataResult?.({ lyricsFetched: lyricsText.length > 0, coverFetched: cover !== null });
    return target === "flac"
      ? injectFlacMetadata(input.bytes, input.song, lyricsText, cover)
      : injectMp3Metadata(input.bytes, input.song, lyricsText, cover);
  } finally {
    clearTimeout(timeout);
  }
}
