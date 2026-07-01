import type { Song, SongLyrics } from "./types.js";

export type FlacCoverData = {
  mimeType: string;
  bytes: Uint8Array;
};

function formatLrcTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safeSeconds / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const centiseconds = Math.floor((safeSeconds - Math.floor(safeSeconds)) * 100);
  return `[${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}]`;
}

export function formatLyricsAsLrc(lyrics: SongLyrics | null) {
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

export function isFlacBytes(input: Uint8Array) {
  return findFlacStartOffset(input) >= 0;
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

function buildFlacPictureBlock(cover: FlacCoverData | null) {
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

export function injectFlacMetadata(input: Uint8Array, song: Song, lyricsText: string, cover: FlacCoverData | null) {
  const flacStartOffset = findFlacStartOffset(input);
  if (flacStartOffset < 0) {
    return input;
  }

  const bytes = input.slice(flacStartOffset);
  const blocks: Array<{ type: number; data: Uint8Array }> = [];
  let offset = 4;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset];
    const type = header & 0x7f;
    const length = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;

    if (offset + length > bytes.length) {
      return input;
    }

    blocks.push({ type, data: bytes.slice(offset, offset + length) });
    offset += length;

    if (header & 0x80) {
      break;
    }
  }

  const streamInfo = blocks.find((block) => block.type === 0);
  if (!streamInfo) {
    return input;
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
