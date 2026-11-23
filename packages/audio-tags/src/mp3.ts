import {
  concatBytes,
  getAllId3v2TagsLength,
  getId3v2TagLength,
  readUint32BigEndian,
  writeUint32BigEndian,
} from "./bytes.js";
import type { AudioCoverData, AudioTagMetadata } from "./flac.js";

const textEncoder = new TextEncoder();
const textDecoderUtf8 = new TextDecoder("utf-8", { fatal: false });
const textDecoderUtf8Strict = new TextDecoder("utf-8", { fatal: true });
const textDecoderUtf16Le = new TextDecoder("utf-16le", { fatal: false });
const textDecoderUtf16Be = new TextDecoder("utf-16be", { fatal: false });
const textDecoderLatin1 = new TextDecoder("latin1", { fatal: false });

const ID3V22_TO_V23_FRAME_MAP: Record<string, string> = {
  TT1: "TIT1",
  TT2: "TIT2",
  TT3: "TIT3",
  TP1: "TPE1",
  TP2: "TPE2",
  TP3: "TPE3",
  TP4: "TPE4",
  TAL: "TALB",
  TRK: "TRCK",
  TPA: "TPOS",
  TYE: "TYER",
  TDA: "TDAT",
  TIM: "TIME",
  TCO: "TCON",
  TCM: "TCOM",
  TEN: "TENC",
  TBP: "TBPM",
  TCP: "TCMP",
  TRC: "TSRC",
  TLE: "TLEN",
  TLA: "TLAN",
  TFT: "TFLT",
  TKE: "TKEY",
  TOA: "TOPE",
  TOL: "TOLY",
  TOR: "TORY",
  TOT: "TOAL",
  TPB: "TPUB",
  TRD: "TRDA",
  TSI: "TSIZ",
  TSS: "TSSE",
  TXX: "TXXX",
  ULT: "USLT",
  COM: "COMM",
  WAF: "WOAF",
  WAR: "WOAR",
  WAS: "WOAS",
  WCM: "WCOM",
  WCP: "WCOP",
  WPB: "WPUB",
};

function writeSyncsafeUint32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}

function readSyncsafeUint32(bytes: Uint8Array, offset: number): number | null {
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  const b3 = bytes[offset + 3] ?? 0;
  if (b0 > 0x7f || b1 > 0x7f || b2 > 0x7f || b3 > 0x7f) return null;
  return (b0 << 21) | (b1 << 14) | (b2 << 7) | b3;
}

const MPEG_V1_BITRATES_KBPS: Record<number, readonly number[]> = {
  // Layer I (layerBits = 3)
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  // Layer II (layerBits = 2)
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  // Layer III (layerBits = 1)
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};

