import type {
  AlbumProfile,
  AdminConfigUpdate,
  AdminConfigView,
  ArtistProfile,
  AppSettings,
  AuthSession,
  NeteaseCaptchaSendResult,
  NeteaseCellphoneLoginResult,
  DownloadQualityLevel,
  DownloadTask,
  NeteaseImportAudit,
  NeteaseImportAuditJob,
  NeteaseImportAuditRequest,
  NeteaseCookieCheckResult,
  QqMusicAccountStatus,
  QqMusicCookieCheckResult,
  QqMusicQrCheckResult,
  QqMusicQrStartResult,
  QqMusicUserProfile,
  PersonalRadioKind,
  NeteaseQrCheckResult,
  NeteaseQrStartResult,
  NeteaseTransferImportResult,
  PersistedPlayerState,
  PlaylistCompareExportRequest,
  PlaylistCompareJob,
  PlaylistCompareRequest,
  PlaylistCompareResult,
  PlaylistSongsPage,
  PlaylistTrackAddResult,
  PlaylistTrackRemoveResult,
  PlaylistTransferJob,
  PlaylistTransferRunJob,
  Song,
  SongAudioProbe,
  SongAudioProbeMode,
  SongComment,
  SongCommentRepliesPage,
  SongCommentsPage,
  SongInsight,
  SongLyrics,
  TransferExportFormat,
  TransferExportResult,
  TransferImportRequest,
  UserProfile,
  UserEventsPage,
  UserFollowActionResult,
  UserSocialListKind,
  UserSocialPage,
  UserPlaylist
} from "./types";

const CLIENT_SESSION_STORAGE_KEY = "trackvault:client-session-id";
const STREAM_URL_VERSION = "2";

function getClientSessionId() {
  try {
    const existing = window.localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const nextValue = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, nextValue);
    return nextValue;
  } catch {
    return "default";
  }
}

async function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("x-client-session-id", getClientSessionId());

  return fetch(input, {
    ...init,
    headers
  });
}

export function getStreamUrl(song: Song | string, level: DownloadQualityLevel, expectedDurationSeconds?: number) {
  const songId = typeof song === "string" ? song : song.id;
  const params = new URLSearchParams({
    id: songId,
    level,
    sid: getClientSessionId(),
    v: STREAM_URL_VERSION
  });

  if (typeof song !== "string") {
    params.set("source", song.source);
    if (song.mediaId) {
      params.set("mediaId", song.mediaId);
    }
  }

  if (Number.isFinite(expectedDurationSeconds) && Number(expectedDurationSeconds) > 0) {
    params.set("expectedDuration", String(Math.round(Number(expectedDurationSeconds))));
  }

  return `/api/stream?${params.toString()}`;
}

export type DirectDownloadInfo = {
  url: string;
  filename: string;
  type?: string | null;
  quality?: string | null;
  time?: number | null;
};

export type ServerDownloadProgressInfo = {
  progress: number;
  receivedBytes: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
};

type DownloadCoverData = {
  mimeType: string;
  bytes: Uint8Array;
};

export class DirectDownloadBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectDownloadBlockedError";
  }
}

export function isDirectDownloadBlockedError(error: unknown) {
  return error instanceof DirectDownloadBlockedError;
}

export function getDirectDownloadUrl(song: Song, level: DownloadQualityLevel) {
  const params = new URLSearchParams({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    source: song.source,
    level,
    sid: getClientSessionId()
  });

  if (song.mediaId) {
    params.set("mediaId", song.mediaId);
  }

  if (song.coverUrl) {
    params.set("coverUrl", song.coverUrl);
  }

  return `/api/download/direct?${params.toString()}`;
}

export function getServerDownloadUrl(song: Song, level: DownloadQualityLevel) {
  const params = new URLSearchParams({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    source: song.source,
    level,
    sid: getClientSessionId()
  });

  if (song.mediaId) {
    params.set("mediaId", song.mediaId);
  }

  if (song.coverUrl) {
    params.set("coverUrl", song.coverUrl);
  }

  return `/api/download/proxy?${params.toString()}`;
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

function isFlacDownload(song: Song, directDownload: DirectDownloadInfo, mediaResponse: Response, blob: Blob) {
  const normalizedType = directDownload.type?.replace(/^\./, "").toLowerCase();
  const contentType = mediaResponse.headers.get("content-type")?.toLowerCase() ?? blob.type.toLowerCase();
  const filename = directDownload.filename.toLowerCase();
  return (
    normalizedType === "flac" ||
    filename.endsWith(".flac") ||
    contentType.includes("audio/flac") ||
    contentType.includes("audio/x-flac") ||
    song.quality.toLowerCase().includes("flac") ||
    song.quality.toLowerCase().includes("hi-res")
  );
}

function isMp3Download(directDownload: DirectDownloadInfo, mediaResponse: Response, blob: Blob) {
  const normalizedType = directDownload.type?.replace(/^\./, "").toLowerCase();
  const contentType = mediaResponse.headers.get("content-type")?.toLowerCase() ?? blob.type.toLowerCase();
  const filename = directDownload.filename.toLowerCase();
  return (
    normalizedType === "mp3" ||
    filename.endsWith(".mp3") ||
    contentType.includes("audio/mpeg") ||
    contentType.includes("audio/mp3")
  );
}

function getDownloadMetadataTarget(song: Song, directDownload: DirectDownloadInfo, mediaResponse: Response, blob: Blob) {
  if (isFlacDownload(song, directDownload, mediaResponse, blob)) {
    return "flac";
  }

  if (isMp3Download(directDownload, mediaResponse, blob)) {
    return "mp3";
  }

  return null;
}

function formatLrcTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safeSeconds / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const centiseconds = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 100);
  return `[${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]`;
}

