import { getSongLyrics } from "./lyric-provider.js";
import { getQqSongLyrics } from "./qqmusic-provider.js";
import { formatLyricsAsLrc, injectFlacMetadata, isFlacBytes, type FlacCoverData } from "./flac-metadata.js";
import type { Song } from "./types.js";

const COVER_MAX_BYTES = 5 * 1024 * 1024;

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

async function fetchCover(song: Song): Promise<FlacCoverData | null> {
  if (!song.coverUrl?.trim()) {
    return null;
  }

  const coverUrl = new URL(song.coverUrl);
  if ((coverUrl.protocol !== "https:" && coverUrl.protocol !== "http:") || !isAllowedCoverHost(coverUrl.hostname)) {
    return null;
  }

  const response = await fetch(coverUrl);
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

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > COVER_MAX_BYTES) {
    return null;
  }

  return {
    mimeType: contentType,
    bytes
  };
}

async function fetchLyricsText(song: Song) {
  try {
    const lyrics = song.source === "qqmusic"
      ? await getQqSongLyrics(song.id, song.mediaId)
      : await getSongLyrics(song.id);
    return formatLyricsAsLrc(lyrics);
  } catch {
    return "";
  }
}

export async function addFlacMetadataToDownload(input: {
  song: Song;
  bytes: Uint8Array;
  filename?: string | null;
  type?: string | null;
  contentType?: string | null;
}) {
  if (!isFlacDownloadTarget(input)) {
    return input.bytes;
  }

  try {
    const [lyricsText, cover] = await Promise.all([
      fetchLyricsText(input.song),
      fetchCover(input.song).catch(() => null)
    ]);
    return injectFlacMetadata(input.bytes, input.song, lyricsText, cover);
  } catch {
    return input.bytes;
  }
}
