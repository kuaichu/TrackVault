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
  title: z.string().min(1).max(500),
  artist: z.string().max(1000),
  primaryArtistId: z.string().max(128).optional(),
  artists: z.array(SongArtistSchema).max(200).optional(),
  album: z.string().max(500),
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
  truncated: z.boolean().optional(),
  scannedTotal: z.number().int().nonnegative().optional(),
});
export type PlaylistTracksPage = z.infer<typeof PlaylistTracksPageSchema>;

export const CloudTracksPageSchema = z.object({
  songs: z.array(SongSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type CloudTracksPage = z.infer<typeof CloudTracksPageSchema>;

export const ArtistSummarySchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  avatarUrl: z.string().optional(),
  songCount: z.number().int().nonnegative().optional(),
  albumCount: z.number().int().nonnegative().optional(),
});
export type ArtistSummary = z.infer<typeof ArtistSummarySchema>;

export const AlbumSummarySchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  coverUrl: z.string().optional(),
  artistName: z.string(),
  artistId: z.string().optional(),
  publishDate: z.string().optional(),
  trackCount: z.number().int().nonnegative().optional(),
  albumType: z.string().optional(),
});
export type AlbumSummary = z.infer<typeof AlbumSummarySchema>;

export const ArtistDetailSchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  alias: z.array(z.string()).optional(),
  avatarUrl: z.string().optional(),
  briefDesc: z.string().optional(),
  songCount: z.number().int().nonnegative().optional(),
  albumCount: z.number().int().nonnegative().optional(),
  hotSongs: z.array(SongSchema),
  albums: z.array(AlbumSummarySchema),
});
export type ArtistDetail = z.infer<typeof ArtistDetailSchema>;

export const AlbumDetailSchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  coverUrl: z.string().optional(),
  artists: z.array(SongArtistSchema),
  publishDate: z.string().optional(),
  company: z.string().optional(),
  description: z.string().optional(),
  trackCount: z.number().int().nonnegative(),
  songs: z.array(SongSchema),
});
export type AlbumDetail = z.infer<typeof AlbumDetailSchema>;

export const ChartSummarySchema = z.object({
  id: z.string(),
  platform: MusicPlatformSchema,
  name: z.string(),
  coverUrl: z.string().optional(),
  updateFrequency: z.string().optional(),
  trackCount: z.number().int().nonnegative().optional(),
  previewTracks: z.array(z.string()).optional(),
});
export type ChartSummary = z.infer<typeof ChartSummarySchema>;

export const ChartDetailSchema = z.object({
  chart: ChartSummarySchema,
  songs: z.array(SongSchema),
});
export type ChartDetail = z.infer<typeof ChartDetailSchema>;

export const EntitySearchTypeSchema = z.enum(["artist", "album", "playlist"]);
export type EntitySearchType = z.infer<typeof EntitySearchTypeSchema>;

export const EntitySearchResultSchema = z.object({
  type: EntitySearchTypeSchema,
  artists: z.array(ArtistSummarySchema),
  albums: z.array(AlbumSummarySchema),
  playlists: z.array(PlaylistSummarySchema),
  warnings: z.array(z.string()),
});
export type EntitySearchResult = z.infer<typeof EntitySearchResultSchema>;

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