function formatLyricsAsLrc(lyrics: SongLyrics | null) {
  if (!lyrics || lyrics.lines.length === 0) {
    return "";
  }

  return lyrics.lines
    .map((line) => `${formatLrcTimestamp(line.time)}${line.text}${line.translation ? ` / ${line.translation}` : ""}`)
    .join("\n");
}

function writeUint32LittleEndian(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function writeUint32BigEndian(value: number) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatBytes(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function getId3v2TagLength(bytes: Uint8Array) {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x44 ||
    bytes[2] !== 0x33 ||
    bytes[6] > 0x7f ||
    bytes[7] > 0x7f ||
    bytes[8] > 0x7f ||
    bytes[9] > 0x7f
  ) {
    return 0;
  }

  const tagSize = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const hasFooter = Boolean(bytes[5] & 0x10);
  return 10 + tagSize + (hasFooter ? 10 : 0);
}

function findFlacStartOffset(bytes: Uint8Array) {
  if (bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return 0;
  }

  const id3Length = getId3v2TagLength(bytes);
  if (
    id3Length > 0 &&
    bytes.length >= id3Length + 4 &&
    bytes[id3Length] === 0x66 &&
    bytes[id3Length + 1] === 0x4c &&
    bytes[id3Length + 2] === 0x61 &&
    bytes[id3Length + 3] === 0x43
  ) {
    return id3Length;
  }

  return -1;
}

function buildVorbisCommentBlock(song: Song, lyricsText: string) {
  const encoder = new TextEncoder();
  const artistText = song.artists?.length ? song.artists.map((artist) => artist.name).join("; ") : song.artist;
  const comments = [
    ["TITLE", song.title],
    ["ARTIST", artistText],
    ["ALBUM", song.album],
    ["ALBUMARTIST", song.artist],
    ["TRACKVAULT_SOURCE", song.source],
    lyricsText ? ["LYRICS", lyricsText] : null,
    lyricsText ? ["UNSYNCEDLYRICS", lyricsText] : null
  ]
    .filter((item): item is [string, string] => Boolean(item?.[1]?.trim()))
    .map(([key, value]) => encoder.encode(`${key}=${value.trim()}`));
  const vendor = encoder.encode("TrackVault");
  const chunks = [writeUint32LittleEndian(vendor.length), vendor, writeUint32LittleEndian(comments.length)];

  for (const comment of comments) {
    chunks.push(writeUint32LittleEndian(comment.length), comment);
  }

  return concatBytes(chunks);
}

function buildFlacPictureBlock(cover: DownloadCoverData | null) {
  if (!cover || cover.bytes.length === 0) {
    return null;
  }

  const encoder = new TextEncoder();
  const mimeType = encoder.encode(cover.mimeType.split(";")[0]?.trim() || "image/jpeg");
  const description = new Uint8Array();

  return concatBytes([
    writeUint32BigEndian(3),
    writeUint32BigEndian(mimeType.length),
    mimeType,
    writeUint32BigEndian(description.length),
    description,
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(cover.bytes.length),
    cover.bytes
  ]);
}

function buildFlacMetadataBlock(type: number, data: Uint8Array, isLast: boolean) {
  if (data.length > 0xffffff) {
    throw new Error("FLAC 元数据块过大");
  }

  return concatBytes([
    new Uint8Array([
      (isLast ? 0x80 : 0) | (type & 0x7f),
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff
    ]),
    data
  ]);
}

function injectFlacMetadata(input: ArrayBuffer, song: Song, lyricsText: string, cover: DownloadCoverData | null) {
  const inputBytes = new Uint8Array(input);
  const flacStartOffset = findFlacStartOffset(inputBytes);
  if (flacStartOffset < 0) {
    return inputBytes;
  }

  const bytes = inputBytes.slice(flacStartOffset);
  const blocks: Array<{ type: number; data: Uint8Array }> = [];
  let offset = 4;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;

    if (offset + length > bytes.length) {
      return inputBytes;
    }

    blocks.push({ type, data: bytes.slice(offset, offset + length) });
    offset += length;

    if (header & 0x80) {
      break;
    }
  }

  const streamInfo = blocks.find((block) => block.type === 0);
  if (!streamInfo) {
    return inputBytes;
  }

  const pictureBlock = buildFlacPictureBlock(cover);
  const metadataBlocks = [
    streamInfo,
    { type: 4, data: buildVorbisCommentBlock(song, lyricsText) },
    ...(pictureBlock ? [{ type: 6, data: pictureBlock }] : []),
    ...blocks.filter((block) => block !== streamInfo && block.type !== 4 && block.type !== 6)
  ];
  const encodedBlocks = metadataBlocks.map((block, index) => buildFlacMetadataBlock(block.type, block.data, index === metadataBlocks.length - 1));

  return concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...encodedBlocks, bytes.slice(offset)]);
}

