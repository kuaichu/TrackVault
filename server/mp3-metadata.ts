import type { Song } from "./types.js";

export type Mp3CoverData = {
  mimeType: string;
  bytes: Uint8Array;
};

const textEncoder = new TextEncoder();

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

function writeUint32BigEndian(value: number) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function writeSyncsafeUint32(value: number) {
  return new Uint8Array([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f
  ]);
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

function stripExistingId3Tags(bytes: Uint8Array) {
  const id3v2Length = getId3v2TagLength(bytes);
  const withoutId3v2 = id3v2Length > 0 ? bytes.slice(id3v2Length) : bytes;
  const hasId3v1 = withoutId3v2.length >= 128 &&
    withoutId3v2[withoutId3v2.length - 128] === 0x54 &&
    withoutId3v2[withoutId3v2.length - 127] === 0x41 &&
    withoutId3v2[withoutId3v2.length - 126] === 0x47;

  return hasId3v1 ? withoutId3v2.slice(0, withoutId3v2.length - 128) : withoutId3v2;
}

export function isMp3Bytes(input: Uint8Array) {
  const id3v2Length = getId3v2TagLength(input);
  const offset = id3v2Length > 0 ? id3v2Length : 0;

  return (
    input.length >= offset + 2 &&
    input[offset] === 0xff &&
    (input[offset + 1] & 0xe0) === 0xe0
  );
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

function buildFrame(id: string, data: Uint8Array) {
  if (data.length > 0xffffffff) {
    throw new Error("ID3 帧过大");
  }

  return concatBytes([
    textEncoder.encode(id),
    writeUint32BigEndian(data.length),
    new Uint8Array([0x00, 0x00]),
    data
  ]);
}

function buildTextFrame(id: string, value: string | null | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return buildFrame(id, concatBytes([new Uint8Array([0x01]), encodeUtf16Le(normalizedValue, true)]));
}

function buildUserTextFrame(description: string, value: string | null | undefined) {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  return buildFrame(
    "TXXX",
    concatBytes([
      new Uint8Array([0x01]),
      encodeUtf16Le(description, true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalizedValue, true)
    ])
  );
}

function buildLyricsFrame(lyricsText: string) {
  const normalizedLyrics = lyricsText.trim();
  if (!normalizedLyrics) {
    return null;
  }

  return buildFrame(
    "USLT",
    concatBytes([
      new Uint8Array([0x01]),
      textEncoder.encode("XXX"),
      encodeUtf16Le("", true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalizedLyrics, true)
    ])
  );
}

function buildPictureFrame(cover: Mp3CoverData | null) {
  if (!cover || cover.bytes.length === 0) {
    return null;
  }

  const mimeType = textEncoder.encode(cover.mimeType.split(";")[0]?.trim() || "image/jpeg");

  return buildFrame(
    "APIC",
    concatBytes([
      new Uint8Array([0x00]),
      mimeType,
      new Uint8Array([0x00, 0x03, 0x00]),
      cover.bytes
    ])
  );
}

export function injectMp3Metadata(input: Uint8Array, song: Song, lyricsText: string, cover: Mp3CoverData | null) {
  const artistText = song.artists?.length ? song.artists.map((artist) => artist.name).join("; ") : song.artist;
  const frames: Uint8Array[] = [];
  const frameCandidates = [
    buildTextFrame("TIT2", song.title),
    buildTextFrame("TPE1", artistText),
    buildTextFrame("TALB", song.album),
    buildTextFrame("TPE2", song.artist),
    buildUserTextFrame("TRACKVAULT_SOURCE", song.source),
    buildUserTextFrame("LYRICS", lyricsText),
    buildUserTextFrame("UNSYNCEDLYRICS", lyricsText),
    buildLyricsFrame(lyricsText),
    buildPictureFrame(cover)
  ];

  for (const frame of frameCandidates) {
    if (frame) {
      frames.push(frame);
    }
  }

  const body = concatBytes(frames);

  if (body.length > 0x0fffffff) {
    throw new Error("ID3 标签过大");
  }

  const header = concatBytes([
    textEncoder.encode("ID3"),
    new Uint8Array([0x03, 0x00, 0x00]),
    writeSyncsafeUint32(body.length)
  ]);

  return concatBytes([header, body, stripExistingId3Tags(input)]);
}
