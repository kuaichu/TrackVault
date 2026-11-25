import {
  concatBytes,
  getAllId3v2TagsLength,
  readUint32LittleEndian,
  writeUint32BigEndian,
  writeUint32LittleEndian,
} from "./bytes.js";

export interface AudioTagMetadata {
  title: string;
  artist: string;
  artists?: ReadonlyArray<{ name: string }>;
  album: string;
  source: string;
}

export interface AudioCoverData {
  mimeType: string;
  bytes: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });
const MAX_FLAC_METADATA_BLOCK_BYTES = 0xffffff;

function findFlacStartOffset(bytes: Uint8Array): number {
  const isFlacAt = (offset: number) =>
    bytes.length >= offset + 4 &&
    bytes[offset] === 0x66 &&
    bytes[offset + 1] === 0x4c &&
    bytes[offset + 2] === 0x61 &&
    bytes[offset + 3] === 0x43;

  if (isFlacAt(0)) return 0;

  const id3Length = getAllId3v2TagsLength(bytes);
  if (id3Length > 0 && isFlacAt(id3Length)) {
    return id3Length;
  }

  return -1;
}

export function isFlacBytes(input: Uint8Array): boolean {
  return findFlacStartOffset(input) >= 0;
}

function parseExistingVorbisComments(data: Uint8Array | undefined): {
  vendor: string;
  entries: Array<{ key: string; raw: string }>;
} {
  if (!data || data.length < 8) {
    return { vendor: "TrackVault", entries: [] };
  }
  let offset = 0;
  const vendorLen = readUint32LittleEndian(data, offset);
  offset += 4;
  if (offset + vendorLen + 4 > data.length) {
    return { vendor: "TrackVault", entries: [] };
  }
  const vendor = textDecoder.decode(data.subarray(offset, offset + vendorLen)) || "TrackVault";
  offset += vendorLen;

  const count = readUint32LittleEndian(data, offset);
  offset += 4;
  const entries: Array<{ key: string; raw: string }> = [];

  for (let i = 0; i < count && offset + 4 <= data.length; i += 1) {
    const len = readUint32LittleEndian(data, offset);
    offset += 4;
    if (offset + len > data.length) break;
    const raw = textDecoder.decode(data.subarray(offset, offset + len));
    offset += len;
    const eq = raw.indexOf("=");
    if (eq > 0) {
      entries.push({ key: raw.slice(0, eq).toUpperCase(), raw });
    }
  }

  return { vendor, entries };
}

function buildVorbisCommentBlock(
  meta: AudioTagMetadata,
  lyricsText: string,
  existingData?: Uint8Array,
): Uint8Array {
  const existing = parseExistingVorbisComments(existingData);
  const artistText = meta.artists?.length ? meta.artists.map((a) => a.name).join("; ") : meta.artist;

  const replacements: Array<[string, string]> = [
    ["TITLE", meta.title],
    ["ARTIST", artistText],
    ["ALBUM", meta.album],
    ["ALBUMARTIST", meta.artist],
    ["TRACKVAULT_SOURCE", meta.source],
  ];
  if (lyricsText.trim()) {
    replacements.push(["LYRICS", lyricsText.trim()]);
  }

  const activeReplacements = replacements.filter(([, value]) => Boolean(value.trim()));
  const replacedKeys = new Set(activeReplacements.map(([key]) => key.toUpperCase()));

  const preservedComments = existing.entries
    .filter((entry) => !replacedKeys.has(entry.key))
    .map((entry) => textEncoder.encode(entry.raw));

  const newComments = activeReplacements.map(([key, value]) => textEncoder.encode(`${key}=${value.trim()}`));
  const encodedComments = [...preservedComments, ...newComments];

  const vendor = textEncoder.encode(existing.vendor || "TrackVault");
  const chunks: Uint8Array[] = [
    writeUint32LittleEndian(vendor.length),
    vendor,
    writeUint32LittleEndian(encodedComments.length),
  ];

  for (const comment of encodedComments) {
    chunks.push(writeUint32LittleEndian(comment.length), comment);
  }
  return concatBytes(chunks);
}