function writeSyncsafeUint32(value: number) {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f
  ]);
}

function stripExistingId3Tags(bytes: Uint8Array) {
  const id3v2Length = getId3v2TagLength(bytes);
  const withoutId3v2 = id3v2Length > 0 ? bytes.slice(id3v2Length) : bytes;
  const hasId3v1 = withoutId3v2.length >= 128 &&
    withoutId3v2[withoutId3v2.length - 128] === 0x54 &&
    withoutId3v2[withoutId3v2.length - 127] === 0x41 &&
    withoutId3v2[withoutId3v2.length - 126] === 0x47;

  return hasId3v1 ? withoutId3v2.slice(0, withoutId3v2.length - 128) : withoutId3v2;
}

function encodeUtf16Le(text: string, withBom = false) {
  const output = new Uint8Array((withBom ? 2 : 0) + text.length * 2);
  let offset = 0;

  if (withBom) {
    output[offset++] = 0xff;
    output[offset++] = 0xfe;
  }

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    output[offset++] = code & 0xff;
    output[offset++] = (code >>> 8) & 0xff;
  }

  return output;
}

function buildId3Frame(id: string, data: Uint8Array) {
  const encoder = new TextEncoder();
  return concatBytes([
    encoder.encode(id),
    writeUint32BigEndian(data.length),
    new Uint8Array([0x00, 0x00]),
    data
  ]);
}

function buildId3TextFrame(id: string, value: string | null | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return buildId3Frame(id, concatBytes([new Uint8Array([0x01]), encodeUtf16Le(normalizedValue, true)]));
}

function buildId3UserTextFrame(description: string, value: string | null | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return buildId3Frame(
    "TXXX",
    concatBytes([
      new Uint8Array([0x01]),
      encodeUtf16Le(description, true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalizedValue, true)
    ])
  );
}

function buildId3LyricsFrame(lyricsText: string) {
  const normalizedLyrics = lyricsText.trim();
  if (!normalizedLyrics) {
    return null;
  }

  const encoder = new TextEncoder();
  return buildId3Frame(
    "USLT",
    concatBytes([
      new Uint8Array([0x01]),
      encoder.encode("XXX"),
      encodeUtf16Le("", true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalizedLyrics, true)
    ])
  );
}

function buildId3PictureFrame(cover: DownloadCoverData | null) {
  if (!cover || cover.bytes.length === 0) {
    return null;
  }

  const encoder = new TextEncoder();
  const mimeType = encoder.encode(cover.mimeType.split(";")[0]?.trim() || "image/jpeg");

  return buildId3Frame(
    "APIC",
    concatBytes([
      new Uint8Array([0x00]),
      mimeType,
      new Uint8Array([0x00, 0x03, 0x00]),
      cover.bytes
    ])
  );
}

function injectMp3Metadata(input: ArrayBuffer, song: Song, lyricsText: string, cover: DownloadCoverData | null) {
  const encoder = new TextEncoder();
  const inputBytes = new Uint8Array(input);
  const artistText = song.artists?.length ? song.artists.map((artist) => artist.name).join("; ") : song.artist;
  const frames: Uint8Array[] = [];
  const frameCandidates = [
    buildId3TextFrame("TIT2", song.title),
    buildId3TextFrame("TPE1", artistText),
    buildId3TextFrame("TALB", song.album),
    buildId3TextFrame("TPE2", song.artist),
    buildId3UserTextFrame("TRACKVAULT_SOURCE", song.source),
    buildId3UserTextFrame("LYRICS", lyricsText),
    buildId3UserTextFrame("UNSYNCEDLYRICS", lyricsText),
    buildId3LyricsFrame(lyricsText),
    buildId3PictureFrame(cover)
  ];

  for (const frame of frameCandidates) {
    if (frame) {
      frames.push(frame);
    }
  }

  const body = concatBytes(frames);
  const header = concatBytes([
    encoder.encode("ID3"),
    new Uint8Array([0x03, 0x00, 0x00]),
    writeSyncsafeUint32(body.length)
  ]);

  return concatBytes([header, body, stripExistingId3Tags(inputBytes)]);
}

async function fetchDownloadCover(song: Song): Promise<DownloadCoverData | null> {
  if (!song.coverUrl?.trim()) {
    return null;
  }

  const response = await apiFetch(`/api/media/cover?url=${encodeURIComponent(song.coverUrl)}`);
  if (!response.ok) {
    return null;
  }

  const blob = await response.blob();
  if (!blob.size) {
    return null;
  }

  return {
    mimeType: blob.type || response.headers.get("content-type") || "image/jpeg",
    bytes: new Uint8Array(await blob.arrayBuffer())
  };
}

