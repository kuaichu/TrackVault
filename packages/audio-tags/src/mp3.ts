import { concatBytes, getId3v2TagLength, writeUint32BigEndian } from "./bytes.js";
import type { AudioCoverData, AudioTagMetadata } from "./flac.js";

const textEncoder = new TextEncoder();

function writeSyncsafeUint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}

function isMpegAudioFrameSync(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 2) return false;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  // 11-bit sync word (0xFFE0), MPEG version not reserved (bits 4..3 != 01), layer not reserved (bits 2..1 != 00)
  return b0 === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0x00;
}

export function isMp3Bytes(input: Uint8Array): boolean {
  const id3v2Length = getId3v2TagLength(input);
  const offset = id3v2Length > 0 ? id3v2Length : 0;
  return isMpegAudioFrameSync(input, offset);
}

function stripExistingId3Tags(bytes: Uint8Array): Uint8Array {
  const id3v2Length = getId3v2TagLength(bytes);
  const withoutId3v2 = id3v2Length > 0 ? bytes.subarray(id3v2Length) : bytes;
  const hasId3v1 =
    withoutId3v2.length >= 128 &&
    withoutId3v2[withoutId3v2.length - 128] === 0x54 &&
    withoutId3v2[withoutId3v2.length - 127] === 0x41 &&
    withoutId3v2[withoutId3v2.length - 126] === 0x47;

  return hasId3v1 ? withoutId3v2.subarray(0, withoutId3v2.length - 128) : withoutId3v2;
}

function encodeUtf16Le(text: string, withBom = false): Uint8Array {
  const output = new Uint8Array((withBom ? 2 : 0) + text.length * 2);
  let offset = 0;
  if (withBom) {
    output[offset++] = 0xff;
    output[offset++] = 0xfe;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    output[offset++] = code & 0xff;
    output[offset++] = (code >>> 8) & 0xff;
  }
  return output;
}

function buildFrame(id: string, data: Uint8Array): Uint8Array {
  if (data.length > 0xffffffff) {
    throw new Error("ID3 frame exceeds max size");
  }
  return concatBytes([
    textEncoder.encode(id),
    writeUint32BigEndian(data.length),
    new Uint8Array([0x00, 0x00]),
    data,
  ]);
}

function buildTextFrame(id: string, value: string | null | undefined): Uint8Array | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return buildFrame(id, concatBytes([new Uint8Array([0x01]), encodeUtf16Le(normalized, true)]));
}

function buildUserTextFrame(description: string, value: string | null | undefined): Uint8Array | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  return buildFrame(
    "TXXX",
    concatBytes([
      new Uint8Array([0x01]),
      encodeUtf16Le(description, true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalized, true),
    ]),
  );
}

function buildLyricsFrame(lyricsText: string): Uint8Array | null {
  const normalized = lyricsText.trim();
  if (!normalized) return null;
  return buildFrame(
    "USLT",
    concatBytes([
      new Uint8Array([0x01]),
      textEncoder.encode("XXX"),
      encodeUtf16Le("", true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalized, true),
    ]),
  );
}

function buildPictureFrame(cover: AudioCoverData | null): Uint8Array | null {
  if (!cover || cover.bytes.length === 0) return null;
  const mimeType = textEncoder.encode(cover.mimeType.split(";")[0]?.trim() || "image/jpeg");
  return buildFrame(
    "APIC",
    concatBytes([new Uint8Array([0x00]), mimeType, new Uint8Array([0x00, 0x03, 0x00]), cover.bytes]),
  );
}

export function injectMp3Metadata(
  input: Uint8Array,
  meta: AudioTagMetadata,
  lyricsText: string,
  cover: AudioCoverData | null,
): Uint8Array {
  // Never corrupt non-MP3 payloads (e.g. M4A streams or HTML error pages)
  if (!isMp3Bytes(input)) {
    return input;
  }

  const artistText = meta.artists?.length ? meta.artists.map((a) => a.name).join("; ") : meta.artist;

  const frames = [
    buildTextFrame("TIT2", meta.title),
    buildTextFrame("TPE1", artistText),
    buildTextFrame("TALB", meta.album),
    buildTextFrame("TPE2", meta.artist),
    buildUserTextFrame("TRACKVAULT_SOURCE", meta.source),
    buildUserTextFrame("LYRICS", lyricsText),
    buildLyricsFrame(lyricsText),
    buildPictureFrame(cover),
  ].filter((frame): frame is Uint8Array => frame !== null);

  const body = concatBytes(frames);
  if (body.length > 0x0fffffff) {
    throw new Error("ID3 tag body exceeds syncsafe limit");
  }

  const header = concatBytes([
    textEncoder.encode("ID3"),
    new Uint8Array([0x03, 0x00, 0x00]),
    writeSyncsafeUint32(body.length),
  ]);

  return concatBytes([header, body, stripExistingId3Tags(input)]);
}