const MPEG_V2_BITRATES_KBPS: Record<number, readonly number[]> = {
  // Layer I (layerBits = 3)
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  // Layer II & III (layerBits = 2 or 1)
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const MPEG_SAMPLE_RATES_HZ: Record<number, readonly number[]> = {
  // MPEG 2.5 (versionBits = 0)
  0: [11025, 12000, 8000],
  // MPEG 2 (versionBits = 2)
  2: [22050, 24000, 16000],
  // MPEG 1 (versionBits = 3)
  3: [44100, 48000, 32000],
};

export function isMpegAudioFrameSync(bytes: Uint8Array, offset: number): boolean {
  if (bytes.length < offset + 4) return false;
  const b0 = bytes[offset] ?? 0;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;
  // 4-byte MPEG frame header check:
  // - 11-bit sync word (0xFFE0)
  // - MPEG version not reserved (bits 4..3 != 01)
  // - Layer not reserved (bits 2..1 != 00)
  // - Bitrate index not 0xF (bad/invalid)
  // - Sample rate index not 0x3 (reserved)
  return (
    b0 === 0xff &&
    (b1 & 0xe0) === 0xe0 &&
    (b1 & 0x18) !== 0x08 &&
    (b1 & 0x06) !== 0x00 &&
    (b2 & 0xf0) !== 0xf0 &&
    (b2 & 0x0c) !== 0x0c
  );
}

/**
 * Computes the exact byte length of an MPEG audio frame starting at `offset` per ISO/IEC 11172-3 & 13818-3.
 * Returns `null` when the 4-byte header is invalid, `0` for free-format bitrate (`bitrateIndex === 0`),
 * or the exact positive frame byte count (e.g. `417` for 128 kbps 44.1 kHz MPEG-1 Layer III).
 */
export function getMpegFrameByteLength(bytes: Uint8Array, offset: number): number | null {
  if (!isMpegAudioFrameSync(bytes, offset)) return null;
  const b1 = bytes[offset + 1] ?? 0;
  const b2 = bytes[offset + 2] ?? 0;

  const versionBits = (b1 >>> 3) & 0x03;
  const layerBits = (b1 >>> 1) & 0x03;
  const bitrateIdx = (b2 >>> 4) & 0x0f;
  const sampleRateIdx = (b2 >>> 2) & 0x03;
  const padding = (b2 >>> 1) & 0x01;

  const sampleRate = MPEG_SAMPLE_RATES_HZ[versionBits]?.[sampleRateIdx];
  if (!sampleRate) return null;
  if (bitrateIdx === 0) return 0;

  const table = versionBits === 3 ? MPEG_V1_BITRATES_KBPS[layerBits] : MPEG_V2_BITRATES_KBPS[layerBits];
  const bitrateKbps = table?.[bitrateIdx];
  if (!bitrateKbps) return null;

  const bitrateBps = bitrateKbps * 1000;
  if (layerBits === 3) {
    return (Math.floor((12 * bitrateBps) / sampleRate) + padding) * 4;
  }
  const coeff = layerBits === 1 && versionBits !== 3 ? 72 : 144;
  return Math.floor((coeff * bitrateBps) / sampleRate) + padding;
}

export function isMp3Bytes(input: Uint8Array): boolean {
  const id3v2Length = getAllId3v2TagsLength(input);
  let pos = id3v2Length;
  // Allow leading zero/silence padding bytes before the first MPEG audio frame
  const maxScan = Math.min(input.length - 4, pos + 4096);
  while (pos <= maxScan && input[pos] === 0x00) {
    pos += 1;
  }
  return isMpegAudioFrameSync(input, pos);
}

function stripExistingId3Tags(bytes: Uint8Array): Uint8Array {
  const id3v2Length = getAllId3v2TagsLength(bytes);
  const withoutId3v2 = id3v2Length > 0 ? bytes.subarray(id3v2Length) : bytes;
  const hasId3v1 =
    withoutId3v2.length >= 128 &&
    withoutId3v2[withoutId3v2.length - 128] === 0x54 &&
    withoutId3v2[withoutId3v2.length - 127] === 0x41 &&
    withoutId3v2[withoutId3v2.length - 126] === 0x47;

  return hasId3v1 ? withoutId3v2.subarray(0, withoutId3v2.length - 128) : withoutId3v2;
}

function deunsynchronize(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    out.push(b);
    if (b === 0xff && bytes[i + 1] === 0x00) {
      i += 1;
    }
  }
  return new Uint8Array(out);
}

function decodeTxxxDescription(data: Uint8Array): string {
  if (data.length < 2) return "";
  const encoding = data[0] ?? 0;
  if (encoding === 0 || encoding === 3) {
    let end = 1;
    while (end < data.length && data[end] !== 0x00) end += 1;
    const slice = data.subarray(1, end);
    return (encoding === 3 ? textDecoderUtf8 : textDecoderLatin1).decode(slice).trim();
  }
  if (encoding === 1 || encoding === 2) {
    let end = 1;
    while (end + 1 < data.length && !(data[end] === 0x00 && data[end + 1] === 0x00)) {
      end += 2;
    }
    const slice = data.subarray(1, end);
    if (encoding === 1 && slice.length >= 2) {
      if (slice[0] === 0xfe && slice[1] === 0xff) {
        return textDecoderUtf16Be.decode(slice.subarray(2)).trim();
      }
      if (slice[0] === 0xff && slice[1] === 0xfe) {
        return textDecoderUtf16Le.decode(slice.subarray(2)).trim();
      }
    }
    return (encoding === 2 ? textDecoderUtf16Be : textDecoderUtf16Le).decode(slice).trim();
  }
  return "";
}

interface ParsedId3Frame {
  id: string;
  txxxDesc?: string;
  data: Uint8Array;
}