async function addMetadataToDownloadBlob(song: Song, directDownload: DirectDownloadInfo, mediaResponse: Response, blob: Blob) {
  const metadataTarget = getDownloadMetadataTarget(song, directDownload, mediaResponse, blob);
  if (!metadataTarget) {
    return blob;
  }

  try {
    const [lyricsResult, cover] = await Promise.allSettled([
      getLyrics(song),
      fetchDownloadCover(song)
    ]);
    const lyricsText = lyricsResult.status === "fulfilled" ? formatLyricsAsLrc(lyricsResult.value) : "";
    const originalBytes = await blob.arrayBuffer();
    const taggedBytes = metadataTarget === "flac"
      ? injectFlacMetadata(originalBytes, song, lyricsText, cover.status === "fulfilled" ? cover.value : null)
      : injectMp3Metadata(originalBytes, song, lyricsText, cover.status === "fulfilled" ? cover.value : null);
    return new Blob([taggedBytes], { type: metadataTarget === "flac" ? "audio/flac" : "audio/mpeg" });
  } catch {
    return blob;
  }
}

export async function startDirectSongDownload(song: Song, level: DownloadQualityLevel, onProgress?: (progress: number) => void) {
  const directResponse = await apiFetch(getDirectDownloadUrl(song, level));
  if (!directResponse.ok) {
    const data = (await directResponse.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取直连下载地址失败");
  }

  const directDownload = (await directResponse.json()) as DirectDownloadInfo;
  const providerLabel = song.source === "qqmusic" ? "QQ 音乐 CDN" : "网易云 CDN";
  let mediaResponse: Response;
  try {
    mediaResponse = await fetch(directDownload.url, {
      credentials: "omit",
      mode: "cors"
    });
  } catch {
    throw new DirectDownloadBlockedError(`浏览器被${providerLabel}跨域策略拦截，无法无中转保存到本机。`);
  }

  if (!mediaResponse.ok) {
    throw new Error(`${providerLabel}下载失败：HTTP ${mediaResponse.status}`);
  }

  const contentLength = Number(mediaResponse.headers.get("content-length") ?? "0");
  if (!mediaResponse.body || !contentLength) {
    try {
      const blob = await mediaResponse.blob();
      saveBlob(await addMetadataToDownloadBlob(song, directDownload, mediaResponse, blob), directDownload.filename);
    } catch {
      throw new DirectDownloadBlockedError(`${providerLabel}下载流中断，浏览器无法稳定直连保存到本机。`);
    }
    return directDownload;
  }

  const reader = mediaResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        chunks.push(value);
        receivedBytes += value.length;
        onProgress?.(Math.max(1, Math.min(99, Math.round((receivedBytes / contentLength) * 100))));
      }
    }
  } catch {
    throw new DirectDownloadBlockedError(`${providerLabel}下载流中断，浏览器无法稳定直连保存到本机。`);
  }

  const blob = new Blob(chunks, { type: mediaResponse.headers.get("content-type") ?? "application/octet-stream" });
  saveBlob(await addMetadataToDownloadBlob(song, directDownload, mediaResponse, blob), directDownload.filename);
  onProgress?.(100);
  return directDownload;
}

export async function startRawDirectSongDownload(song: Song, level: DownloadQualityLevel) {
  const directResponse = await apiFetch(getDirectDownloadUrl(song, level));
  if (!directResponse.ok) {
    const data = (await directResponse.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取裸直链下载地址失败");
  }

  const directDownload = (await directResponse.json()) as DirectDownloadInfo;
  const link = document.createElement("a");
  link.href = directDownload.url;
  link.download = directDownload.filename;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  return directDownload;
}

export async function startServerSongDownload(
  song: Song,
  level: DownloadQualityLevel,
  callbacks: { onStatus?: (status: string) => void; onProgress?: (info: ServerDownloadProgressInfo) => void; onReady?: (info: { filename: string; sizeBytes?: number; quality?: string }) => void } = {}
) {
  const response = await apiFetch(getServerDownloadUrl(song, level));
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "备用下载失败");
  }

  const filename = getFilenameFromContentDisposition(response.headers.get("content-disposition")) || `${song.title}-${song.artist}.${level === "standard" ? "mp3" : "flac"}`;
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const quality = response.headers.get("x-trackvault-quality") ?? undefined;

  callbacks.onStatus?.("服务器已返回文件，正在保存到本机。");

  if (!response.body || !contentLength) {
    const blob = await response.blob();
    callbacks.onReady?.({ filename, sizeBytes: blob.size, quality });
    callbacks.onProgress?.({ progress: 100, receivedBytes: blob.size, totalBytes: blob.size });
    saveBlob(blob, filename);
    return;
  }

  callbacks.onReady?.({ filename, sizeBytes: contentLength, quality });

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  const startedAt = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      receivedBytes += value.length;
      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      callbacks.onProgress?.({
        progress: Math.max(1, Math.min(99, Math.round((receivedBytes / contentLength) * 100))),
        receivedBytes,
        totalBytes: contentLength,
        speedBytesPerSecond: receivedBytes / elapsedSeconds
      });
    }
  }

  const blob = new Blob(chunks, { type: response.headers.get("content-type") ?? "application/octet-stream" });
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  callbacks.onProgress?.({
    progress: 100,
    receivedBytes,
    totalBytes: contentLength,
    speedBytesPerSecond: receivedBytes / elapsedSeconds
  });
  saveBlob(blob, filename);
}

