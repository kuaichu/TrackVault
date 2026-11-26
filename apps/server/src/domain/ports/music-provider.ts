import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  ChartDetail,
  ChartSummary,
  CloudTracksPage,
  EntitySearchType,
  MusicPlatform,
  PersonalFmMode,
  PlaylistSort,
  PlaylistSummary,
  PlaylistTracksPage,
  ProviderCapabilities,
  QqQrLoginChannel,
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
  /** Optional persisted VIP status for account-aware availability evaluation. */
  readonly vipEnabled?: boolean;
  /** Optional cancellation signal for background jobs / HTTP request aborts. */
  readonly signal?: AbortSignal;
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
  readonly availableLevels?: readonly QualityLevel[];
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

export interface PlaylistScanInspection {
  readonly songs: Song[];
  readonly totalSlots: number;
  readonly scannedSlotIds: ReadonlySet<string>;
  readonly beyondScanSlotIds: ReadonlySet<string>;
  readonly truncatedSlots: boolean;
}

export interface ProviderQrCheckResult extends QrCheckResult {
  rawCookie?: string;
  nickname?: string;
  avatarUrl?: string;
  verification?: CredentialVerificationResult;
}

export interface ProviderAuthPort {
  verifyCredential(cookie: string): Promise<CredentialVerificationResult>;
  startQrLogin?(scopeKey: string, options?: { channel?: QqQrLoginChannel }): Promise<QrStartResult>;
  checkQrLogin?(scopeKey: string, key: string): Promise<ProviderQrCheckResult>;
  /** Clears all per-user scoped caches (e.g., on bind/unbind/account switch/member deletion). */
  invalidateScope?(scopeKey: string): void;
  /** Optional lifecycle cleanup for pooled sockets/resources on server shutdown. */
  close?(): void;
}

export interface MusicCatalogPort {
  searchTracks(query: string, auth: ProviderAuthContext, limit?: number): Promise<Song[]>;
  getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]>;
  getDailyRecommendTracks?(auth: ProviderAuthContext): Promise<Song[]>;
  getPersonalFm?(auth: ProviderAuthContext, mode?: PersonalFmMode): Promise<Song[]>;
  trashPersonalFmSong?(songId: string, auth: ProviderAuthContext): Promise<{ ok: boolean }>;
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
}

export interface PlaylistReadPort {
  getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]>;
  getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage>;
  getAllPlaylistTracks(playlistId: string, auth: ProviderAuthContext, maxTracks?: number): Promise<Song[]>;
  inspectPlaylistTracks?(
    playlistId: string,
    maxTracks: number,
    auth: ProviderAuthContext,
  ): Promise<PlaylistScanInspection>;
}

export interface PlaylistMutationPort {
  addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }>;
  removeTracksFromPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }>;
  createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult>;
}

export interface CloudDiskPort {
  getCloudTracks(auth: ProviderAuthContext): Promise<Song[]>;
  getCloudTracksPage(
    auth: ProviderAuthContext,
    options?: { offset?: number; limit?: number },
  ): Promise<CloudTracksPage>;
}

export interface SocialPort {
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
  toggleSongLike?(songId: string, liked: boolean, auth: ProviderAuthContext): Promise<{ liked: boolean }>;
}

export interface AudioResolverPort {
  resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio>;
}

/**
 * Unified provider adapter facade combining core required ports and optional capability ports.
 */
export interface MusicProviderAdapter
  extends ProviderAuthPort,
    MusicCatalogPort,
    PlaylistReadPort,
    Partial<PlaylistMutationPort>,
    Partial<CloudDiskPort>,
    SocialPort,
    AudioResolverPort {
  readonly platform: MusicPlatform;
  readonly capabilities: ProviderCapabilities;
}

export function supportsPlaylistMutation(
  adapter: MusicProviderAdapter,
): adapter is MusicProviderAdapter & PlaylistMutationPort {
  return (
    typeof adapter.createPlaylistWithTracks === "function" &&
    typeof adapter.addTracksToPlaylist === "function" &&
    typeof adapter.removeTracksFromPlaylist === "function"
  );
}

export function supportsCloudDisk(
  adapter: MusicProviderAdapter,
): adapter is MusicProviderAdapter & CloudDiskPort {
  return typeof adapter.getCloudTracks === "function" && typeof adapter.getCloudTracksPage === "function";
}

export function supportsQrLogin(
  adapter: MusicProviderAdapter,
): adapter is MusicProviderAdapter & Required<Pick<ProviderAuthPort, "startQrLogin" | "checkQrLogin">> {
  return typeof adapter.startQrLogin === "function" && typeof adapter.checkQrLogin === "function";
}

export function supportsSongLike(
  adapter: MusicProviderAdapter,
): adapter is MusicProviderAdapter & Required<Pick<SocialPort, "getLikedSongIds" | "toggleSongLike">> {
  return typeof adapter.getLikedSongIds === "function" && typeof adapter.toggleSongLike === "function";
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
    const result = {} as Record<MusicPlatform, ProviderCapabilities>;
    for (const [platform, adapter] of this.#adapters.entries()) {
      result[platform] = adapter.capabilities;
    }
    return result;
  }

  closeAll(): void {
    for (const adapter of this.#adapters.values()) {
      adapter.close?.();
    }
  }
}