// Standard ID3v1 (0..79) + Winamp extended (80..191) genre table; 255 / out-of-range = unset
const ID3V1_GENRES: readonly string[] = [
  "Blues",
  "Classic Rock",
  "Country",
  "Dance",
  "Disco",
  "Funk",
  "Grunge",
  "Hip-Hop",
  "Jazz",
  "Metal",
  "New Age",
  "Oldies",
  "Other",
  "Pop",
  "R&B",
  "Rap",
  "Reggae",
  "Rock",
  "Techno",
  "Industrial",
  "Alternative",
  "Ska",
  "Death Metal",
  "Pranks",
  "Soundtrack",
  "Euro-Techno",
  "Ambient",
  "Trip-Hop",
  "Vocal",
  "Jazz+Funk",
  "Fusion",
  "Trance",
  "Classical",
  "Instrumental",
  "Acid",
  "House",
  "Game",
  "Sound Clip",
  "Gospel",
  "Noise",
  "AlternRock",
  "Bass",
  "Soul",
  "Punk",
  "Space",
  "Meditative",
  "Instrumental Pop",
  "Instrumental Rock",
  "Ethnic",
  "Gothic",
  "Darkwave",
  "Techno-Industrial",
  "Electronic",
  "Pop-Folk",
  "Eurodance",
  "Dream",
  "Southern Rock",
  "Comedy",
  "Cult",
  "Gangsta",
  "Top 40",
  "Christian Rap",
  "Pop/Funk",
  "Jungle",
  "Native American",
  "Cabaret",
  "New Wave",
  "Psychedelic",
  "Rave",
  "Showtunes",
  "Trailer",
  "Lo-Fi",
  "Tribal",
  "Acid Punk",
  "Acid Jazz",
  "Polka",
  "Retro",
  "Musical",
  "Rock & Roll",
  "Hard Rock",
  "Folk",
  "Folk-Rock",
  "National Folk",
  "Swing",
  "Fast Fusion",
  "Bebop",
  "Latin",
  "Revival",
  "Celtic",
  "Bluegrass",
  "Avantgarde",
  "Gothic Rock",
  "Progressive Rock",
  "Psychedelic Rock",
  "Symphonic Rock",
  "Slow Rock",
  "Big Band",
  "Chorus",
  "Easy Listening",
  "Acoustic",
  "Humour",
  "Speech",
  "Chanson",
  "Opera",
  "Chamber Music",
  "Sonata",
  "Symphony",
  "Booty Bass",
  "Primus",
  "Porn Groove",
  "Satire",
  "Slow Jam",
  "Club",
  "Tango",
  "Samba",
  "Folklore",
  "Ballad",
  "Power Ballad",
  "Rhythmic Soul",
  "Freestyle",
  "Duet",
  "Punk Rock",
  "Drum Solo",
  "A Cappella",
  "Euro-House",
  "Dance Hall",
  "Goa",
  "Drum & Bass",
  "Club-House",
  "Hardcore",
  "Terror",
  "Indie",
  "BritPop",
  "Negerpunk",
  "Polsk Punk",
  "Beat",
  "Christian Gangsta Rap",
  "Heavy Metal",
  "Black Metal",
  "Crossover",
  "Contemporary Christian",
  "Christian Rock",
  "Merengue",
  "Salsa",
  "Thrash Metal",
  "Anime",
  "Jpop",
  "Synthpop",
  "Abstract",
  "Art Rock",
  "Baroque",
  "Bhangra",
  "Big Beat",
  "Breakbeat",
  "Chillout",
  "Downtempo",
  "Dub",
  "EBM",
  "Eclectic",
  "Electro",
  "Electroclash",
  "Emo",
  "Experimental",
  "Garage",
  "Global",
  "IDM",
  "Illbient",
  "Industro-Goth",
  "Jam Band",
  "Krautrock",
  "Leftfield",
  "Lounge",
  "Math Rock",
  "New Romantic",
  "Nu-Breakz",
  "Post-Punk",
  "Post-Rock",
  "Psytrance",
  "Shoegaze",
  "Space Rock",
  "Trop Rock",
  "World Music",
  "Neoclassical",
  "Audiobook",
  "Audio Theatre",
  "Neue Deutsche Welle",
  "Podcast",
  "Indie-Rock",
  "G-Funk",
  "Dubstep",
  "Garage Rock",
  "Psybient",
];