export async function searchSongs(query: string, provider = "netease"): Promise<Song[]> {
  const params = new URLSearchParams({
    q: query,
    provider
  });
  const response = await apiFetch(`/api/search?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "搜索失败");
  }
  const data = (await response.json()) as { results: Song[] };
  return data.results;
}

export async function getDiscoverSongs(): Promise<Song[]> {
  const response = await apiFetch("/api/discover/songs");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取发现音乐失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

export async function createDownload(song: Song, level: DownloadQualityLevel): Promise<DownloadTask> {
  const response = await apiFetch("/api/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ song, level })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "加入下载队列失败");
  }

  return (await response.json()) as DownloadTask;
}

export async function getTasks(): Promise<DownloadTask[]> {
  const response = await apiFetch("/api/tasks");
  if (!response.ok) {
    throw new Error("获取任务失败");
  }
  return (await response.json()) as DownloadTask[];
}

function getFilenameFromContentDisposition(contentDisposition: string | null) {
  if (!contentDisposition) {
    return "";
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim());
  }

  const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return filenameMatch?.[1]?.trim() ?? "";
}

export async function downloadTaskFile(task: DownloadTask): Promise<void> {
  const response = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}/file`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "保存文件失败");
  }

  const blob = await response.blob();
  const filename = getFilenameFromContentDisposition(response.headers.get("content-disposition")) || `${task.title}-${task.artist}.mp3`;
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

