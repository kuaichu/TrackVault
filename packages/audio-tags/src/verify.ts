import fsPromises, { type FileHandle } from "node:fs/promises";
import { getAllId3v2TagsLength, parseId3v2HeaderLength, readUint32BigEndian } from "./bytes.js";
import { isFlacBytes } from "./flac.js";
import { getMpegFrameByteLength, isMp3Bytes, isMpegAudioFrameSync } from "./mp3.js";

const MAX_WAV_CHUNKS = 64;
const MAX_DS64_TABLE_ENTRIES = 64;

export function isAacAdtsSync(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4) return false;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  // 12-bit syncword 0xFFF, layer == 00, sample frequency index != 0x0F (forbidden)
  return b0 === 0xff && (b1 & 0xf6) === 0xf0 && ((b2 >>> 2) & 0x0f) !== 0x0f;
}

/**
 * J01: Magic-byte signature verification covering MP3, FLAC, M4A/MP4 (ftyp at offset 4), WAV, OGG, and AAC ADTS.
 */
export function hasValidAudioSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (isMp3Bytes(bytes) || isFlacBytes(bytes)) return true;

  // M4A / MP4 ISO Base Media File Format ("ftyp" at offset 4) — protects QQ C400 streams
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return true;
  }

  // WAV ("RIFF"/"RF64" ... "WAVE")
  if (
    bytes.length >= 12 &&
    ((bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) ||
      (bytes[0] === 0x52 && bytes[1] === 0x46 && bytes[2] === 0x36 && bytes[3] === 0x34)) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return true;
  }

  // OGG ("OggS")
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return true;
  }

  // AAC ADTS (optional leading ID3v2 + zero padding followed by 0xFFF sync + layer == 00)
  let pos = getAllId3v2TagsLength(bytes);
  const maxScan = Math.min(bytes.length - 4, pos + 4096);
  while (pos <= maxScan && bytes[pos] === 0x00) {
    pos += 1;
  }
  if (isAacAdtsSync(bytes, pos)) {
    return true;
  }

  return false;
}

