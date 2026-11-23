import { z } from "zod";

export const QualityLevelSchema = z.enum([
  "standard",
  "higher",
  "exhigh",
  "lossless",
  "hires",
  "jyeffect",
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
  sky: 7,
  jymaster: 8,
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
  "jyeffect",
  "hires",
  "lossless",
  "exhigh",
  "higher",
  "standard",
];

export function normalizeQualityLevel(
  raw: string | null | undefined,
  fallback: QualityLevel = "standard",
): QualityLevel {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  const parsed = QualityLevelSchema.safeParse(normalized);
  return parsed.success ? parsed.data : fallback;
}

export function getQualityLabel(level: QualityLevel | string): string {
  const meta = QUALITY_META[level as QualityLevel];
  if (meta) return meta.shortLabel;
  const trimmed = typeof level === "string" ? level.trim() : "";
  return trimmed ? trimmed.toUpperCase() : "未知";
}