export async function getPlaylists(provider?: "netease" | "qq"): Promise<UserPlaylist[]> {
  const params = new URLSearchParams();
  if (provider) {
    params.set("provider", provider);
  }
  const response = await apiFetch(`/api/playlists${params.size > 0 ? `?${params.toString()}` : ""}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单失败");
  }
  const data = (await response.json()) as { playlists: UserPlaylist[] };
  return data.playlists;
}

export async function getPlaylistSongs(playlistId: string, page = 1, limit = 100, keyword = "", sort = "default", provider?: "netease" | "qq"): Promise<PlaylistSongsPage> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    sort
  });
  if (provider) {
    params.set("provider", provider);
  }
  if (keyword.trim()) {
    params.set("keyword", keyword.trim());
  }
  const response = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单歌曲失败");
  }
  return (await response.json()) as PlaylistSongsPage;
}

export async function addSongToPlaylist(playlistId: string, songId: string): Promise<PlaylistTrackAddResult> {
  const response = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ songId })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "添加到歌单失败");
  }

  return (await response.json()) as PlaylistTrackAddResult;
}

export async function removeSongsFromPlaylist(playlistId: string, songIds: string[]): Promise<PlaylistTrackRemoveResult> {
  const response = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ songIds })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "从歌单移除失败");
  }

  return (await response.json()) as PlaylistTrackRemoveResult;
}

export async function getCloudSongs(): Promise<{ songs: Song[]; count: number; size: number; maxSize: number }> {
  const response = await apiFetch("/api/cloud/songs");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取云盘音乐失败");
  }

  return (await response.json()) as { songs: Song[]; count: number; size: number; maxSize: number };
}

export async function getDailyRecommendSongs(): Promise<Song[]> {
  const response = await apiFetch("/api/recommend/daily");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取每日推荐失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

export async function getPersonalRadioSongs(kind: PersonalRadioKind): Promise<Song[]> {
  const response = await apiFetch(`/api/recommend/personal-radio?kind=${encodeURIComponent(kind)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取私人推荐失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

export async function getHeartbeatSongs(songId: string, playlistId: string, startSongId = songId, count = 6): Promise<Song[]> {
  const params = new URLSearchParams({
    id: songId,
    pid: playlistId,
    sid: startSongId,
    count: String(count)
  });
  const response = await apiFetch(`/api/playmode/heartbeat?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取心动模式歌曲失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

function getSongIdentity(song: Song | string) {
  if (typeof song === "string") {
    return { id: song, params: new URLSearchParams() };
  }

  return {
    id: song.id,
    params: new URLSearchParams({
      source: song.source,
      ...(song.mediaId ? { mediaId: song.mediaId } : {}),
      ...(song.providerSongId ? { providerSongId: song.providerSongId } : {})
    })
  };
}

export async function getLyrics(song: Song | string): Promise<SongLyrics> {
  const identity = getSongIdentity(song);
  const query = identity.params.toString();
  const response = await apiFetch(`/api/lyrics/${encodeURIComponent(identity.id)}${query ? `?${query}` : ""}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌词失败");
  }

  const data = (await response.json()) as { lyrics: SongLyrics };
  return data.lyrics;
}

export async function getSongComments(song: Song | string, page = 1, limit = 20): Promise<SongCommentsPage> {
  const identity = getSongIdentity(song);
  const params = new URLSearchParams(identity.params);
  params.set("page", String(page));
  params.set("limit", String(limit));
  const response = await apiFetch(`/api/comments/songs/${encodeURIComponent(identity.id)}?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取评论失败");
  }

  return (await response.json()) as SongCommentsPage;
}

export async function getSongCommentReplies(song: Song | string, commentId: string, time = -1, limit = 20): Promise<SongCommentRepliesPage> {
  const identity = getSongIdentity(song);
  const params = new URLSearchParams(identity.params);
  params.set("time", String(time));
  params.set("limit", String(limit));
  const response = await apiFetch(`/api/comments/songs/${encodeURIComponent(identity.id)}/${encodeURIComponent(commentId)}/replies?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取评论回复失败");
  }

  return (await response.json()) as SongCommentRepliesPage;
}

export async function getSongAudioProbe(song: Song, level: DownloadQualityLevel, mode: SongAudioProbeMode): Promise<SongAudioProbe> {
  const response = await apiFetch("/api/songs/audio-probe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ song, level, mode })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "检测实际音源失败");
  }

  const data = (await response.json()) as { probe: SongAudioProbe };
  return data.probe;
}

export async function getSongInsight(song: Song | string): Promise<SongInsight> {
  const identity = getSongIdentity(song);
  const query = identity.params.toString();
  const response = await apiFetch(`/api/songs/${encodeURIComponent(identity.id)}/insight${query ? `?${query}` : ""}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌曲洞察失败");
  }

  const data = (await response.json()) as { insight: SongInsight };
  return data.insight;
}

export async function setSongCommentLiked(song: Song | string, commentId: string, liked: boolean): Promise<boolean> {
  const identity = getSongIdentity(song);
  const query = identity.params.toString();
  const response = await apiFetch(`/api/comments/songs/${encodeURIComponent(identity.id)}/${encodeURIComponent(commentId)}/like${query ? `?${query}` : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ liked })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? (liked ? "点赞评论失败" : "取消点赞失败"));
  }

  const data = (await response.json()) as { liked: boolean };
  return Boolean(data.liked);
}

export async function replyToSongComment(song: Song | string, commentId: string, content: string): Promise<SongComment | null> {
  const identity = getSongIdentity(song);
  const query = identity.params.toString();
  const response = await apiFetch(`/api/comments/songs/${encodeURIComponent(identity.id)}/${encodeURIComponent(commentId)}/replies${query ? `?${query}` : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "回复评论失败");
  }

  const data = (await response.json()) as { comment: SongComment | null };
  return data.comment;
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取用户信息失败");
  }

  const data = (await response.json()) as { user: UserProfile };
  return data.user;
}

export async function getUserSocialList(userId: string, kind: UserSocialListKind, page = 1, limit = 30): Promise<UserSocialPage> {
  const params = new URLSearchParams({
    kind,
    page: String(page),
    limit: String(limit)
  });
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/social?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取好友列表失败");
  }

  return (await response.json()) as UserSocialPage;
}

export async function getUserEvents(userId: string, lasttime = -1, limit = 20): Promise<UserEventsPage> {
  const params = new URLSearchParams({
    lasttime: String(lasttime),
    limit: String(limit)
  });
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/events?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取用户动态失败");
  }

  return (await response.json()) as UserEventsPage;
}

export async function setUserFollowed(userId: string, followed: boolean): Promise<UserFollowActionResult> {
  const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/follow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ followed })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "关注操作失败");
  }

  return (await response.json()) as UserFollowActionResult;
}

export async function getArtistProfile(artistId: string): Promise<ArtistProfile> {
  const response = await apiFetch(`/api/artists/${encodeURIComponent(artistId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌手信息失败");
  }

  const data = (await response.json()) as { artist: ArtistProfile };
  return data.artist;
}

export async function getAlbumProfile(albumId: string): Promise<AlbumProfile> {
  const response = await apiFetch(`/api/albums/${encodeURIComponent(albumId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取专辑信息失败");
  }

  const data = (await response.json()) as { album: AlbumProfile };
  return data.album;
}

export async function getSongLiked(songId: string): Promise<boolean> {
  const response = await apiFetch(`/api/likes/${encodeURIComponent(songId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取喜欢状态失败");
  }

  const data = (await response.json()) as { liked: boolean };
  return Boolean(data.liked);
}

export async function setSongLiked(songId: string, liked: boolean): Promise<boolean> {
  const response = await apiFetch(`/api/likes/${encodeURIComponent(songId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ liked })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? (liked ? "加入喜欢失败" : "取消喜欢失败"));
  }

  const data = (await response.json()) as { liked: boolean };
  return Boolean(data.liked);
}

export async function resolveArtistByName(name: string): Promise<{ id: string; name: string }> {
  const response = await apiFetch(`/api/artists/resolve/by-name?name=${encodeURIComponent(name)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "解析歌手失败");
  }

  return (await response.json()) as { id: string; name: string };
}

export async function getSettings(): Promise<AppSettings> {
  const response = await apiFetch("/api/settings");
  if (!response.ok) {
    throw new Error("获取设置失败");
  }
  return (await response.json()) as AppSettings;
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(settings)
  });

  if (!response.ok) {
    throw new Error("保存设置失败");
  }

  return (await response.json()) as AppSettings;
}

export async function getAdminConfig(): Promise<AdminConfigView> {
  const response = await apiFetch("/api/admin/config");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取高级控制配置失败");
  }

  return (await response.json()) as AdminConfigView;
}

export async function saveAdminConfig(config: AdminConfigUpdate): Promise<AdminConfigView> {
  const response = await apiFetch("/api/admin/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(config)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "保存高级控制配置失败");
  }

  return (await response.json()) as AdminConfigView;
}

export async function checkNeteaseCookie(cookie: string): Promise<NeteaseCookieCheckResult> {
  const response = await apiFetch("/api/settings/netease-cookie/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cookie })
  });

  if (!response.ok) {
    throw new Error("检测 Cookie 失败");
  }

  return (await response.json()) as NeteaseCookieCheckResult;
}

export async function checkQqMusicCookie(cookie: string): Promise<QqMusicCookieCheckResult> {
  const response = await apiFetch("/api/settings/qqmusic-cookie/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cookie })
  });

  if (!response.ok) {
    throw new Error("检测 QQ 音乐 Cookie 失败");
  }

  return (await response.json()) as QqMusicCookieCheckResult;
}

