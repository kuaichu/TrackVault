import { z } from "zod";
import { PreferenceQualityLevelSchema, QualityLevelSchema } from "../quality.js";
import { ProviderModeSchema } from "./auth.js";
import { SongSchema } from "./music.js";

export const StartupViewSchema = z.enum(["discover", "search", "playlists", "downloads"]);
export type StartupView = z.infer<typeof StartupViewSchema>;

export const PlaybackModeSchema = z.enum(["sequential", "shuffle", "repeat-one"]);
export type PlaybackMode = z.infer<typeof PlaybackModeSchema>;

export const UserSettingsSchema = z.object({
  providerMode: ProviderModeSchema,
  defaultPlaybackQuality: PreferenceQualityLevelSchema,
  defaultDownloadQuality: PreferenceQualityLevelSchema,
  maxConcurrentDownloads: z.number().int().min(1).max(3),
  startupView: StartupViewSchema,
  updatedAt: z.number().optional(),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const UpdateUserSettingsInputSchema = UserSettingsSchema.omit({ updatedAt: true }).partial();
export type UpdateUserSettingsInput = z.infer<typeof UpdateUserSettingsInputSchema>;

export const PlayerStateSchema = z.object({
  currentTrack: SongSchema.nullable(),
  playQueue: z.array(SongSchema).max(200),
  playbackSeconds: z.number().nonnegative().max(86_400),
  volume: z.number().min(0).max(1),
  muted: z.boolean().optional(),
  lastNonZeroVolume: z.number().min(0).max(1).optional(),
  playbackMode: PlaybackModeSchema,
  preferredQuality: QualityLevelSchema.optional(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

export const PlayHistoryResponseSchema = z.object({
  items: z.array(SongSchema),
  revision: z.number().int().nonnegative(),
});
export type PlayHistoryResponse = z.infer<typeof PlayHistoryResponseSchema>;

export const SearchHistoryInputSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
});
export type SearchHistoryInput = z.infer<typeof SearchHistoryInputSchema>;
