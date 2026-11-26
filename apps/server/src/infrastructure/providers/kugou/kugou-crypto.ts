import crypto from "node:crypto";
import zlib from "node:zlib";
import type { LyricLine } from "#shared";

export type KugouEdition = "lite" | "standard";

export interface KugouEditionConfig {
  readonly edition: KugouEdition;
  readonly appid: number;
  readonly clientver: number;
  readonly androidSalt: string;
  readonly trackKeySalt: string;
  readonly rsaPublicKey: string;
  readonly wxAppid: string;
  readonly wxSecret: string;
  readonly pid: number;
  readonly pageId: number;
  readonly ppageId: string;
  readonly tokenAesKey: string;
  readonly tokenAesIv: string;
}

export const KUGOU_SRC_APPID = 2919;
export const KUGOU_WEB_SALT = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";

export const KUGOU_STD_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`;

export const KUGOU_LITE_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`;

export const KUGOU_EDITION_CONFIGS: Record<KugouEdition, KugouEditionConfig> = {
  lite: {
    edition: "lite",
    appid: 3116,
    clientver: 11440,
    androidSalt: "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA",
    trackKeySalt: "185672dd44712f60bb1736df5a377e82",
    rsaPublicKey: KUGOU_LITE_RSA_PUBLIC_KEY,
    wxAppid: "wx72b795aca60ad321",
    wxSecret: "33e486041e5e25729a4e3d2da7502f9a",
    pid: 411,
    pageId: 967_177_915,
    ppageId: "356753938,823673182,967485191",
    tokenAesKey: "c24f74ca2820225badc01946dba4fdf7",
    tokenAesIv: "adc01946dba4fdf7",
  },
  standard: {
    edition: "standard",
    appid: 1005,
    clientver: 20489,
    androidSalt: "OIlwieks28dk2k092lksi2UIkp",
    trackKeySalt: "57ae12eb6890223e355ccfcb74edf70d",
    rsaPublicKey: KUGOU_STD_RSA_PUBLIC_KEY,
    wxAppid: "wx79f2c4418704b4f8",
    wxSecret: "4efcab88b700769e376e3f6087b8abc9",
    pid: 2,
    pageId: 151_369_488,
    ppageId: "463467626,350369493,788954147",
    tokenAesKey: "90b8382a1bb4ccdcf063102053fd75b8",
    tokenAesIv: "f063102053fd75b8",
  },
};

export const KUGOU_LITE_T1_KEY = "5e4ef500e9597fe004bd09a46d8add98";
export const KUGOU_LITE_T1_IV = "04bd09a46d8add98";
export const KUGOU_LITE_T2_KEY = "fd14b35e3f81af3817a20ae7adae7020";
export const KUGOU_LITE_T2_IV = "17a20ae7adae7020";

export function md5Hex(input: string | Uint8Array): string {
  return crypto.createHash("md5").update(input).digest("hex");
}

