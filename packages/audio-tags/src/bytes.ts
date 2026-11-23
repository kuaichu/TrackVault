export function writeUint32LittleEndian(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

export function writeUint32BigEndian(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

export function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/**
 * Safely parses an ID3v2 10-byte header at startOffset and returns the full tag byte length
 * (header + body + optional v2.4 footer) when strictly smaller than `availableBytes`, or 0 otherwise.
 */
export function parseId3v2HeaderLength(
  bytes: Uint8Array,
  startOffset = 0,
  availableBytes = bytes.length - startOffset,
): number {
  if (bytes.length < startOffset + 10) return 0;
  const b0 = bytes[startOffset] ?? 0;
  const b1 = bytes[startOffset + 1] ?? 0;
  const b2 = bytes[startOffset + 2] ?? 0;
  const major = bytes[startOffset + 3] ?? 0;
  const revision = bytes[startOffset + 4] ?? 0;
  const flags = bytes[startOffset + 5] ?? 0;
  const s0 = bytes[startOffset + 6] ?? 0;
  const s1 = bytes[startOffset + 7] ?? 0;
  const s2 = bytes[startOffset + 8] ?? 0;
  const s3 = bytes[startOffset + 9] ?? 0;

  if (b0 !== 0x49 || b1 !== 0x44 || b2 !== 0x33) return 0;
  // Valid ID3v2 major versions are 2, 3, or 4; revision 0xff is forbidden by spec.
  if (major < 2 || major > 4 || revision === 0xff) return 0;
  if (s0 > 0x7f || s1 > 0x7f || s2 > 0x7f || s3 > 0x7f) return 0;

  const tagSize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
  const hasFooter = major === 4 && Boolean(flags & 0x10);
  const total = 10 + tagSize + (hasFooter ? 10 : 0);

  // Never exceed available container size (prevents malformed headers from stripping the entire audio stream).
  if (total < 10 || total >= availableBytes) {
    return 0;
  }
  return total;
}

/**
 * Safely returns the ID3v2 header + body (+ optional footer) length at startOffset, or 0 if invalid/out-of-bounds.
 * Supports 10-byte empty ID3v2 tags (tagSize === 0) as long as audio bytes follow.
 */
export function getId3v2TagLength(bytes: Uint8Array, startOffset = 0): number {
  return parseId3v2HeaderLength(bytes, startOffset, bytes.length - startOffset);
}

/**
 * Sums the lengths of one or more consecutive stacked ID3v2 tags at the start of a file.
 */
export function getAllId3v2TagsLength(bytes: Uint8Array): number {
  let offset = 0;
  for (let i = 0; i < 16; i += 1) {
    const len = getId3v2TagLength(bytes, offset);
    if (len <= 0) break;
    offset += len;
  }
  return offset;
}