interface ParsedId3v1Tag {
  title?: string;
  artist?: string;
  album?: string;
  year?: string;
  comment?: string;
  track?: string;
  genre?: string;
}

function decodeId3v1Field(slice: Uint8Array): string | undefined {
  let end = slice.length;
  while (end > 0 && slice[end - 1] === 0x00) {
    end -= 1;
  }
  const nulIndex = slice.subarray(0, end).indexOf(0x00);
  const clean = nulIndex >= 0 ? slice.subarray(0, nulIndex) : slice.subarray(0, end);
  if (clean.length === 0) return undefined;
  let decoded: string;
  try {
    decoded = textDecoderUtf8Strict.decode(clean);
  } catch {
    decoded = textDecoderLatin1.decode(clean);
  }
  const trimmed = decoded.trim();
  return trimmed || undefined;
}

function parseExistingId3v1Tag(bytes: Uint8Array): ParsedId3v1Tag | null {
  const id3v2Length = getAllId3v2TagsLength(bytes);
  if (bytes.length < id3v2Length + 128) return null;
  const v1 = bytes.subarray(bytes.length - 128);
  if (v1[0] !== 0x54 || v1[1] !== 0x41 || v1[2] !== 0x47) return null;

  const isV11Track = v1[125] === 0x00 && (v1[126] ?? 0) > 0;
  const genreByte = v1[127] ?? 255;
  const genre = genreByte < ID3V1_GENRES.length ? ID3V1_GENRES[genreByte] : undefined;
  return {
    title: decodeId3v1Field(v1.subarray(3, 33)),
    artist: decodeId3v1Field(v1.subarray(33, 63)),
    album: decodeId3v1Field(v1.subarray(63, 93)),
    year: decodeId3v1Field(v1.subarray(93, 97)),
    comment: decodeId3v1Field(v1.subarray(97, isV11Track ? 125 : 127)),
    track: isV11Track ? String(v1[126]) : undefined,
    genre,
  };
}

function convertId3v22CntToPcnt(data: Uint8Array): Uint8Array | null {
  if (data.length === 0) return null;
  if (data.length >= 4) return data;
  return concatBytes([new Uint8Array(4 - data.length), data]);
}

function convertId3v22PopToPopm(data: Uint8Array): Uint8Array | null {
  const nulIdx = data.indexOf(0x00);
  // Must contain at least Latin-1 email + 0x00 + 1-byte rating (>= 2 bytes)
  if (nulIdx < 0 || data.length < nulIdx + 2) return null;
  const counterStart = nulIdx + 2;
  const counterLen = data.length - counterStart;
  if (counterLen === 0 || counterLen >= 4) {
    return data;
  }
  return concatBytes([
    data.subarray(0, counterStart),
    new Uint8Array(4 - counterLen),
    data.subarray(counterStart),
  ]);
}

function convertId3v22PicToApic(data: Uint8Array): Uint8Array | null {
  if (data.length < 6) return null;
  const encoding = data[0] ?? 0;
  const fmt = textDecoderLatin1.decode(data.subarray(1, 4)).toUpperCase();
  const mime =
    fmt === "PNG"
      ? "image/png"
      : fmt === "GIF"
        ? "image/gif"
        : fmt === "WEBP" || fmt === "WBP"
          ? "image/webp"
          : fmt === "-->"
            ? "-->"
            : "image/jpeg";
  return concatBytes([
    new Uint8Array([encoding]),
    textEncoder.encode(mime),
    new Uint8Array([0x00]),
    data.subarray(4),
  ]);
}

