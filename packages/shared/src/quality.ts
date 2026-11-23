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

export function inferQualityLevelFromBitrate(
  bitrate: number | null | undefined,
  format?: string | null,
): QualityLevel | null {
  const cleanFmt = format?.replace(/^\./, "").trim().toLowerCase() ?? "";
  const isLossless = cleanFmt === "flac" || cleanFmt === "wav" || cleanFmt === "ape";
  const br = typeof bitrate === "number" && Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0;
  if (isLossless) {
    return br >= 1_200_000 ? "hires" : "lossless";
  }
  if (br <= 0) return null;
  if (br >= 900_000) return "hires";
  if (br >= 700_000) return "lossless";
  if (br >= 350_000) return "vivid";
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

export function getQualityLabel(level: QualityLevel | string, bitrate?: number | null): string {
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
