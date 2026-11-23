import { z } from "zod";
import { QualityLevelSchema } from "../quality.js";
import { MusicPlatformSchema } from "./auth.js";

export const SongAvailabilityStateSchema = z.enum([
  "available",
  "vip",
  "paid_album",
  "copyright",
  "restricted",
]);
export type SongAvailabilityState = z.infer<typeof SongAvailabilityStateSchema>;

export const SongCapabilitySchema = z.object({
  status: SongAvailabilityStateSchema,
  locked: z.boolean(),
  label: z.string(),
  reason: z.string(),
});
export type SongCapability = z.infer<typeof SongCapabilitySchema>;

export const SongAvailabilitySchema = z.object({
  playback: SongCapabilitySchema,
  download: SongCapabilitySchema,
});
export type SongAvailability = z.infer<typeof SongAvailabilitySchema>;

export const SongArtistSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});
export type SongArtist = z.infer<typeof SongArtistSchema>;

export const QualityOptionSchema = z.object({
  level: QualityLevelSchema,
  label: z.string(),
});
export type QualityOption = z.infer<typeof QualityOptionSchema>;

export const SongSchema = z.object({
  id: z.string().min(1).max(128),
  platform: MusicPlatformSchema,
  providerSongId: z.string().max(128).optional(),
  mediaId: z.string().max(128).optional(),
  title: z.string().min(1).max(300),
  artist: z.string().max(300),
  primaryArtistId: z.string().max(128).optional(),
  artists: z.array(SongArtistSchema).max(30).optional(),
  album: z.string().max(300),
  albumId: z.string().max(128).optional(),
  coverUrl: z.string().max(2048).optional(),
  durationSeconds: z.number().nonnegative().max(86_400),
  duration: z.string().max(16),
  quality: z.string().max(64),
  availableQualities: z.array(QualityOptionSchema).max(10),
  availability: SongAvailabilitySchema.optional(),
  isCloud: z.boolean().optional(),
});
export type Song = z.infer<typeof SongSchema>;

export function getSongKey(song: Pick<Song, "platform" | "id">): string {
  return `${song.platform}:${song.id}`;
}

export const PlaylistSummarySchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  coverUrl: z.string().optional(),
  trackCount: z.number().int().nonnegative(),
  creatorName: z.string(),
  owned: z.boolean(),
  description: z.string().optional(),
});
export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;

export const PlaylistSortSchema = z.enum([
  "default",
  "title-asc",
  "title-desc",
  "artist-asc",
  "duration-desc",
  "duration-asc",
]);
export type PlaylistSort = z.infer<typeof PlaylistSortSchema>;

export const PlaylistTracksPageSchema = z.object({
  playlist: PlaylistSummarySchema,
  songs: z.array(SongSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type PlaylistTracksPage = z.infer<typeof PlaylistTracksPageSchema>;

export const LyricLineSchema = z.object({
  time: z.number().nonnegative(),
  text: z.string(),
  translation: z.string().optional(),
});
export type LyricLine = z.infer<typeof LyricLineSchema>;

export const SongLyricsSchema = z.object({
  songId: z.string(),
  platform: MusicPlatformSchema,
  lines: z.array(LyricLineSchema),
  source: z.enum(["netease_new", "netease_legacy", "qqmusic", "none"]),
});
export type SongLyrics = z.infer<typeof SongLyricsSchema>;

export const SongCommentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  nickname: z.string(),
  avatarUrl: z.string().optional(),
  content: z.string(),
  timeText: z.string(),
  time: z.number().optional(),
  liked: z.boolean(),
  likedCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
});
export type SongComment = z.infer<typeof SongCommentSchema>;

export const SongCommentsPageSchema = z.object({
  songId: z.string(),
  platform: MusicPlatformSchema,
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  hotComments: z.array(SongCommentSchema),
  comments: z.array(SongCommentSchema),
});
export type SongCommentsPage = z.infer<typeof SongCommentsPageSchema>;

export const SongAudioProbeSchema = z.object({
  songId: z.string(),
  platform: MusicPlatformSchema,
  mode: z.enum(["playback", "download"]),
  requestedLevel: QualityLevelSchema,
  requestedLabel: z.string(),
  actualLabel: z.string(),
  actualLevel: z.string().nullable(),
  actualBitrate: z.number().nullable(),
  actualType: z.string().nullable(),
  actualDuration: z.string().nullable(),
  trial: z.boolean(),
  downgraded: z.boolean(),
});
export type SongAudioProbe = z.infer<typeof SongAudioProbeSchema>;

export const ProviderCapabilitiesSchema = z.object({
  platform: MusicPlatformSchema,
  canLikeSong: z.boolean(),
  canManagePlaylistTracks: z.boolean(),
  canCreatePlaylist: z.boolean(),
  canLoadCloudDisk: z.boolean(),
  canReadComments: z.boolean(),
  canLikeComments: z.boolean(),
  canQrLogin: z.boolean(),
  shareUrlTemplate: z.string(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;
