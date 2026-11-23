import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  ChartDetail,
  ChartSummary,
  EntitySearchType,
  MusicPlatform,
  PlaylistSort,
  PlaylistSummary,
  PlaylistTracksPage,
  ProviderCapabilities,
  QrCheckResult,
  QrStartResult,
  QualityLevel,
  Song,
  SongCommentsPage,
  SongLyrics,
} from "#shared";
import { AppError } from "../errors.js";

export interface ProviderAuthContext {
  readonly platform: MusicPlatform;
  /** Transient per-request decrypted cookie; NEVER store on adapter instances. */
  readonly cookie: string | null;
  /** Used purely for ScopedLruCache isolation (userId or "public"). */
  readonly scopeKey: string;
  /** Optional persisted third-party account UID (avoids redundant login_status round-trips). */
  readonly accountUid?: string | null;
}

export interface CredentialVerificationResult {
  readonly ok: boolean;
  readonly accountUid: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly vipEnabled: boolean;
  readonly vipExpireAt: number | null;
  readonly normalizedCookie?: string;
  readonly message: string;
}

export interface PlaylistTrackQuery {
  readonly page: number;
  readonly limit: number;
  readonly keyword?: string;
  readonly sort?: PlaylistSort;
}

export interface AudioResolveTarget {
  readonly id: string;
  readonly providerSongId?: string;
  readonly mediaId?: string;
  readonly title?: string;
  readonly durationSeconds?: number;
}

export interface ResolvedAudio {
  readonly url: string;
  readonly format: string;
  readonly bitrate: number | null;
  readonly level: QualityLevel;
  readonly durationSeconds: number | null;
  readonly trial: boolean;
  readonly downgraded: boolean;
}

export interface CreatePlaylistResult {
  readonly playlistId: string;
  readonly playlistName: string;
  readonly playlistUrl: string;
  readonly addedCount: number;
}

export interface MusicProviderAdapter {
  readonly platform: MusicPlatform;
  readonly capabilities: ProviderCapabilities;

  verifyCredential(cookie: string): Promise<CredentialVerificationResult>;
  searchTracks(query: string, auth: ProviderAuthContext, limit?: number): Promise<Song[]>;
  getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]>;
  getDailyRecommendTracks?(auth: ProviderAuthContext): Promise<Song[]>;
  getCloudTracks?(auth: ProviderAuthContext): Promise<Song[]>;
  getPersonalFm?(auth: ProviderAuthContext): Promise<Song[]>;
  getRecommendedPlaylists?(auth: ProviderAuthContext, limit?: number): Promise<PlaylistSummary[]>;
  getCharts?(auth: ProviderAuthContext): Promise<ChartSummary[]>;
  getChartDetail?(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail>;
  getArtistDetail?(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail>;
  getAlbumDetail?(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail>;
  searchEntities?(
    query: string,
    type: EntitySearchType,
    auth: ProviderAuthContext,
    limit?: number,
  ): Promise<{
    artists?: ArtistSummary[];
    albums?: AlbumSummary[];
    playlists?: PlaylistSummary[];
  }>;
  getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]>;
  getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage>;
  getAllPlaylistTracks(playlistId: string, auth: ProviderAuthContext, maxTracks?: number): Promise<Song[]>;
  addTracksToPlaylist?(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }>;
  removeTracksFromPlaylist?(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }>;
  createPlaylistWithTracks?(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult>;
  getLyrics(songId: string, mediaId: string | undefined, auth: ProviderAuthContext): Promise<SongLyrics>;
  getComments?(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage>;
  setCommentLiked?(
    songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }>;
  getLikedSongIds?(auth: ProviderAuthContext): Promise<string[]>;
  isSongLiked?(songId: string, auth: ProviderAuthContext): Promise<boolean>;
  toggleSongLike?(songId: string, liked: boolean, auth: ProviderAuthContext): Promise<{ liked: boolean }>;
  resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio>;
  startQrLogin?(scopeKey: string): Promise<QrStartResult>;
  checkQrLogin?(
    scopeKey: string,
    key: string,
  ): Promise<QrCheckResult & { rawCookie?: string; verification?: CredentialVerificationResult }>;
}

export class ProviderRegistry {
  readonly #adapters = new Map<MusicPlatform, MusicProviderAdapter>();

  register(adapter: MusicProviderAdapter): void {
    this.#adapters.set(adapter.platform, adapter);
  }

  get(platform: MusicPlatform): MusicProviderAdapter {
    const adapter = this.#adapters.get(platform);
    if (!adapter) {
      throw new AppError("FEATURE_UNSUPPORTED", `未注册音乐平台适配器：${platform}`);
    }
    return adapter;
  }

  listCapabilities(): Record<MusicPlatform, ProviderCapabilities> {
    return {
      netease: this.get("netease").capabilities,
      qq: this.get("qq").capabilities,
    };
  }
}
