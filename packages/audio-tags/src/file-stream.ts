import crypto from "node:crypto";
import fsPromises, { type FileHandle } from "node:fs/promises";
import { parseId3v2HeaderLength } from "./bytes.js";
import {
  type AudioCoverData,
  type AudioTagMetadata,
  type FlacMetadataBlock,
  buildFlacHeaderBytes,
} from "./flac.js";
import { type ParsedId3v1Tag, buildMp3Id3v2Tag, isMpegAudioFrameSync, parseId3v1TagSlice } from "./mp3.js";

const STREAM_COPY_CHUNK_BYTES = 64 * 1024;
const MAX_ID3V2_READ_BYTES = 64 * 1024 * 1024;
const MAX_FLAC_METADATA_READ_BYTES = 64 * 1024 * 1024;

export interface InjectAudioFileMetadataOptions {
  formatHint?: string;
  meta: AudioTagMetadata;
  lyricsText: string;
  cover: AudioCoverData | null;
}

export interface InjectAudioFileMetadataResult {
  tagged: boolean;
  format: "flac" | "mp3" | "passthrough";
}

interface StreamRewritePlan {
  format: "flac" | "mp3";
  headerBytes: Uint8Array;
  audioStartOffset: number;
  audioEndOffset: number;
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Uint8Array | null> {
  if (length === 0) return new Uint8Array(0);
  const buf = Buffer.allocUnsafe(length);
  let readTotal = 0;
  while (readTotal < length) {
    const { bytesRead } = await handle.read(buf, readTotal, length - readTotal, position + readTotal);
    if (bytesRead <= 0) {
      return null;
    }
    readTotal += bytesRead;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function writeAll(
  handle: FileHandle,
  buffer: Uint8Array,
  offset = 0,
  length = buffer.byteLength,
): Promise<void> {
  let writtenTotal = 0;
  while (writtenTotal < length) {
    const { bytesWritten } = await handle.write(buffer, offset + writtenTotal, length - writtenTotal);
    if (bytesWritten <= 0) {
      throw new Error("Short write while writing tagged audio file");
    }
    writtenTotal += bytesWritten;
  }
}

function isFlacMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43
  );
}

async function readStackedId3v2TotalLength(handle: FileHandle, fileSize: number): Promise<number> {
  let offset = 0;
  const headerBuf = Buffer.allocUnsafe(10);
  for (let i = 0; i < 16; i += 1) {
    if (offset + 10 >= fileSize) break;
    const { bytesRead } = await handle.read(headerBuf, 0, 10, offset);
    if (bytesRead < 10) break;
    const tagLen = parseId3v2HeaderLength(headerBuf, 0, fileSize - offset);
    if (tagLen <= 0) break;
    offset += tagLen;
  }
  return offset;
}

async function tryPrepareFlacStreamRewrite(
  readHandle: FileHandle,
  fileSize: number,
  options: InjectAudioFileMetadataOptions,
): Promise<StreamRewritePlan | null> {
  const head4 = await readExact(readHandle, 4, 0);
  if (!head4) return null;

  let flacStartOffset = -1;
  if (isFlacMagic(head4)) {
    flacStartOffset = 0;
  } else {
    const id3Len = await readStackedId3v2TotalLength(readHandle, fileSize);
    if (id3Len > 0 && id3Len + 4 <= fileSize) {
      const flacMagic = await readExact(readHandle, 4, id3Len);
      if (flacMagic && isFlacMagic(flacMagic)) {
        flacStartOffset = id3Len;
      }
    }
  }

  if (flacStartOffset < 0) return null;

  const blocks: FlacMetadataBlock[] = [];
  let cursor = flacStartOffset + 4;
  let foundLastBlock = false;
  let totalMetadataBytes = 0;
  const blockHeaderBuf = Buffer.allocUnsafe(4);

  while (cursor + 4 <= fileSize) {
    const { bytesRead } = await readHandle.read(blockHeaderBuf, 0, 4, cursor);
    if (bytesRead < 4) return null;

    const header = blockHeaderBuf[0] ?? 0;
    const type = header & 0x7f;
    // Block type 127 is invalid/forbidden by the FLAC specification
    if (type === 127) {
      return null;
    }

    const length =
      ((blockHeaderBuf[1] ?? 0) << 16) | ((blockHeaderBuf[2] ?? 0) << 8) | (blockHeaderBuf[3] ?? 0);
    cursor += 4;

    if (cursor + length > fileSize) {
      return null;
    }
    totalMetadataBytes += 4 + length;
    if (totalMetadataBytes > MAX_FLAC_METADATA_READ_BYTES) {
      return null;
    }

    const data = await readExact(readHandle, length, cursor);
    if (!data) return null;
    blocks.push({ type, data });
    cursor += length;

    if (header & 0x80) {
      foundLastBlock = true;
      break;
    }
  }

  // Reject malformed FLAC missing the isLast metadata sentinel or missing audio frames
  if (!foundLastBlock || cursor >= fileSize) {
    return null;
  }

  const headerBytes = buildFlacHeaderBytes(blocks, options.meta, options.lyricsText, options.cover);
  if (!headerBytes) return null;

  return {
    format: "flac",
    headerBytes,
    audioStartOffset: cursor,
    audioEndOffset: fileSize,
  };
}

async function tryPrepareMp3StreamRewrite(
  readHandle: FileHandle,
  fileSize: number,
  options: InjectAudioFileMetadataOptions,
): Promise<StreamRewritePlan | null> {
  const id3v2Length = await readStackedId3v2TotalLength(readHandle, fileSize);
  if (id3v2Length > MAX_ID3V2_READ_BYTES) {
    return null;
  }

  const remaining = fileSize - id3v2Length;
  if (remaining < 4) return null;

  const probeLen = Math.min(4104, remaining);
  const probeBytes = await readExact(readHandle, probeLen, id3v2Length);
  if (!probeBytes) return null;

  let scanPos = 0;
  const maxScan = Math.min(probeBytes.length - 4, 4096);
  while (scanPos <= maxScan && probeBytes[scanPos] === 0x00) {
    scanPos += 1;
  }
  if (!isMpegAudioFrameSync(probeBytes, scanPos)) {
    return null;
  }

  const existingId3v2Bytes =
    id3v2Length > 0 ? await readExact(readHandle, id3v2Length, 0) : new Uint8Array(0);
  if (!existingId3v2Bytes) return null;

  let existingV1: ParsedId3v1Tag | null = null;
  let audioEndOffset = fileSize;
  if (fileSize - id3v2Length >= 128) {
    const tailBytes = await readExact(readHandle, 128, fileSize - 128);
    if (!tailBytes) return null;
    const parsedV1 = parseId3v1TagSlice(tailBytes);
    if (parsedV1) {
      existingV1 = parsedV1;
      audioEndOffset = fileSize - 128;
    }
  }

  if (audioEndOffset <= id3v2Length) {
    return null;
  }

  const headerBytes = buildMp3Id3v2Tag(
    existingId3v2Bytes,
    existingV1,
    options.meta,
    options.lyricsText,
    options.cover,
    true,
  );

  return {
    format: "mp3",
    headerBytes,
    audioStartOffset: id3v2Length,
    audioEndOffset,
  };
}

async function streamReplaceWithNewHeader(
  filePath: string,
  readHandle: FileHandle,
  closeReadHandle: () => Promise<void>,
  plan: StreamRewritePlan,
): Promise<void> {
  const tempPath = `${filePath}.tagging.${crypto.randomBytes(6).toString("hex")}`;
  let writeHandle: FileHandle | null = null;
  let writeClosed = false;
  let renamed = false;

  try {
    writeHandle = await fsPromises.open(tempPath, "wx");
    await writeAll(writeHandle, plan.headerBytes);

    const copyBuffer = Buffer.allocUnsafe(STREAM_COPY_CHUNK_BYTES);
    let pos = plan.audioStartOffset;
    while (pos < plan.audioEndOffset) {
      const toRead = Math.min(copyBuffer.length, plan.audioEndOffset - pos);
      const { bytesRead } = await readHandle.read(copyBuffer, 0, toRead, pos);
      if (bytesRead <= 0) {
        throw new Error("Unexpected EOF while streaming audio frames");
      }
      await writeAll(writeHandle, copyBuffer, 0, bytesRead);
      pos += bytesRead;
    }

    await writeHandle.close();
    writeClosed = true;
    await closeReadHandle();

    await fsPromises.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (writeHandle && !writeClosed) {
      await writeHandle.close().catch(() => {});
    }
    if (!renamed) {
      await fsPromises.unlink(tempPath).catch(() => {});
    }
  }
}

/**
 * Streaming metadata injection for FLAC and MP3 files without loading the full audio payload into memory.
 * Only headers/metadata blocks (and optional trailing 128-byte ID3v1) are read into memory; audio frames are
 * stream-copied in fixed 64 KiB chunks into a sibling temp file and atomically renamed into place.
 */
export async function injectAudioFileMetadata(
  filePath: string,
  options: InjectAudioFileMetadataOptions,
): Promise<InjectAudioFileMetadataResult> {
  const normalizedHint = options.formatHint?.trim().toLowerCase().replace(/^\./, "");
  if (normalizedHint && normalizedHint !== "flac" && normalizedHint !== "mp3") {
    return { tagged: false, format: "passthrough" };
  }

  const readHandle = await fsPromises.open(filePath, "r");
  let readClosed = false;
  const closeReadHandle = async () => {
    if (!readClosed) {
      readClosed = true;
      await readHandle.close();
    }
  };

  try {
    const { size: fileSize } = await readHandle.stat();
    if (fileSize < 8) {
      return { tagged: false, format: "passthrough" };
    }

    let plan: StreamRewritePlan | null = null;
    if (!normalizedHint || normalizedHint === "flac") {
      plan = await tryPrepareFlacStreamRewrite(readHandle, fileSize, options);
    }
    if (!plan && (!normalizedHint || normalizedHint === "mp3")) {
      plan = await tryPrepareMp3StreamRewrite(readHandle, fileSize, options);
    }
    if (!plan) {
      return { tagged: false, format: "passthrough" };
    }

    await streamReplaceWithNewHeader(filePath, readHandle, closeReadHandle, plan);
    return { tagged: true, format: plan.format };
  } finally {
    if (!readClosed) {
      await readHandle.close().catch(() => {});
    }
  }
}
