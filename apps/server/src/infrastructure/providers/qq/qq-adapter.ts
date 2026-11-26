import {
  type AlbumDetail,
  type ArtistDetail,
  type ChartDetail,
  type ChartSummary,
  type EntitySearchType,
  type PlaylistSummary,
  type PlaylistTracksPage,
  type ProviderCapabilities,
  type QqQrLoginChannel,
  type QrLoginChannel,
  type QrStartResult,
  type QualityLevel,
  type Song,
  type SongCommentsPage,
  type SongLyrics,
  normalizeCoverUrl,
} from "#shared";
import type {
  AudioResolveTarget,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ProviderQrCheckResult,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { QqAudioResolver } from "./qq-audio-resolver.js";
import { QqCatalogService } from "./qq-catalog-service.js";
import { QQ_ALBUM_CID, QQ_PROFILE_HOMEPAGE_URL, type RawQqProfileResponse } from "./qq-cgi-endpoints.js";
import { computeQqGtk, extractEssentialQqCookie, serializeQqCookie } from "./qq-cookie.js";
import { QqMusicHttpClient } from "./qq-http-client.js";
import { QqPlaylistService } from "./qq-playlist-service.js";
import { QqQrAuthManager, type QqQrAuthOptions } from "./qq-qr-auth.js";

/**
 * Stateless QQ Music Adapter facade:
 * - Zero dependency on global-singleton `qq-music-api`.
 * - Explicit per-request cookies, dynamic g_tk, strict credential verification, and scoped LRU caches.
 */
export class QqMusicAdapter implements MusicProviderAdapter {
  readonly platform = "qq" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "qq",
    canLikeSong: false,
    canManagePlaylistTracks: false,
    canCreatePlaylist: false,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    qrLoginChannels: ["mobile", "qq", "wx"],
    shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
  };

  readonly #client: QqMusicHttpClient;
  readonly #qrAuth: QqQrAuthManager;
  readonly #catalog: QqCatalogService;
  readonly #playlists: QqPlaylistService;
  readonly #audioResolver: QqAudioResolver;

  constructor(http: SafeHttpClient, qrOptions?: QqQrAuthOptions) {
    this.#client = new QqMusicHttpClient(http);
    this.#qrAuth = new QqQrAuthManager(http, qrOptions);
    this.#catalog = new QqCatalogService(this.#client);
    this.#playlists = new QqPlaylistService(this.#client);
    this.#audioResolver = new QqAudioResolver(this.#client);
  }

  invalidateScope(scopeKey: string): void {
    this.#qrAuth.invalidateScope(scopeKey);
    this.#catalog.invalidateScope(scopeKey);
    this.#playlists.invalidateScope(scopeKey);
  }

  close(): void {
    this.#qrAuth.close();
  }

  async verifyCredential(cookie: string): Promise<CredentialVerificationResult> {
    const essential = extractEssentialQqCookie(cookie);
    if (!essential.uin) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "QQ 音乐 Cookie 缺少 uin 或 wxuin。",
      };
    }
    if (!essential.qm_keyst && !essential.qqmusic_key) {
      return {
        ok: false,
        accountUid: essential.uin,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "QQ 音乐 Cookie 缺少 qm_keyst 或 qqmusic_key。",
      };
    }

    const requestCookies: Record<string, string> = {
      ...essential,
      qqmusic_uin: essential.qqmusic_uin || essential.uin,
    };

    try {
      const profile = await this.#client.requestJson<RawQqProfileResponse>({
        url: QQ_PROFILE_HOMEPAGE_URL,
        query: {
          cid: QQ_ALBUM_CID,
          userid: essential.uin,
          loginUin: essential.uin,
          hostUin: 0,
          reqfrom: 1,
          format: "json",
          inCharset: "utf-8",
          outCharset: "utf-8",
          notice: 0,
          needNewCode: 0,
          g_tk: computeQqGtk(requestCookies),
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap: requestCookies,
      });

      if (
        profile.code === 1000 ||
        profile.code === 301 ||
        (profile.code !== undefined && profile.code !== 0)
      ) {
        return {
          ok: false,
          accountUid: essential.uin,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: `QQ 音乐登录态校验失败或已过期 (code ${profile.code ?? "unknown"})。`,
        };
      }

      const creator = profile.data?.creator;
      const displayName = creator?.nick?.trim() || `QQ ${essential.uin}`;
      const avatarUrl = normalizeCoverUrl(creator?.headpic, 200) ?? null;
      const vipNode = profile.data?.vip;
      const vipEnabled = Boolean(
        (typeof vipNode?.greenvip === "number" && vipNode.greenvip > 0) ||
          (typeof vipNode?.viplevel === "number" && vipNode.viplevel > 0),
      );
      const rawEnd = vipNode?.endtime;
      const vipExpireAt =
        typeof rawEnd === "number" && rawEnd > 0 ? (rawEnd > 10_000_000_000 ? rawEnd : rawEnd * 1000) : null;

      return {
        ok: true,
        accountUid: essential.uin,
        displayName,
        avatarUrl,
        vipEnabled,
        vipExpireAt,
        normalizedCookie: serializeQqCookie(requestCookies),
        message: `QQ 音乐账号验证成功：${displayName}`,
      };
    } catch (error) {
      return {
        ok: false,
        accountUid: essential.uin,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: error instanceof Error ? error.message : "QQ 音乐凭证校验请求失败。",
      };
    }
  }

  searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    return this.#catalog.searchTracks(query, auth, limit);
  }

  getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getDiscoverTracks(auth);
  }

  getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    return this.#playlists.getUserPlaylists(auth);
  }

  getAllPlaylistTracks(playlistId: string, auth: ProviderAuthContext, maxTracks = 2000): Promise<Song[]> {
    return this.#playlists.getAllPlaylistTracks(playlistId, auth, maxTracks);
  }

  getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    return this.#playlists.getPlaylistTracks(playlistId, query, auth);
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

  resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    return this.#audioResolver.resolveAudio(target, level, mode, auth);
  }

  getRecommendedPlaylists(auth: ProviderAuthContext, limit = 10): Promise<PlaylistSummary[]> {
    return this.#catalog.getRecommendedPlaylists(auth, limit);
  }

  getCharts(auth: ProviderAuthContext): Promise<ChartSummary[]> {
    return this.#catalog.getCharts(auth);
  }

  getChartDetail(chartId: string, auth: ProviderAuthContext): Promise<ChartDetail> {
    return this.#catalog.getChartDetail(chartId, auth);
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

  startQrLogin(scopeKey: string, options?: { channel?: QrLoginChannel }): Promise<QrStartResult> {
    const ch = options?.channel;
    const qqChannel: QqQrLoginChannel | undefined =
      ch === "mobile" || ch === "qq" || ch === "wx" ? ch : undefined;
    return this.#qrAuth.start(scopeKey, qqChannel);
  }

  async checkQrLogin(scopeKey: string, key: string): Promise<ProviderQrCheckResult> {
    const check = await this.#qrAuth.check(scopeKey, key);
    if (check.status === "confirmed" && check.rawCookie) {
      const baseVerification = await this.verifyCredential(check.rawCookie);
      if (!baseVerification.ok) {
        return { ...check, verification: baseVerification };
      }
      const fallbackLabel = baseVerification.accountUid ? `QQ ${baseVerification.accountUid}` : "";
      const displayName =
        baseVerification.displayName === fallbackLabel && check.nickname
          ? check.nickname
          : baseVerification.displayName;
      const avatarUrl = baseVerification.avatarUrl ?? normalizeCoverUrl(check.avatarUrl, 200) ?? null;
      return {
        ...check,
        verification: {
          ...baseVerification,
          displayName,
          avatarUrl,
        },
      };
    }
    return check;
  }
}