export async function getSession(): Promise<AuthSession> {
  const response = await apiFetch("/api/account");
  if (!response.ok) {
    throw new Error("获取账号信息失败");
  }
  return (await response.json()) as AuthSession;
}

export async function getQqMusicAccountStatus(): Promise<QqMusicAccountStatus> {
  const response = await apiFetch("/api/account/qqmusic");
  if (!response.ok) {
    throw new Error("获取 QQ 音乐账号信息失败");
  }
  return (await response.json()) as QqMusicAccountStatus;
}

export async function getQqMusicUserProfile(): Promise<QqMusicUserProfile> {
  const response = await apiFetch("/api/account/qqmusic/profile");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取 QQ 音乐个人主页失败");
  }

  const data = (await response.json()) as { profile: QqMusicUserProfile };
  return data.profile;
}

export async function startQqMusicQrLogin(): Promise<QqMusicQrStartResult> {
  const response = await apiFetch("/api/account/qqmusic/qr/start", {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "QQ 音乐二维码生成失败");
  }

  return (await response.json()) as QqMusicQrStartResult;
}

export async function checkQqMusicQrLogin(key: string): Promise<QqMusicQrCheckResult> {
  const response = await apiFetch(`/api/account/qqmusic/qr/check?key=${encodeURIComponent(key)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "QQ 音乐扫码状态检查失败");
  }

  return (await response.json()) as QqMusicQrCheckResult;
}

export async function loginAccount(payload: { accountName: string; vipEnabled: boolean; note: string }): Promise<AuthSession> {
  const response = await apiFetch("/api/account/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("登录失败");
  }

  return (await response.json()) as AuthSession;
}

export async function logoutAccount(): Promise<AuthSession> {
  const response = await apiFetch("/api/account/logout", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("退出登录失败");
  }

  return (await response.json()) as AuthSession;
}

export async function startNeteaseQrLogin(): Promise<NeteaseQrStartResult> {
  const response = await apiFetch("/api/account/netease/qr/start", {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "二维码登录初始化失败");
  }

  return (await response.json()) as NeteaseQrStartResult;
}

export async function checkNeteaseQrLogin(key: string): Promise<NeteaseQrCheckResult> {
  const response = await apiFetch(`/api/account/netease/qr/check?key=${encodeURIComponent(key)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "二维码登录状态检查失败");
  }

  return (await response.json()) as NeteaseQrCheckResult;
}

export async function sendNeteaseCaptcha(phone: string, countryCode = "86"): Promise<NeteaseCaptchaSendResult> {
  const response = await apiFetch("/api/account/netease/captcha/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phone, countryCode })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "验证码发送失败");
  }

  return (await response.json()) as NeteaseCaptchaSendResult;
}

export async function loginWithNeteaseCellphone(phone: string, captcha: string, countryCode = "86"): Promise<NeteaseCellphoneLoginResult> {
  const response = await apiFetch("/api/account/netease/cellphone/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phone, captcha, countryCode })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "手机号登录失败");
  }

  return (await response.json()) as NeteaseCellphoneLoginResult;
}