function buildFlacPictureBlock(cover: AudioCoverData | null): Uint8Array | null {
  if (!cover || cover.bytes.length === 0) return null;
  const mimeType = textEncoder.encode(cover.mimeType.split(";")[0]?.trim() || "image/jpeg");
  const description = new Uint8Array();
  const block = concatBytes([
    writeUint32BigEndian(3), // Front cover
    writeUint32BigEndian(mimeType.length),
    mimeType,
    writeUint32BigEndian(description.length),
    description,
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(0),
    writeUint32BigEndian(cover.bytes.length),
    cover.bytes,
  ]);
  // FLAC metadata blocks have a 24-bit length limit (16,777,215 bytes); skip oversized covers gracefully
  if (block.length > MAX_FLAC_METADATA_BLOCK_BYTES) {
    return null;
  }
  return block;
}

function buildFlacMetadataBlock(type: number, data: Uint8Array, isLast: boolean): Uint8Array {
  if (data.length > MAX_FLAC_METADATA_BLOCK_BYTES) {
    throw new Error("FLAC metadata block exceeds 16MB limit");
  }
  return concatBytes([
    new Uint8Array([
      (isLast ? 0x80 : 0) | (type & 0x7f),
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
    ]),
    data,
  ]);
}

export interface FlacMetadataBlock {
  type: number;
  data: Uint8Array;
}

export function buildFlacHeaderBytes(
  blocks: readonly FlacMetadataBlock[],
  meta: AudioTagMetadata,
  lyricsText: string,
  cover: AudioCoverData | null,
): Uint8Array | null {
  const streamInfo = blocks.find((b) => b.type === 0);
  if (!streamInfo) return null;

  const existingVorbis = blocks.find((b) => b.type === 4);
  const mergedVorbis = buildVorbisCommentBlock(meta, lyricsText, existingVorbis?.data);
  const vorbisBlock =
    mergedVorbis.length <= MAX_FLAC_METADATA_BLOCK_BYTES ? mergedVorbis : existingVorbis?.data;

  const pictureBlock = buildFlacPictureBlock(cover);
  const existingPictures = blocks.filter((b) => b.type === 6);
  const pictureBlocksToWrite = pictureBlock ? [{ type: 6, data: pictureBlock }] : existingPictures;

  const metadataBlocks = [
    streamInfo,
    ...(vorbisBlock ? [{ type: 4, data: vorbisBlock }] : []),
    ...pictureBlocksToWrite,
    ...blocks.filter((b) => b !== streamInfo && b.type !== 4 && b.type !== 6),
  ];

  const encodedBlocks = metadataBlocks.map((block, index) =>
    buildFlacMetadataBlock(block.type, block.data, index === metadataBlocks.length - 1),
  );

  return concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...encodedBlocks]);
}

export function injectFlacMetadata(
  input: Uint8Array,
  meta: AudioTagMetadata,
  lyricsText: string,
  cover: AudioCoverData | null,
): Uint8Array {
  const flacStartOffset = findFlacStartOffset(input);
  if (flacStartOffset < 0) return input;

  const bytes = input.subarray(flacStartOffset);
  const blocks: FlacMetadataBlock[] = [];
  let offset = 4;
  let foundLastBlock = false;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset] ?? 0;
    const type = header & 0x7f;
    // Block type 127 is invalid/forbidden by the FLAC specification
    if (type === 127) {
      return input;
    }
    const length =
      ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    offset += 4;

    if (offset + length > bytes.length) {
      return input;
    }

    blocks.push({ type, data: bytes.subarray(offset, offset + length) });
    offset += length;

    if (header & 0x80) {
      foundLastBlock = true;
      break;
    }
  }

  // Reject malformed FLAC missing the isLast metadata sentinel to avoid dropping audio frames.
  if (!foundLastBlock || offset >= bytes.length) {
    return input;
  }

  const headerBytes = buildFlacHeaderBytes(blocks, meta, lyricsText, cover);
  if (!headerBytes) return input;

  return concatBytes([headerBytes, bytes.subarray(offset)]);
}
