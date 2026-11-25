import { z } from "zod";

export const QualityLevelSchema = z.enum([
  "standard",
  "higher",
  "exhigh",
  "lossless",
  "hires",
  "jyeffect",
  "vivid",
  "dolby",
  "jymaster",
  "sky",
]);

export type QualityLevel = z.infer<typeof QualityLevelSchema>;

export const PreferenceQualityLevelSchema = z.enum(["standard", "exhigh", "lossless", "hires"]);
export type PreferenceQualityLevel = z.infer<typeof PreferenceQualityLevelSchema>;

export const QUALITY_RANK: Record<QualityLevel, number> = {
  standard: 1,
  higher: 2,
  exhigh: 3,
  lossless: 4,
  hires: 5,
  jyeffect: 6,
  vivid: 7,
  dolby: 8,
  sky: 9,
  jymaster: 10,
};

export const QUALITY_META: Record<
  QualityLevel,
  { label: string; shortLabel: string; minBitrate: number; lossless: boolean }
> = {
  standard: { label: "标准 128K", shortLabel: "128K", minBitrate: 0, lossless: false },
  higher: { label: "较高 192K", shortLabel: "192K", minBitrate: 180_000, lossless: false },
  exhigh: { label: "极高 320K", shortLabel: "320K", minBitrate: 300_000, lossless: false },
  lossless: { label: "无损 FLAC", shortLabel: "FLAC", minBitrate: 700_000, lossless: true },
  hires: { label: "Hi-Res 高解析", shortLabel: "Hi-Res", minBitrate: 900_000, lossless: true },
  jyeffect: { label: "高清环绕声", shortLabel: "高清环绕", minBitrate: 300_000, lossless: false },
  vivid: { label: "臻音全景 384K", shortLabel: "臻音 384K", minBitrate: 320_000, lossless: false },
  dolby: { label: "杜比全景声", shortLabel: "杜比全景声", minBitrate: 300_000, lossless: false },
  sky: { label: "沉浸环绕声", shortLabel: "沉浸环绕", minBitrate: 300_000, lossless: false },
  jymaster: { label: "超清母带", shortLabel: "超清母带", minBitrate: 900_000, lossless: true },
};

export const PREFERENCE_QUALITY_OPTIONS: ReadonlyArray<{
  level: PreferenceQualityLevel;
  label: string;
}> = [
  { level: "hires", label: "Hi-Res" },
  { level: "lossless", label: "FLAC 无损" },
  { level: "exhigh", label: "320K 极高" },
  { level: "standard", label: "128K 标准" },
];

export const QUALITY_FALLBACK_ORDER: readonly QualityLevel[] = [
  "jymaster",
  "sky",
  "dolby",
  "vivid",
  "jyeffect",
  "hires",
  "lossless",
  "exhigh",
  "higher",
  "standard",
];

export type AudioFormatCategory = "uncompressed_lossless" | "compressed_lossless" | "lossy" | "unknown";

export interface AudioFormatClassification {
  cleanFormat: string;
  category: AudioFormatCategory;
  isLossless: boolean;
  isExplicitLossy: boolean;
}

const UNCOMPRESSED_LOSSLESS_FORMATS = new Set(["wav", "aiff", "pcm"]);
const COMPRESSED_LOSSLESS_FORMATS = new Set(["flac", "ape", "alac"]);
const LOSSY_FORMATS = new Set(["mp3", "aac", "ogg", "opus", "wma", "webm", "m4a", "mp4"]);