export async function getSearchHistory(): Promise<string[]> {
  const response = await apiFetch("/api/history/search");
  if (!response.ok) {
    throw new Error("获取搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function saveSearchHistory(items: string[]): Promise<string[]> {
  const response = await apiFetch("/api/history/search", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    throw new Error("保存搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function removeSearchHistory(keyword: string): Promise<string[]> {
  const response = await apiFetch(`/api/history/search?keyword=${encodeURIComponent(keyword)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error("删除搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function getPlayHistory(): Promise<Song[]> {
  const response = await apiFetch("/api/history/play");
  if (!response.ok) {
    throw new Error("获取播放历史失败");
  }

  const data = (await response.json()) as { items: Song[] };
  return data.items;
}

export async function savePlayHistory(items: Song[]): Promise<Song[]> {
  const response = await apiFetch("/api/history/play", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    throw new Error("保存播放历史失败");
  }

  const data = (await response.json()) as { items: Song[] };
  return data.items;
}

export async function getPlayerState(): Promise<PersistedPlayerState> {
  const response = await apiFetch("/api/player-state");
  if (!response.ok) {
    throw new Error("获取播放器状态失败");
  }

  return (await response.json()) as PersistedPlayerState;
}

export async function savePlayerState(state: PersistedPlayerState): Promise<PersistedPlayerState> {
  const response = await apiFetch("/api/player-state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(state)
  });

  if (!response.ok) {
    throw new Error("保存播放器状态失败");
  }

  return (await response.json()) as PersistedPlayerState;
}

export async function getPlaylistTransferJobs(): Promise<PlaylistTransferJob[]> {
  const response = await apiFetch("/api/playlist-transfer/jobs");
  if (!response.ok) {
    throw new Error("获取歌单互转任务失败");
  }

  const data = (await response.json()) as { jobs: PlaylistTransferJob[] };
  return data.jobs;
}

export async function createPlaylistTransferJob(payload: TransferImportRequest): Promise<PlaylistTransferJob> {
  const response = await apiFetch("/api/playlist-transfer/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "创建歌单互转任务失败");
  }

  return (await response.json()) as PlaylistTransferJob;
}

export async function startPlaylistTransferRunJob(payload: TransferImportRequest): Promise<PlaylistTransferRunJob> {
  const response = await apiFetch("/api/playlist-transfer/jobs/progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动歌单互转任务失败");
  }

  const data = (await response.json()) as { job: PlaylistTransferRunJob };
  return data.job;
}

export async function getPlaylistTransferRunJob(jobId: string): Promise<PlaylistTransferRunJob> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/progress/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单互转进度失败");
  }

  const data = (await response.json()) as { job: PlaylistTransferRunJob };
  return data.job;
}

export async function exportPlaylistTransferJob(jobId: string, format: TransferExportFormat): Promise<TransferExportResult> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/${encodeURIComponent(jobId)}/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ format })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出歌单互转报告失败");
  }

  return (await response.json()) as TransferExportResult;
}

export async function importPlaylistTransferToNetease(jobId: string, payload: { name?: string; playlistId?: string }): Promise<NeteaseTransferImportResult> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/${encodeURIComponent(jobId)}/import/netease`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导入网易云歌单失败");
  }

  return (await response.json()) as NeteaseTransferImportResult;
}

export async function createNeteaseImportAudit(payload: NeteaseImportAuditRequest): Promise<NeteaseImportAudit> {
  const response = await apiFetch("/api/playlist-transfer/netease-import-audit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "网易云导入歌单清理失败");
  }

  return (await response.json()) as NeteaseImportAudit;
}

export async function startNeteaseImportAuditJob(payload: NeteaseImportAuditRequest): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch("/api/playlist-transfer/netease-import-audit/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动网易云导入歌单清理失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function getNeteaseImportAuditJob(jobId: string): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取网易云导入歌单清理进度失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function cancelNeteaseImportAuditJob(jobId: string): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "取消网易云导入歌单清理失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function exportNeteaseImportAuditJob(jobId: string, format: TransferExportFormat): Promise<TransferExportResult> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ format })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出网易云导入歌单清理结果失败");
  }

  return (await response.json()) as TransferExportResult;
}

export async function createNeteaseImportAuditPlayablePlaylist(jobId: string, name: string): Promise<NeteaseTransferImportResult> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/import/playable`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "创建正常歌曲新歌单失败");
  }

  return (await response.json()) as NeteaseTransferImportResult;
}

export async function createPlaylistCompare(payload: PlaylistCompareRequest): Promise<PlaylistCompareResult> {
  const response = await apiFetch("/api/playlist-transfer/compare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "歌单对比失败");
  }

  return (await response.json()) as PlaylistCompareResult;
}

export async function startPlaylistCompareJob(payload: PlaylistCompareRequest): Promise<PlaylistCompareJob> {
  const response = await apiFetch("/api/playlist-transfer/compare/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动歌单对比任务失败");
  }

  const data = (await response.json()) as { job: PlaylistCompareJob };
  return data.job;
}

export async function getPlaylistCompareJob(jobId: string): Promise<PlaylistCompareJob> {
  const response = await apiFetch(`/api/playlist-transfer/compare/jobs/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单对比进度失败");
  }

  const data = (await response.json()) as { job: PlaylistCompareJob };
  return data.job;
}

export async function exportPlaylistCompare(payload: PlaylistCompareExportRequest): Promise<TransferExportResult> {
  const response = await apiFetch("/api/playlist-transfer/compare/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出歌单对比结果失败");
  }

  return (await response.json()) as TransferExportResult;
}
