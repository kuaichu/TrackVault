export function writeUint32LittleEndian(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

export function writeUint32BigEndian(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
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
 * Safely returns the ID3v2 header + body (+ optional footer) length, or 0 if invalid/out-of-bounds.
 */
export function getId3v2TagLength(bytes: Uint8Array): number {
  if (bytes.length < 10) return 0;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  const b2 = bytes[2] ?? 0;
  const major = bytes[3] ?? 0;
  const revision = bytes[4] ?? 0;
  const flags = bytes[5] ?? 0;
  const s0 = bytes[6] ?? 0;
  const s1 = bytes[7] ?? 0;
  const s2 = bytes[8] ?? 0;
  const s3 = bytes[9] ?? 0;

  if (b0 !== 0x49 || b1 !== 0x44 || b2 !== 0x33) return 0;
  // Valid ID3v2 major versions are 2, 3, or 4; revision 0xff is forbidden by spec.
  if (major < 2 || major > 4 || revision === 0xff) return 0;
  if (s0 > 0x7f || s1 > 0x7f || s2 > 0x7f || s3 > 0x7f) return 0;

  const tagSize = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3;
  const hasFooter = major === 4 && Boolean(flags & 0x10);
  const total = 10 + tagSize + (hasFooter ? 10 : 0);

  // Never exceed the file buffer (prevents malformed headers from stripping the entire audio stream).
  if (total <= 10 || total >= bytes.length) {
    return 0;
  }
  return total;
}