export function sha1Hex(input: string | Uint8Array): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function randomAlphaNum(length = 16, lowercase = true): string {
  const alphabet = lowercase
    ? "0123456789abcdefghijklmnopqrstuvwxyz"
    : "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

export function calculateKugouMid(guid: string): string {
  const hex = md5Hex(guid);
  return BigInt(`0x${hex}`).toString(10);
}

export function signKugouAndroidParams(
  params: Record<string, unknown>,
  body: string | undefined,
  edition: KugouEdition,
): string {
  const salt = KUGOU_EDITION_CONFIGS[edition].androidSalt;
  const serialized = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort()
    .map((key) => {
      const value = params[key];
      const strVal = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `${key}=${strVal}`;
    })
    .join("");
  return md5Hex(`${salt}${serialized}${body ?? ""}${salt}`);
}

export function signKugouWebParams(params: Record<string, unknown>, body = ""): string {
  const serialized = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .map((key) => `${key}=${String(params[key])}`)
    .sort()
    .join("");
  return md5Hex(`${KUGOU_WEB_SALT}${serialized}${body}${KUGOU_WEB_SALT}`);
}

export function signKugouParamsKey(
  data: string | number,
  edition: KugouEdition,
  appidOverride?: number,
  clientverOverride?: number,
): string {
  const conf = KUGOU_EDITION_CONFIGS[edition];
  const appid = appidOverride ?? conf.appid;
  const clientver = clientverOverride ?? conf.clientver;
  return md5Hex(`${appid}${conf.androidSalt}${clientver}${data}`);
}

export function signKugouTrackKey(
  hash: string,
  mid: string,
  userid: string | number,
  edition: KugouEdition,
  appidOverride?: number,
): string {
  const conf = KUGOU_EDITION_CONFIGS[edition];
  const appid = appidOverride ?? conf.appid;
  return md5Hex(`${hash.toLowerCase()}${conf.trackKeySalt}${appid}${mid}${userid || 0}`);
}

interface ParsedRsaKey {
  readonly n: bigint;
  readonly e: bigint;
  readonly keyBytes: number;
}

const rsaParamCache = new Map<string, ParsedRsaKey>();

function getRsaPublicParams(pem: string): ParsedRsaKey {
  const cached = rsaParamCache.get(pem);
  if (cached) return cached;
  const jwk = crypto.createPublicKey(pem).export({ format: "jwk" }) as { n: string; e: string };
  const nBuf = Buffer.from(jwk.n, "base64url");
  const eBuf = Buffer.from(jwk.e, "base64url");
  const parsed: ParsedRsaKey = {
    n: BigInt(`0x${nBuf.toString("hex")}`),
    e: BigInt(`0x${eBuf.toString("hex")}`),
    keyBytes: nBuf.length,
  };
  rsaParamCache.set(pem, parsed);
  return parsed;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * Matches KuGouMusicApi `cryptoRSAEncrypt`: right-zero-padded raw RSA modular exponentiation.
 */
export function kugouRsaRawEncryptHex(data: string | Record<string, unknown>, edition: KugouEdition): string {
  const pem = KUGOU_EDITION_CONFIGS[edition].rsaPublicKey;
  const { n, e, keyBytes } = getRsaPublicParams(pem);
  const plain = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  if (plain.length > keyBytes) {
    throw new Error("Kugou RSA payload exceeds key length");
  }
  const padded = Buffer.alloc(keyBytes, 0);
  plain.copy(padded, 0);
  const m = BigInt(`0x${padded.toString("hex")}`);
  const c = modPow(m, e, n);
  return c.toString(16).padStart(keyBytes * 2, "0");
}

/**
 * Matches KuGouMusicApi `rsaEncrypt2`: standard RSAES-PKCS1-v1_5 encryption (hex).
 */
export function kugouRsaPkcs1EncryptHex(
  data: string | Record<string, unknown>,
  edition: KugouEdition,
): string {
  const pem = KUGOU_EDITION_CONFIGS[edition].rsaPublicKey;
  const plain = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  const encrypted = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, plain);
  return encrypted.toString("hex");
}

/**
 * Matches KuGouMusicApi `cryptoAesEncrypt` (AES-256-CBC with 32-byte ASCII key & 16-byte ASCII IV).
 */
export function kugouAesEncryptWithRandomKey(data: string | Record<string, unknown>): {
  str: string;
  key: string;
} {
  const plain = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  const tempKey = randomAlphaNum(16, true);
  const fullKey = md5Hex(tempKey).slice(0, 32);
  const iv = fullKey.slice(16, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", Buffer.from(fullKey, "utf8"), Buffer.from(iv, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { str: encrypted.toString("hex"), key: tempKey };
}

export function kugouAesEncryptFixed(
  data: string | Record<string, unknown>,
  key: string,
  iv: string,
): string {
  const plain = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  const keyBuf = Buffer.from(key, "utf8");
  const algo = keyBuf.length === 16 ? "aes-128-cbc" : "aes-256-cbc";
  const cipher = crypto.createCipheriv(algo, keyBuf, Buffer.from(iv, "utf8"));
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString("hex");
}

export function kugouAesDecrypt(
  cipherHex: string,
  rawKey: string,
  explicitIv?: string,
): Record<string, unknown> | string {
  const fullKey = explicitIv ? rawKey : md5Hex(rawKey).slice(0, 32);
  const iv = explicitIv ?? fullKey.slice(fullKey.length - 16);
  const keyBuf = Buffer.from(fullKey, "utf8");
  const algo = keyBuf.length === 16 ? "aes-128-cbc" : "aes-256-cbc";
  const decipher = crypto.createDecipheriv(algo, keyBuf, Buffer.from(iv, "utf8"));
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
  try {
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return plain;
  }
}

export function kugouRegisterAesEncrypt(data: Record<string, unknown>): { key: string; base64Body: string } {
  const seed = randomAlphaNum(6, true);
  const digest = md5Hex(seed);
  const key = Buffer.from(digest.slice(0, 16), "utf8");
  const iv = Buffer.from(digest.slice(16, 32), "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return { key: seed, base64Body: encrypted.toString("base64") };
}

export function kugouRegisterAesDecrypt(
  cipherBytes: Uint8Array,
  seed: string,
): Record<string, unknown> | null {
  try {
    const digest = md5Hex(seed);
    const key = Buffer.from(digest.slice(0, 16), "utf8");
    const iv = Buffer.from(digest.slice(16, 32), "utf8");
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(cipherBytes), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const KRC_XOR_KEY = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105] as const;

export function decodeKrcContent(base64Content: string): string {
  try {
    const raw = Buffer.from(base64Content, "base64");
    if (raw.length <= 4) return "";
    const payload = Buffer.from(raw.subarray(4));
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (payload[i] ?? 0) ^ (KRC_XOR_KEY[i % KRC_XOR_KEY.length] ?? 0);
    }
    return zlib.inflateSync(payload).toString("utf8");
  } catch {
    return "";
  }
}

interface RawKrcLanguagePayload {
  content?: Array<{
    type?: number;
    lyricContent?: string[][];
  }>;
}

export function parseKrcLyrics(krcText: string): LyricLine[] {
  if (!krcText.trim()) return [];

  let translationLines: string[][] | null = null;
  const langMatch = /\[language:([^\]]+)\]/.exec(krcText);
  if (langMatch?.[1]) {
    try {
      const decodedLang = JSON.parse(
        Buffer.from(langMatch[1].trim(), "base64").toString("utf8"),
      ) as RawKrcLanguagePayload;
      const transBlock = decodedLang.content?.find((item) => item.type === 1);
      if (Array.isArray(transBlock?.lyricContent)) {
        translationLines = transBlock.lyricContent;
      }
    } catch {
      translationLines = null;
    }
  }

  const lines: LyricLine[] = [];
  let lyricRowIndex = 0;
  for (const rawLine of krcText.split(/\r?\n/)) {
    const match = /^\[(\d+),(\d+)\](.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const startMs = Number(match[1]);
    const rawBody = match[3] ?? "";
    const cleanText = rawBody.replace(/<[^>]*>/g, "").trim();
    const transRow = translationLines?.[lyricRowIndex];
    lyricRowIndex += 1;
    if (!Number.isFinite(startMs) || startMs < 0 || !cleanText) continue;
    const translation = Array.isArray(transRow) ? transRow.join("").trim() : "";
    lines.push({
      time: Math.round((startMs / 1000) * 1000) / 1000,
      text: cleanText,
      ...(translation ? { translation } : {}),
    });
  }

  return lines.sort((a, b) => a.time - b.time);
}