export async function verifyWavContainer(
  handle: FileHandle,
  fileSize: number,
  isRf64 = false,
): Promise<boolean> {
  if (fileSize < 44) return false;

  const topHeader = Buffer.alloc(12);
  const topRead = await handle.read(topHeader, 0, 12, 0);
  if (topRead.bytesRead < 12) return false;

  const riffSize32 = topHeader.readUInt32LE(4);
  const totalBytes = BigInt(fileSize);
  let declaredEnd: bigint = totalBytes;

  if (!isRf64) {
    if (riffSize32 === 0xffffffff || riffSize32 < 36) return false;
    declaredEnd = 8n + BigInt(riffSize32);
    if (declaredEnd > totalBytes) {
      return false;
    }
  }

  let offset = 12;
  let seenFmt = false;
  let seenData = false;
  let seenDs64 = false;
  let ds64DataSize: bigint | null = null;
  const ds64ChunkSizes = new Map<string, bigint>();
  let blockAlign = 1;
  const chunkHeader = Buffer.alloc(8);
  const fmtBuf = Buffer.alloc(16);
  const ds64FixedBuf = Buffer.alloc(28);

  for (
    let hop = 0;
    hop < MAX_WAV_CHUNKS && BigInt(offset + 8) <= declaredEnd && offset + 8 <= fileSize;
    hop += 1
  ) {
    const { bytesRead } = await handle.read(chunkHeader, 0, 8, offset);
    if (bytesRead < 8) return false;

    const id = chunkHeader.toString("ascii", 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);

    if (id === "ds64") {
      if (chunkSize === 0xffffffff || chunkSize < 28 || offset + 8 + chunkSize > fileSize) {
        return false;
      }
      const ds64Read = await handle.read(ds64FixedBuf, 0, 28, offset + 8);
      if (ds64Read.bytesRead < 28) return false;
      const riffSize64 = ds64FixedBuf.readBigUInt64LE(0);
      const dataSize64 = ds64FixedBuf.readBigUInt64LE(8);
      const tableLength = ds64FixedBuf.readUInt32LE(24);
      if (8n + riffSize64 > totalBytes) {
        return false;
      }
      if (isRf64) {
        declaredEnd = 8n + riffSize64;
      }
      if (tableLength > MAX_DS64_TABLE_ENTRIES || 28 + tableLength * 12 > chunkSize) {
        return false;
      }
      if (tableLength > 0) {
        const tableBytes = tableLength * 12;
        const tableBuf = Buffer.alloc(tableBytes);
        const tableRead = await handle.read(tableBuf, 0, tableBytes, offset + 8 + 28);
        if (tableRead.bytesRead < tableBytes) return false;
        for (let idx = 0; idx < tableLength; idx += 1) {
          const entryOffset = idx * 12;
          const entryId = tableBuf.toString("ascii", entryOffset, entryOffset + 4);
          const entrySize = tableBuf.readBigUInt64LE(entryOffset + 4);
          ds64ChunkSizes.set(entryId, entrySize);
        }
      }
      seenDs64 = true;
      ds64DataSize = dataSize64;
      offset += 8 + chunkSize + (chunkSize & 1);
      continue;
    }

    if (id === "fmt ") {
      if (chunkSize === 0xffffffff || chunkSize < 16 || offset + 8 + chunkSize > fileSize) return false;
      const fmtRead = await handle.read(fmtBuf, 0, 16, offset + 8);
      if (fmtRead.bytesRead < 16) return false;
      const audioFormat = fmtBuf.readUInt16LE(0);
      const channels = fmtBuf.readUInt16LE(2);
      const sampleRate = fmtBuf.readUInt32LE(4);
      const align = fmtBuf.readUInt16LE(12);
      if (audioFormat === 0 || channels < 1 || channels > 32 || sampleRate === 0 || align < 1) {
        return false;
      }
      seenFmt = true;
      blockAlign = align;
      offset += 8 + chunkSize + (chunkSize & 1);
      continue;
    }

    if (id === "data") {
      if (!seenFmt) return false;
      if (isRf64 && !seenDs64) return false;
      let actualDataSize: bigint;
      if (chunkSize === 0xffffffff) {
        if (!isRf64 || !seenDs64 || ds64DataSize === null) {
          return false;
        }
        actualDataSize = ds64DataSize;
      } else {
        actualDataSize = BigInt(chunkSize);
      }
      if (
        actualDataSize < BigInt(blockAlign) ||
        BigInt(offset + 8) + actualDataSize > totalBytes ||
        BigInt(offset + 8) + actualDataSize > declaredEnd
      ) {
        return false;
      }
      seenData = true;
      const nextDataOffset = BigInt(offset + 8) + actualDataSize + (actualDataSize & 1n);
      if (nextDataOffset >= declaredEnd || nextDataOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      offset = Number(nextDataOffset);
      continue;
    }

    let effectiveChunkSize: bigint;
    if (chunkSize === 0xffffffff) {
      const mapped = isRf64 && seenDs64 ? ds64ChunkSizes.get(id) : undefined;
      if (mapped === undefined) return false;
      effectiveChunkSize = mapped;
    } else {
      effectiveChunkSize = BigInt(chunkSize);
    }

    const nextOffset = BigInt(offset + 8) + effectiveChunkSize + (effectiveChunkSize & 1n);
    if (
      BigInt(offset + 8) + effectiveChunkSize > totalBytes ||
      BigInt(offset + 8) + effectiveChunkSize > declaredEnd ||
      nextOffset > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return false;
    }
    offset = Number(nextOffset);
  }

  return seenFmt && seenData && (!isRf64 || seenDs64);
}

function isPlausiblePostMpegBoundary(bytes: Uint8Array, offset: number): boolean {
  if (offset + 4 > bytes.length) return true;
  if (isMpegAudioFrameSync(bytes, offset)) return true;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  // Allow zero padding, trailing ID3v1 ("TAG"), APEv2 ("APET"), Lyrics3 ("LYRI"), or stacked ID3v2 ("ID3")
  if (b0 === 0x00) return true;
  if (b0 === 0x54 && b1 === 0x41 && b2 === 0x47) return true;
  if (b0 === 0x41 && b1 === 0x50 && b2 === 0x45 && b3 === 0x54) return true;
  if (b0 === 0x4c && b1 === 0x59 && b2 === 0x52 && b3 === 0x49) return true;
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return true;
  return false;
}

/**
 * J01: Bounded offset-aware audio file signature & first-frame / container header completeness check.
 * Skips up to 16 consecutive ID3v2 headers (requiring each declared length < remaining fileSize),
 * then reads at most 4,096 bytes at the actual audio stream offset and verifies that at least one complete
 * MPEG/ADTS frame or valid FLAC/M4A/WAV/OGG container header is present (rejecting truncated partial frames).
 */
export async function verifyDownloadedAudioFile(filePath: string, knownFileSize?: number): Promise<boolean> {
  const fileSize = knownFileSize ?? (await fsPromises.stat(filePath)).size;
  if (fileSize < 8) return false;

  const handle = await fsPromises.open(filePath, "r");
  try {
    let audioOffset = 0;
    const headerBuf = Buffer.alloc(10);
    for (let i = 0; i < 16; i += 1) {
      if (audioOffset + 10 >= fileSize) break;
      const { bytesRead } = await handle.read(headerBuf, 0, 10, audioOffset);
      if (bytesRead < 10) break;
      const tagLen = parseId3v2HeaderLength(headerBuf, 0, fileSize - audioOffset);
      if (tagLen <= 0) break;
      audioOffset += tagLen;
    }

    const remainingTotal = fileSize - audioOffset;
    const readLen = Math.min(4096, remainingTotal);
    if (readLen < 7) return false;

    const windowBuf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(windowBuf, 0, readLen, audioOffset);
    if (bytesRead < 7) return false;
    const windowBytes = new Uint8Array(windowBuf.buffer, windowBuf.byteOffset, bytesRead);

    // 1. FLAC: 4B "fLaC" + 4B metadata block header (type 0 STREAMINFO) + 34B STREAMINFO >= 42 bytes
    if (isFlacBytes(windowBytes)) {
      if (remainingTotal < 42 || windowBytes.length < 8) return false;
      const firstBlockType = (windowBytes[4] ?? 0x7f) & 0x7f;
      return firstBlockType === 0;
    }

    if (audioOffset === 0) {
      // 2. M4A / MP4: "ftyp" at offset 4, declared box length >= 8 and <= fileSize
      if (
        windowBytes.length >= 8 &&
        windowBytes[4] === 0x66 &&
        windowBytes[5] === 0x74 &&
        windowBytes[6] === 0x79 &&
        windowBytes[7] === 0x70
      ) {
        const ftypSize = readUint32BigEndian(windowBytes, 0);
        if (ftypSize === 1) {
          return windowBytes.length >= 16 && remainingTotal >= 16;
        }
        return ftypSize >= 8 && ftypSize <= remainingTotal;
      }

      // 3. WAV: "RIFF"/"RF64" ... "WAVE" + verified complete fmt & data chunks within fileSize
      const isRiff =
        windowBytes[0] === 0x52 &&
        windowBytes[1] === 0x49 &&
        windowBytes[2] === 0x46 &&
        windowBytes[3] === 0x46;
      const isRf64 =
        windowBytes[0] === 0x52 &&
        windowBytes[1] === 0x46 &&
        windowBytes[2] === 0x36 &&
        windowBytes[3] === 0x34;
      if (
        windowBytes.length >= 12 &&
        (isRiff || isRf64) &&
        windowBytes[8] === 0x57 &&
        windowBytes[9] === 0x41 &&
        windowBytes[10] === 0x56 &&
        windowBytes[11] === 0x45
      ) {
        return await verifyWavContainer(handle, fileSize, isRf64);
      }

      // 4. OGG: "OggS" 27-byte page header + segment table
      if (
        windowBytes[0] === 0x4f &&
        windowBytes[1] === 0x67 &&
        windowBytes[2] === 0x67 &&
        windowBytes[3] === 0x53
      ) {
        if (windowBytes.length < 27 || remainingTotal < 27) return false;
        const pageSegments = windowBytes[26] ?? 0;
        return remainingTotal >= 27 + pageSegments;
      }
    }

    // 5. MPEG audio (MP3) or AAC ADTS (after optional leading zero padding)
    let pos = 0;
    const maxScan = windowBytes.length - 4;
    while (pos <= maxScan && windowBytes[pos] === 0x00) {
      pos += 1;
    }

    const remainingFromFrame = fileSize - (audioOffset + pos);

    if (isMpegAudioFrameSync(windowBytes, pos)) {
      const frameByteLength = getMpegFrameByteLength(windowBytes, pos);
      if (frameByteLength === null) return false;
      const minRequiredBytes = frameByteLength > 0 ? frameByteLength : 24;
      if (remainingFromFrame < minRequiredBytes) {
        return false;
      }
      if (frameByteLength > 0 && remainingFromFrame - frameByteLength >= 4) {
        const nextOffsetInWindow = pos + frameByteLength;
        if (
          nextOffsetInWindow + 4 <= windowBytes.length &&
          !isPlausiblePostMpegBoundary(windowBytes, nextOffsetInWindow)
        ) {
          return false;
        }
      }
      return true;
    }

    if (isAacAdtsSync(windowBytes, pos)) {
      if (windowBytes.length < pos + 7) return false;
      const b3 = windowBytes[pos + 3] ?? 0;
      const b4 = windowBytes[pos + 4] ?? 0;
      const b5 = windowBytes[pos + 5] ?? 0;
      const aacFrameLength = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >>> 5) & 0x07);
      return aacFrameLength >= 7 && remainingFromFrame >= aacFrameLength;
    }

    return false;
  } finally {
    await handle.close();
  }
}
