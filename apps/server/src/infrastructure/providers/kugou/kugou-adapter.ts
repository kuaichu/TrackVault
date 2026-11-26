import {
  type AlbumDetail,
  type ArtistDetail,
  type ChartDetail,
  type ChartSummary,
  type EntitySearchType,
  type PlaylistSummary,
  type PlaylistTracksPage,
  type ProviderCapabilities,
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
  CreatePlaylistResult,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ProviderQrCheckResult,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { KugouAudioResolver } from "./kugou-audio-resolver.js";
import { KugouCatalogService } from "./kugou-catalog-service.js";
import { extractEssentialKugouCookie, serializeKugouCookie } from "./kugou-cookie.js";
import { type KugouEdition, kugouRsaRawEncryptHex } from "./kugou-crypto.js";
import { KugouHttpClient } from "./kugou-http-client.js";
import { KugouPlaylistService } from "./kugou-playlist-service.js";
import { KUGOU_QR_CHANNELS, KugouQrAuthManager } from "./kugou-qr-auth.js";

interface RawKugouMyInfoResponse {
  status?: number;
  error_code?: number;
  data?: {
    nickname?: string;
    pic?: string;
    user_type?: number;
    vip_type?: number;
    y_type?: number;
    m_type?: number;
  };
}

interface RawKugouVipDetailResponse {
  status?: number;
  data?: {
    is_vip?: number;
    vip_type?: number;
    y_type?: number;
    m_type?: number;
    vip_end_time?: string;
    busi_vip?: Array<{
      is_vip?: number;
      vip_end_time?: string;
    }>;
  };
}

function parseKugouTimeMs(raw?: string): number | null {
  if (!raw?.trim()) return null;
  const parsed = Date.parse(`${raw.trim().replace(" ", "T")}+08:00`);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class KugouMusicAdapter implements MusicProviderAdapter {
  readonly platform = "kugou" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "kugou",
    canLikeSong: false,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: false,
    canQrLogin: true,
    qrLoginChannels: [...KUGOU_QR_CHANNELS],
    shareUrlTemplate: "https://www.kugou.com/song/#hash={id}",
  };

  readonly #client: KugouHttpClient;
  readonly #qrAuth: KugouQrAuthManager;
  readonly #catalog: KugouCatalogService;
  readonly #playlists: KugouPlaylistService;
  readonly #audioResolver: KugouAudioResolver;

  constructor(http: SafeHttpClient, options?: { seedGuid?: string }) {
    this.#client = new KugouHttpClient(http, options?.seedGuid);
    this.#qrAuth = new KugouQrAuthManager(this.#client);
    this.#catalog = new KugouCatalogService(this.#client);
    this.#playlists = new KugouPlaylistService(this.#client);
    this.#audioResolver = new KugouAudioResolver(this.#client);
  }

  invalidateScope(scopeKey: string): void {
    this.#qrAuth.invalidateScope(scopeKey);
    this.#catalog.invalidateScope(scopeKey);
    this.#playlists.invalidateScope(scopeKey);
  }

  close(): void {
    this.#qrAuth.close();
  }

  async #probeEditionCredential(
    userid: string,
    token: string,
    edition: KugouEdition,
    extra: Partial<ReturnType<typeof extractEssentialKugouCookie>>,
  ): Promise<CredentialVerificationResult> {
    const clienttime = Math.floor(Date.now() / 1000);
    const pk = kugouRsaRawEncryptHex({ token, clienttime }, edition).toUpperCase();
    const dfid = extra.dfid || (await this.#client.ensureDfid(edition));
    const cookieMap = {
      userid,
      token,
      kg_edition: edition,
      dfid,
      ...(extra.vip_type ? { vip_type: extra.vip_type } : {}),
      ...(extra.vip_token ? { vip_token: extra.vip_token } : {}),
      ...(extra.t1 ? { t1: extra.t1 } : {}),
    };

    try {
      const [infoRes, vipRes] = await Promise.allSettled([
        this.#client.request<RawKugouMyInfoResponse>({
          path: "/v3/get_my_info",
          method: "POST",
          params: { plat: 1 },
          data: {
            visit_time: clienttime,
            usertype: 1,
            p: pk,
            userid: Number(userid),
          },
          headers: { "x-router": "usercenter.kugou.com" },
          cookieMap,
          edition,
        }),
        this.#client.request<RawKugouVipDetailResponse>({
          baseUrl: "https://kugouvip.kugou.com",
          path: "/v1/get_union_vip",
          method: "GET",
          params: { busi_type: "concept" },
          cookieMap,
          edition,
        }),
      ]);

      if (infoRes.status === "rejected") {
        return {
          ok: false,
          accountUid: userid,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: infoRes.reason instanceof Error ? infoRes.reason.message : "酷狗登录凭证校验请求失败。",
        };
      }

      const myInfo = infoRes.value;
      if (myInfo.status !== 1) {
        return {
          ok: false,
          accountUid: userid,
          displayName: null,
          avatarUrl: null,
          vipEnabled: false,
          vipExpireAt: null,
          message: `酷狗${edition === "lite" ? "概念版" : "标准版"}凭证无效或已过期 (code ${myInfo.error_code ?? "unknown"})。`,
        };
      }

      const vipData =
        vipRes.status === "fulfilled" && vipRes.value.status === 1 ? vipRes.value.data : undefined;
      const activeBusiVip = vipData?.busi_vip?.find((b) => Number(b.is_vip ?? 0) > 0);
      const vipType = Number(vipData?.vip_type ?? myInfo.data?.vip_type ?? extra.vip_type ?? 0) || 0;
      const yType = Number(vipData?.y_type ?? myInfo.data?.y_type ?? 0) || 0;
      const mType = Number(vipData?.m_type ?? myInfo.data?.m_type ?? 0) || 0;
      const vipEnabled = Boolean(
        Number(vipData?.is_vip ?? 0) > 0 || activeBusiVip || vipType > 0 || yType > 0 || mType > 0,
      );
      const vipExpireAt = parseKugouTimeMs(activeBusiVip?.vip_end_time ?? vipData?.vip_end_time);

      const editionTag = edition === "lite" ? "概念版" : "标准版";
      const baseNick = myInfo.data?.nickname?.trim() || `酷狗 ${userid}`;
      const displayName = `${baseNick} (${editionTag})`;
      const avatarUrl = normalizeCoverUrl(myInfo.data?.pic, 200) ?? null;

      const normalizedCookie = serializeKugouCookie({
        ...cookieMap,
        ...(vipType > 0 && !cookieMap.vip_type ? { vip_type: String(vipType) } : {}),
      });

      return {
        ok: true,
        accountUid: userid,
        displayName,
        avatarUrl,
        vipEnabled,
        vipExpireAt,
        normalizedCookie,
        message: `酷狗音乐账号验证成功：${displayName}`,
      };
    } catch (error) {
      return {
        ok: false,
        accountUid: userid,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: error instanceof Error ? error.message : "酷狗凭证校验失败。",
      };
    }
  }

  async verifyCredential(cookie: string): Promise<CredentialVerificationResult> {
    const essential = extractEssentialKugouCookie(cookie);
    if (!essential.userid) {
      return {
        ok: false,
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "酷狗音乐 Cookie 缺少有效的 userid。",
      };
    }
    if (!essential.token) {
      return {
        ok: false,
        accountUid: essential.userid,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        message: "酷狗音乐 Cookie 缺少 token。",
      };
    }

    if (essential.kg_edition) {
      return this.#probeEditionCredential(essential.userid, essential.token, essential.kg_edition, essential);
    }

    // When manually pasting raw `userid=...; token=...` without explicit edition, probe Concept (`lite`) then Standard
    const liteAttempt = await this.#probeEditionCredential(
      essential.userid,
      essential.token,
      "lite",
      essential,
    );
    if (liteAttempt.ok) return liteAttempt;

    const stdAttempt = await this.#probeEditionCredential(
      essential.userid,
      essential.token,
      "standard",
      essential,
    );
    if (stdAttempt.ok) return stdAttempt;

    return liteAttempt;
  }

  searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    return this.#catalog.searchTracks(query, auth, limit);
  }

  getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    return this.#catalog.getDiscoverTracks(auth);
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

  getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    return this.#playlists.getUserPlaylists(auth);
  }

  getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    return this.#playlists.getPlaylistTracks(playlistId, query, auth);
  }

  getAllPlaylistTracks(playlistId: string, auth: ProviderAuthContext, maxTracks = 2000): Promise<Song[]> {
    return this.#playlists.getAllPlaylistTracks(playlistId, auth, maxTracks);
  }

  createPlaylistWithTracks(
    name: string,
    trackIds: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    return this.#playlists.createPlaylistWithTracks(name, trackIds, auth);
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

  resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    return this.#audioResolver.resolveAudio(target, level, mode, auth);
  }

  startQrLogin(scopeKey: string, options?: { channel?: QrLoginChannel }): Promise<QrStartResult> {
    return this.#qrAuth.start(scopeKey, options?.channel);
  }

  async checkQrLogin(scopeKey: string, key: string): Promise<ProviderQrCheckResult> {
    const check = await this.#qrAuth.check(scopeKey, key);
    if (check.status === "confirmed" && check.rawCookie) {
      const baseVerification = await this.verifyCredential(check.rawCookie);
      if (!baseVerification.ok) {
        return { ...check, verification: baseVerification };
      }
      const avatarUrl = baseVerification.avatarUrl ?? normalizeCoverUrl(check.avatarUrl, 200) ?? null;
      return {
        ...check,
        verification: {
          ...baseVerification,
          avatarUrl,
        },
      };
    }
    return check;
  }
}
