import {
  type AlbumDetail,
  type ArtistDetail,
  type ChartDetail,
  type ChartSummary,
  type CloudTracksPage,
  type EntitySearchType,
  type PlaylistSummary,
  type PlaylistTracksPage,
  type ProviderCapabilities,
  type QrStartResult,
  type QualityLevel,
  type Song,
  type SongCommentsPage,
  type SongLyrics,
  normalizeCoverUrl,
} from "#shared";
import type {
  AudioResolveTarget,
  CloudDiskPort,
  CreatePlaylistResult,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistMutationPort,
  PlaylistScanInspection,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ProviderQrCheckResult,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import { NeteaseCatalogService } from "./netease-catalog-service.js";
import { normalizeNeteaseCookie } from "./netease-cookie.js";
import { NeteaseLikeStore } from "./netease-like-store.js";
import { NeteasePlaylistService } from "./netease-playlist-service.js";
import { NeteaseQrAuthManager } from "./netease-qr-auth.js";
import { type NeteaseApiModule, NeteaseRpcClient, extractNeteaseApiError } from "./netease-rpc-client.js";

export { normalizeNeteaseCookie } from "./netease-cookie.js";

function extractVipExpireAt(body: Record<string, unknown>): number | null {
  const data = (body.data ?? body) as Record<string, unknown>;
  const candidates = [
    (data.associator as { expireTime?: number } | undefined)?.expireTime,
    (data.redplus as { expireTime?: number } | undefined)?.expireTime,
    (data.musicPackage as { expireTime?: number } | undefined)?.expireTime,
  ];
  const valid = candidates.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

export class NeteaseAdapter implements MusicProviderAdapter, PlaylistMutationPort, CloudDiskPort {
  readonly platform = "netease" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "netease",
    canLikeSong: true,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: true,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    shareUrlTemplate: "https://music.163.com/#/song?id={id}",
  };

  readonly #rpc: NeteaseRpcClient;
  readonly #qrAuth: NeteaseQrAuthManager;
  readonly #likeStore: NeteaseLikeStore;
  readonly #playlists: NeteasePlaylistService;
  readonly #catalog: NeteaseCatalogService;

  constructor(options?: { realIp?: string; timeoutMs?: number; apiOverride?: Partial<NeteaseApiModule> }) {
    this.#rpc = new NeteaseRpcClient(options);
    this.#qrAuth = new NeteaseQrAuthManager(this.#rpc);
    this.#likeStore = new NeteaseLikeStore(this.#rpc);
    const verify = (cookie: string) => this.verifyCredential(cookie);
    this.#playlists = new NeteasePlaylistService(this.#rpc, verify);
    this.#catalog = new NeteaseCatalogService(this.#rpc);
  }

  close(): void {
    this.#rpc.close();
  }

  invalidateScope(scopeKey: string): void {
    this.#rpc.invalidateScope(scopeKey);
    this.#qrAuth.invalidateScope(scopeKey);
    this.#likeStore.invalidateScope(scopeKey);
    this.#playlists.invalidateScope(scopeKey);
    this.#catalog.invalidateScope(scopeKey);
  }

  async verifyCredential(cookie: string): Promise<CredentialVerificationResult> {
    const trimmed = normalizeNeteaseCookie(cookie.trim());
    if (!trimmed) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "请提供网易云登录态 Cookie。",
      };
    }

    try {
      const response = await this.#rpc.call(() =>
        this.#rpc.api.login_status(this.#rpc.baseParams(undefined, { cookie: trimmed })),
      );
      const body = response.body as {
        data?: {
          account?: { id?: number; vipType?: number } | null;
          profile?: { userId?: number; nickname?: string; avatarUrl?: string; vipType?: number } | null;
        };
      };
      const uid = body.data?.account?.id ?? body.data?.profile?.userId;
      const nickname = body.data?.profile?.nickname?.trim();
      if (!uid && !nickname) {
        return {
          ok: false,
          accountUid: null,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: "网易云 Cookie 无效或已过期。",
        };
      }

      const vipType = body.data?.profile?.vipType ?? body.data?.account?.vipType ?? 0;
      const vipEnabled = typeof vipType === "number" && vipType > 0;
      let vipExpireAt: number | null = null;

      if (uid) {
        const vipRes = await this.#rpc
          .call(() => this.#rpc.api.vip_info_v2(this.#rpc.baseParams(undefined, { uid, cookie: trimmed })))
          .catch(() =>
            this.#rpc.call(() =>
              this.#rpc.api.vip_info(this.#rpc.baseParams(undefined, { uid, cookie: trimmed })),
            ),
          )
          .catch(() => null);
        if (vipRes?.body) {
          vipExpireAt = extractVipExpireAt(vipRes.body);
        }
      }

      const accountUid = uid ? String(uid) : null;
      const displayName = nickname || (accountUid ? `UID ${accountUid}` : "网易云用户");
      return {
        ok: true,
        accountUid,
        displayName,
        avatarUrl: normalizeCoverUrl(body.data?.profile?.avatarUrl, 200) ?? null,
        vipEnabled,
        vipExpireAt,
        normalizedCookie: trimmed,
        message: `网易云账号验证成功：${displayName}`,
      };
    } catch (error) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: extractNeteaseApiError(error, "网易云 Cookie 验证失败"),
      };
    }
  }

  searchTracks(query: string, auth: ProviderAuthContext, limit = 30): Promise<Song[]> {
    return this.#catalog.searchTracks(query, auth, limit);
  }

  getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getDiscoverTracks(auth);
  }

  getDailyRecommendTracks(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getDailyRecommendTracks(auth);
  }

  getPersonalFm(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getPersonalFm(auth);
  }

  getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    return this.#catalog.getRecommendedPlaylists(auth, limit);
  }

  getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    return this.#catalog.getCharts(auth);
  }

  getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    return this.#catalog.getChartDetail(chartId, auth, (id, q, a) =>
      this.#playlists.getPlaylistTracks(id, q, a),
    );
  }

  getArtistDetail(artistId: string, auth: ProviderAuthContext): Promise<ArtistDetail> {
    return this.#catalog.getArtistDetail(artistId, auth);
  }

  getAlbumDetail(albumId: string, auth: ProviderAuthContext): Promise<AlbumDetail> {
    return this.#catalog.getAlbumDetail(albumId, auth);
  }

  searchEntities(query: string, type: EntitySearchType, auth: ProviderAuthContext, limit = 20) {
    return this.#catalog.searchEntities(query, type, auth, limit);
  }

  getCloudTracksPage(
    auth: ProviderAuthContext,
    options?: { offset?: number; limit?: number },
  ): Promise<CloudTracksPage> {
    return this.#catalog.getCloudTracksPage(auth, options);
  }

  getCloudTracks(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getCloudTracks(auth);
  }

  getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    return this.#playlists.getUserPlaylists(auth);
  }

  inspectPlaylistTracks(
    playlistId: string,
    maxTracks: number,
    auth: ProviderAuthContext,
  ): Promise<PlaylistScanInspection> {
    return this.#playlists.inspectPlaylistTracks(playlistId, maxTracks, auth);
  }

  getAllPlaylistTracks(playlistId: string, auth: ProviderAuthContext, maxTracks?: number): Promise<Song[]> {
    return this.#playlists.getAllPlaylistTracks(playlistId, auth, maxTracks);
  }

  getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    return this.#playlists.getPlaylistTracks(playlistId, query, auth);
  }

  addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ addedCount: number }> {
    return this.#playlists.addTracksToPlaylist(playlistId, trackIds, auth);
  }

  removeTracksFromPlaylist(
    playlistId: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<{ removedCount: number }> {
    return this.#playlists.removeTracksFromPlaylist(playlistId, trackIds, auth);
  }

  createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    return this.#playlists.createPlaylistWithTracks(name, trackIds, auth);
  }

  getLyrics(songId: string, mediaId: string | undefined, auth: ProviderAuthContext): Promise<SongLyrics> {
    return this.#catalog.getLyrics(songId, mediaId, auth);
  }

  getComments(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage> {
    return this.#catalog.getComments(songId, page, limit, auth);
  }

  setCommentLiked(
    songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    return this.#catalog.setCommentLiked(songId, commentId, liked, auth);
  }

  getLikedSongIds(auth: ProviderAuthContext): Promise<string[]> {
    return this.#likeStore.getLikedSongIds(auth, (c) => this.verifyCredential(c));
  }

  toggleSongLike(songId: string, liked: boolean, auth: ProviderAuthContext): Promise<{ liked: boolean }> {
    return this.#likeStore.toggleSongLike(songId, liked, auth);
  }

  resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    return this.#catalog.resolveAudio(target, level, mode, auth);
  }

  startQrLogin(scopeKey: string): Promise<QrStartResult> {
    return this.#qrAuth.start(scopeKey);
  }

  checkQrLogin(scopeKey: string, key: string): Promise<ProviderQrCheckResult> {
    return this.#qrAuth.check(scopeKey, key, (c) => this.verifyCredential(c));
  }
}
