import { concatBytes, getId3v2TagLength, writeUint32BigEndian, writeUint32LittleEndian } from "./bytes.js";

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

function findFlacStartOffset(bytes: Uint8Array): number {
  const isFlacAt = (offset: number) =>
    bytes.length >= offset + 4 &&
    bytes[offset] === 0x66 &&
    bytes[offset + 1] === 0x4c &&
    bytes[offset + 2] === 0x61 &&
    bytes[offset + 3] === 0x43;

  if (isFlacAt(0)) return 0;

  const id3Length = getId3v2TagLength(bytes);
  if (id3Length > 0 && isFlacAt(id3Length)) {
    return id3Length;
  }

  return -1;
}

export function isFlacBytes(input: Uint8Array): boolean {
  return findFlacStartOffset(input) >= 0;
}

function buildVorbisCommentBlock(meta: AudioTagMetadata, lyricsText: string): Uint8Array {
  const artistText = meta.artists?.length ? meta.artists.map((a) => a.name).join("; ") : meta.artist;
  const pairs: Array<[string, string]> = [
    ["TITLE", meta.title],
    ["ARTIST", artistText],
    ["ALBUM", meta.album],
    ["ALBUMARTIST", meta.artist],
    ["TRACKVAULT_SOURCE", meta.source],
  ];
  if (lyricsText.trim()) {
    pairs.push(["LYRICS", lyricsText.trim()]);
  }

  const encodedComments = pairs
    .filter(([, value]) => Boolean(value.trim()))
    .map(([key, value]) => textEncoder.encode(`${key}=${value.trim()}`));

  const vendor = textEncoder.encode("TrackVault");
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
  return concatBytes([
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
}

function buildFlacMetadataBlock(type: number, data: Uint8Array, isLast: boolean): Uint8Array {
  if (data.length > 0xffffff) {
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

export function injectFlacMetadata(
  input: Uint8Array,
  meta: AudioTagMetadata,
  lyricsText: string,
  cover: AudioCoverData | null,
): Uint8Array {
  const flacStartOffset = findFlacStartOffset(input);
  if (flacStartOffset < 0) return input;

  const bytes = input.subarray(flacStartOffset);
  const blocks: Array<{ type: number; data: Uint8Array }> = [];
  let offset = 4;
  let foundLastBlock = false;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset] ?? 0;
    const type = header & 0x7f;
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

  const streamInfo = blocks.find((b) => b.type === 0);
  if (!streamInfo) return input;

  const pictureBlock = buildFlacPictureBlock(cover);
  const metadataBlocks = [
    streamInfo,
    { type: 4, data: buildVorbisCommentBlock(meta, lyricsText) },
    ...(pictureBlock ? [{ type: 6, data: pictureBlock }] : []),
    ...blocks.filter((b) => b !== streamInfo && b.type !== 4 && b.type !== 6),
  ];

  const encodedBlocks = metadataBlocks.map((block, index) =>
    buildFlacMetadataBlock(block.type, block.data, index === metadataBlocks.length - 1),
  );

  return concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43]), ...encodedBlocks, bytes.subarray(offset)]);
}
