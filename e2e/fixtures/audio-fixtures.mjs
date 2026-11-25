/**
 * Creates a deterministic 8 kHz 16-bit mono PCM WAV buffer with a 128-byte JUNK chunk.
 * @param {number} [seconds=1]
 * @returns {Buffer}
 */
export function makeWaveBuffer(seconds = 1) {
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  };

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);

  const sampleCount = 8000 * seconds;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm.writeInt16LE(Math.round(1000 * Math.sin((i * Math.PI) / 10)), i * 2);
  }

  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("JUNK", Buffer.alloc(128)),
    chunk("fmt ", fmt),
    chunk("data", pcm),
  ]);
  return chunk("RIFF", body);
}

/**
 * Encodes a 1-second PCM fixture as EBU RF64 with a ds64 chunk, plus truncated copies
 * for verifying container-completeness rejection in Web Audio decoding.
 */
export function makeRf64Fixture() {
  const riff = makeWaveBuffer(1);
  let dataHeader = 12;
  let align = 0;

  while (dataHeader + 8 <= riff.length) {
    const id = riff.toString("ascii", dataHeader, dataHeader + 4);
    const size = riff.readUInt32LE(dataHeader + 4);
    if (id === "fmt ") {
      align = riff.readUInt16LE(dataHeader + 8 + 12);
    }
    if (id === "data") {
      break;
    }
    dataHeader += 8 + size + (size % 2);
  }

  if (!align || riff.toString("ascii", dataHeader, dataHeader + 4) !== "data") {
    throw new Error("Invalid PCM WAV fixture");
  }

  const sampleBytes = riff.readUInt32LE(dataHeader + 4);
  const frames = sampleBytes / align;

  const header = Buffer.from(riff.subarray(0, 12));
  header.write("RF64", 0);
  header.writeUInt32LE(0xffffffff, 4);

  const sizes = Buffer.alloc(36);
  sizes.write("ds64");
  sizes.writeUInt32LE(28, 4);
  sizes.writeBigUInt64LE(BigInt(riff.length + sizes.length - 8), 8);
  sizes.writeBigUInt64LE(BigInt(sampleBytes), 16);
  sizes.writeBigUInt64LE(BigInt(frames), 24);

  const rf64 = Buffer.concat([header, sizes, riff.subarray(12)]);
  rf64.writeUInt32LE(0xffffffff, dataHeader + sizes.length + 4);

  const quarter = Math.floor(sampleBytes / 4);
  const riffDataStart = dataHeader + 8;
  const rf64DataStart = riffDataStart + sizes.length;

  return {
    riff,
    rf64,
    frames,
    align,
    sampleBytes,
    riffQuarter: riff.subarray(0, riffDataStart + quarter),
    rf64Quarter: rf64.subarray(0, rf64DataStart + quarter),
  };
}