function parseExistingId3v2Frames(bytes: Uint8Array): ParsedId3Frame[] {
  const frames: ParsedId3Frame[] = [];
  let tagStart = 0;

  for (let tagIdx = 0; tagIdx < 16; tagIdx += 1) {
    const totalLen = getId3v2TagLength(bytes, tagStart);
    if (totalLen <= 0) break;

    const major = bytes[tagStart + 3] ?? 0;
    const flags = bytes[tagStart + 5] ?? 0;
    const hasFooter = major === 4 && Boolean(flags & 0x10);
    const bodyEnd = tagStart + totalLen - (hasFooter ? 10 : 0);

    if (major === 2) {
      // ID3v2.2: bit 6 (0x40) indicates undefined tag-level compression -> skip body safely
      if ((flags & 0x40) === 0) {
        let body = bytes.subarray(tagStart + 10, bodyEnd);
        if (flags & 0x80) {
          body = deunsynchronize(body);
        }

        let offset = 0;
        while (offset + 6 <= body.length) {
          const b0 = body[offset] ?? 0;
          if (b0 === 0x00) break; // Padding
          const rawId = textDecoderLatin1.decode(body.subarray(offset, offset + 3));
          if (!/^[A-Z0-9]{3}$/.test(rawId)) break;

          const rawSize =
            (((body[offset + 3] ?? 0) << 16) | ((body[offset + 4] ?? 0) << 8) | (body[offset + 5] ?? 0)) >>>
            0;
          if (rawSize <= 0) break;
          offset += 6;
          if (offset + rawSize > body.length) break;

          const rawData = body.subarray(offset, offset + rawSize);
          offset += rawSize;

          if (rawId === "PIC") {
            const convertedApic = convertId3v22PicToApic(rawData);
            if (convertedApic) {
              frames.push({ id: "APIC", data: convertedApic });
            }
            continue;
          }

          if (rawId === "CNT") {
            const convertedPcnt = convertId3v22CntToPcnt(rawData);
            if (convertedPcnt) {
              frames.push({ id: "PCNT", data: convertedPcnt });
            }
            continue;
          }

          if (rawId === "POP") {
            const convertedPopm = convertId3v22PopToPopm(rawData);
            if (convertedPopm) {
              frames.push({ id: "POPM", data: convertedPopm });
            }
            continue;
          }

          const mappedId = ID3V22_TO_V23_FRAME_MAP[rawId];
          if (!mappedId) continue;
          const txxxDesc = mappedId === "TXXX" ? decodeTxxxDescription(rawData).toUpperCase() : undefined;
          frames.push({ id: mappedId, txxxDesc, data: rawData });
        }
      }
    } else if (major === 3 || major === 4) {
      let body = bytes.subarray(tagStart + 10, bodyEnd);
      if (major === 3 && Boolean(flags & 0x80)) {
        body = deunsynchronize(body);
      }

      let offset = 0;
      if (flags & 0x40) {
        if (offset + 4 <= body.length) {
          const extSize =
            major === 4 ? (readSyncsafeUint32(body, offset) ?? 0) : readUint32BigEndian(body, offset);
          offset += major === 4 ? extSize : 4 + extSize;
        }
      }

      while (offset + 10 <= body.length) {
        const b0 = body[offset] ?? 0;
        if (b0 === 0x00) break; // Padding
        const id = textDecoderLatin1.decode(body.subarray(offset, offset + 4));
        if (!/^[A-Z0-9]{4}$/.test(id)) break;

        const rawSize =
          major === 4 ? readSyncsafeUint32(body, offset + 4) : readUint32BigEndian(body, offset + 4);
        if (rawSize === null || rawSize <= 0) break;
        const frameFlags1 = body[offset + 9] ?? 0;
        offset += 10;
        if (offset + rawSize > body.length) break;

        let frameData = body.subarray(offset, offset + rawSize);
        offset += rawSize;

        // Skip compressed/encrypted frames that cannot be safely re-emitted as plain ID3v2.3
        if (major === 3 && (frameFlags1 & 0xc0) !== 0) continue;
        if (major === 4 && (frameFlags1 & 0x0c) !== 0) continue;

        if (major === 4) {
          if (frameFlags1 & 0x02) {
            frameData = deunsynchronize(frameData);
          }
          if (frameFlags1 & 0x01) {
            if (frameData.length <= 4) continue;
            frameData = frameData.subarray(4);
          }
        }

        const txxxDesc = id === "TXXX" ? decodeTxxxDescription(frameData).toUpperCase() : undefined;
        frames.push({ id, txxxDesc, data: frameData });
      }
    }

    tagStart += totalLen;
  }

  return frames;
}