export function classifyAudioFormat(format?: string | null): AudioFormatClassification {
  const cleanFormat = format?.trim().replace(/^\./, "").trim().toLowerCase() ?? "";
  if (UNCOMPRESSED_LOSSLESS_FORMATS.has(cleanFormat)) {
    return {
      cleanFormat,
      category: "uncompressed_lossless",
      isLossless: true,
      isExplicitLossy: false,
    };
  }
  if (COMPRESSED_LOSSLESS_FORMATS.has(cleanFormat)) {
    return {
      cleanFormat,
      category: "compressed_lossless",
      isLossless: true,
      isExplicitLossy: false,
    };
  }
  if (LOSSY_FORMATS.has(cleanFormat)) {
    return {
      cleanFormat,
      category: "lossy",
      isLossless: false,
      isExplicitLossy: true,
    };
  }
  return {
    cleanFormat,
    category: "unknown",
    isLossless: false,
    isExplicitLossy: false,
  };
}

export function inferQualityLevelFromBitrate(
  bitrate: number | null | undefined,
  format?: string | null,
): QualityLevel | null {
  const { category, isExplicitLossy } = classifyAudioFormat(format);
  const br = typeof bitrate === "number" && Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0;
  if (category === "uncompressed_lossless") {
    // A14: Standard 16-bit / 44.1 kHz (1,411.2 kbps) and 16-bit / 48 kHz (1,536 kbps) stereo PCM WAV
    // are CD-tier lossless, not Hi-Res; 24-bit PCM starts above 2.1 Mbps.
    return br >= 2_100_000 ? "hires" : "lossless";
  }
  if (category === "compressed_lossless") {
    return br >= 1_200_000 ? "hires" : "lossless";
  }
  if (br <= 0) return null;
  // A14: Never infer lossless/FLAC when upstream explicitly declares a lossy codec/container (e.g. AAC 768 kbps)
  if (!isExplicitLossy) {
    if (br >= 900_000) return "hires";
    if (br >= 700_000) return "lossless";
  }
  // High lossy bitrates (e.g. 384 kbps MP3 or 768 kbps AAC) without an explicit spatial/vivid tier map to exhigh (labelled with real kbps)
  if (br >= 256_000) return "exhigh";
  if (br >= 160_000) return "higher";
  return "standard";
}

export function normalizeQualityLevel(
  raw: string | null | undefined,
  fallback: QualityLevel = "standard",
  hint?: { bitrate?: number | null; format?: string | null },
): QualityLevel {
  const normalized = raw?.trim().toLowerCase();
  if (normalized) {
    const parsed = QualityLevelSchema.safeParse(normalized);
    if (parsed.success) return parsed.data;
  }
  if (hint) {
    const inferred = inferQualityLevelFromBitrate(hint.bitrate, hint.format);
    if (inferred) return inferred;
  }
  return fallback;
}

export function getQualityLabel(
  level: QualityLevel | string,
  bitrate?: number | null,
  format?: string | null,
): string {
  const { cleanFormat, isLossless, isExplicitLossy } = classifyAudioFormat(format);
  const kbps =
    typeof bitrate === "number" && Number.isFinite(bitrate) && bitrate > 0
      ? Math.round(bitrate / 1000)
      : null;

  const meta = QUALITY_META[level as QualityLevel];
  if (meta) {
    if (level === "vivid") {
      return kbps ? `臻音 ${kbps}K` : meta.shortLabel;
    }
    if (level === "dolby") {
      return kbps ? `杜比 ${kbps}K` : meta.shortLabel;
    }
    if (meta.lossless && isExplicitLossy) {
      return kbps ? `${cleanFormat.toUpperCase()} ${kbps}K` : cleanFormat.toUpperCase();
    }
    if (level === "lossless" && isLossless) {
      return cleanFormat.toUpperCase();
    }
    if (!meta.lossless && kbps && (level === "standard" || level === "higher" || level === "exhigh")) {
      return `${kbps}K`;
    }
    return meta.shortLabel;
  }

  const trimmed = typeof level === "string" ? level.trim() : "";
  if (kbps) {
    return trimmed ? `${trimmed.toUpperCase()} ${kbps}K` : `${kbps}K`;
  }
  return trimmed ? trimmed.toUpperCase() : "未知";
}