function encodeUtf16Le(text: string, withBom = false): Uint8Array {
  const nativeFn = (text as { toWellFormed?: () => string }).toWellFormed;
  const safeText = typeof nativeFn === "function" ? nativeFn.call(text) : text;
  const output = new Uint8Array((withBom ? 2 : 0) + safeText.length * 2);
  let offset = 0;
  if (withBom) {
    output[offset++] = 0xff;
    output[offset++] = 0xfe;
  }
  for (let i = 0; i < safeText.length; i += 1) {
    const code = safeText.charCodeAt(i);
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

function buildCommentFrame(commentText: string | null | undefined): Uint8Array | null {
  const normalized = commentText?.trim();
  if (!normalized) return null;
  return buildFrame(
    "COMM",
    concatBytes([
      new Uint8Array([0x01]),
      textEncoder.encode("XXX"),
      encodeUtf16Le("", true),
      new Uint8Array([0x00, 0x00]),
      encodeUtf16Le(normalized, true),
    ]),
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
  const hasTitle = Boolean(meta.title?.trim());
  const hasArtist = Boolean(artistText?.trim());
  const hasAlbum = Boolean(meta.album?.trim());
  const hasAlbumArtist = Boolean(meta.artist?.trim());
  const hasSource = Boolean(meta.source?.trim());
  const hasLyrics = Boolean(lyricsText.trim());
  const hasCover = Boolean(cover && cover.bytes.length > 0);

  const replacedIds = new Set<string>();
  if (hasTitle) replacedIds.add("TIT2");
  if (hasArtist) replacedIds.add("TPE1");
  if (hasAlbum) replacedIds.add("TALB");
  if (hasAlbumArtist) replacedIds.add("TPE2");
  if (hasLyrics) replacedIds.add("USLT");
  if (hasCover) replacedIds.add("APIC");

  const replacedTxxx = new Set<string>();
  if (hasSource) replacedTxxx.add("TRACKVAULT_SOURCE");
  if (hasLyrics) replacedTxxx.add("LYRICS");

  // Preserve existing ID3v2 (v2.2 / v2.3 / v2.4) frames that are not being replaced
  const parsedExistingV2 = parseExistingId3v2Frames(input).filter((frame) => {
    if (frame.id === "TXXX") {
      return !frame.txxxDesc || !replacedTxxx.has(frame.txxxDesc);
    }
    return !replacedIds.has(frame.id);
  });

  const presentIds = new Set<string>(replacedIds);
  for (const frame of parsedExistingV2) {
    presentIds.add(frame.id);
  }

  // J08: Preserve ID3v1 / ID3v1.1 fields (especially track number TRCK) before stripping trailing 128-byte tag
  const existingV1 = parseExistingId3v1Tag(input);
  const fallbackV1Frames: Uint8Array[] = [];
  if (existingV1) {
    if (existingV1.track && !presentIds.has("TRCK")) {
      const f = buildTextFrame("TRCK", existingV1.track);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.title && !presentIds.has("TIT2")) {
      const f = buildTextFrame("TIT2", existingV1.title);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.artist && !presentIds.has("TPE1")) {
      const f = buildTextFrame("TPE1", existingV1.artist);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.album && !presentIds.has("TALB")) {
      const f = buildTextFrame("TALB", existingV1.album);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.year && !presentIds.has("TYER") && !presentIds.has("TDRC")) {
      const f = buildTextFrame("TYER", existingV1.year);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.comment && !presentIds.has("COMM")) {
      const f = buildCommentFrame(existingV1.comment);
      if (f) fallbackV1Frames.push(f);
    }
    if (existingV1.genre && !presentIds.has("TCON")) {
      const f = buildTextFrame("TCON", existingV1.genre);
      if (f) fallbackV1Frames.push(f);
    }
  }

  const existingFrames = parsedExistingV2.map((frame) => buildFrame(frame.id, frame.data));

  const newFrames = [
    buildTextFrame("TIT2", meta.title),
    buildTextFrame("TPE1", artistText),
    buildTextFrame("TALB", meta.album),
    buildTextFrame("TPE2", meta.artist),
    buildUserTextFrame("TRACKVAULT_SOURCE", meta.source),
    buildUserTextFrame("LYRICS", lyricsText),
    buildLyricsFrame(lyricsText),
    buildPictureFrame(cover),
  ].filter((frame): frame is Uint8Array => frame !== null);

  const frames = [...newFrames, ...existingFrames, ...fallbackV1Frames];
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
