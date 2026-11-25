import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  ChartDetail,
  ChartSummary,
  CloudTracksPage,
  EntitySearchResult,
  EntitySearchType,
  MusicPlatform,
  PersonalFmMode,
  PlaylistSummary,
  PlaylistTracksPage,
  ProviderMode,
  Song,
  SongCommentsPage,
  SongLyrics,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type {
  PlaylistTrackQuery,
  ProviderAuthContext,
  ProviderRegistry,
} from "../../domain/ports/music-provider.js";
import type { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";

export class CatalogService {
  readonly #providers: ProviderRegistry;
  readonly #authResolver: ProviderAuthResolver;
  readonly #userState: UserStateRepository;

  constructor(deps: {
    providers: ProviderRegistry;
    authResolver: ProviderAuthResolver;
    userState: UserStateRepository;
  }) {
    this.#providers = deps.providers;
    this.#authResolver = deps.authResolver;
    this.#userState = deps.userState;
  }

  #buildPersonalAuth(actor: ActorContext, platform: MusicPlatform): ProviderAuthContext {
    return this.#authResolver.buildPersonalAuth(actor, platform);
  }

  #buildPublicReadAuth(actor: ActorContext, platform: MusicPlatform): ProviderAuthContext {
    return this.#authResolver.buildPublicReadAuth(actor, platform);
  }

  async search(
    actor: ActorContext,
    query: string,
    mode: ProviderMode,
  ): Promise<{ results: Song[]; warnings: string[] }> {
    const keyword = query.trim();
    if (!keyword) return { results: [], warnings: [] };

    if (mode === "netease" || mode === "qq") {
      const results = await this.#providers
        .get(mode)
        .searchTracks(keyword, this.#buildPublicReadAuth(actor, mode));
      return { results, warnings: [] };
    }

    // Aggregate mode: query both in parallel, surface partial failure explicitly in warnings instead of silent swallow
    const [neteaseRes, qqRes] = await Promise.allSettled([
      this.#providers.get("netease").searchTracks(keyword, this.#buildPublicReadAuth(actor, "netease"), 20),
      this.#providers.get("qq").searchTracks(keyword, this.#buildPublicReadAuth(actor, "qq"), 20),
    ]);

    const warnings: string[] = [];
    let neteaseSongs: Song[] = [];
    if (neteaseRes.status === "fulfilled") {
      neteaseSongs = neteaseRes.value;
    } else {
      warnings.push(
        `网易云搜索失败：${neteaseRes.reason instanceof Error ? neteaseRes.reason.message : "未知错误"}`,
      );
    }

    let qqSongs: Song[] = [];
    if (qqRes.status === "fulfilled") {
      qqSongs = qqRes.value;
    } else {
      warnings.push(`QQ 音乐搜索失败：${qqRes.reason instanceof Error ? qqRes.reason.message : "未知错误"}`);
    }

    // Interleave results fairly
    const merged: Song[] = [];
    const maxLen = Math.max(neteaseSongs.length, qqSongs.length);
    for (let i = 0; i < maxLen; i += 1) {
      const n = neteaseSongs[i];
      const q = qqSongs[i];
      if (n) merged.push(n);
      if (q) merged.push(q);
    }

    return { results: merged, warnings };
  }

  async searchEntities(
    actor: ActorContext,
    query: string,
    mode: ProviderMode,
    type: EntitySearchType,
  ): Promise<EntitySearchResult> {
    const keyword = query.trim();
    if (!keyword) {
      return { type, artists: [], albums: [], playlists: [], warnings: [] };
    }

    const runSingle = async (platform: MusicPlatform) => {
      const adapter = this.#providers.get(platform);
      if (!adapter.searchEntities) {
        return {
          artists: [] as ArtistSummary[],
          albums: [] as AlbumSummary[],
          playlists: [] as PlaylistSummary[],
        };
      }
      const res = await adapter.searchEntities(keyword, type, this.#buildPublicReadAuth(actor, platform), 20);
      return {
        artists: res.artists ?? [],
        albums: res.albums ?? [],
        playlists: res.playlists ?? [],
      };
    };

    if (mode === "netease" || mode === "qq") {
      const res = await runSingle(mode);
      return { type, ...res, warnings: [] };
    }

    const [neRes, qqRes] = await Promise.allSettled([runSingle("netease"), runSingle("qq")]);
    const warnings: string[] = [];
    const ne =
      neRes.status === "fulfilled"
        ? neRes.value
        : (() => {
            warnings.push(
              `网易云搜索失败：${neRes.reason instanceof Error ? neRes.reason.message : "未知错误"}`,
            );
            return { artists: [], albums: [], playlists: [] };
          })();
    const qq =
      qqRes.status === "fulfilled"
        ? qqRes.value
        : (() => {
            warnings.push(
              `QQ 音乐搜索失败：${qqRes.reason instanceof Error ? qqRes.reason.message : "未知错误"}`,
            );
            return { artists: [], albums: [], playlists: [] };
          })();

    const interleave = <T>(a: T[], b: T[]): T[] => {
      const out: T[] = [];
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i += 1) {
        const left = a[i];
        const right = b[i];
        if (left) out.push(left);
        if (right) out.push(right);
      }
      return out;
    };

    return {
      type,
      artists: interleave(ne.artists, qq.artists),
      albums: interleave(ne.albums, qq.albums),
      playlists: interleave(ne.playlists, qq.playlists),
      warnings,
    };
  }

  async getRecommendedPlaylists(actor: ActorContext, platform: MusicPlatform): Promise<PlaylistSummary[]> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getRecommendedPlaylists) return [];
    return adapter.getRecommendedPlaylists(this.#buildPublicReadAuth(actor, platform), 10);
  }

  async getCharts(actor: ActorContext, platform: MusicPlatform): Promise<ChartSummary[]> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getCharts) return [];
    return adapter.getCharts(this.#buildPublicReadAuth(actor, platform));
  }

  async getChartDetail(actor: ActorContext, platform: MusicPlatform, chartId: string): Promise<ChartDetail> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getChartDetail) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持排行榜详情。`);
    }
    return adapter.getChartDetail(chartId, this.#buildPublicReadAuth(actor, platform));
  }

  async getArtistDetail(
    actor: ActorContext,
    platform: MusicPlatform,
    artistId: string,
  ): Promise<ArtistDetail> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getArtistDetail) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持歌手详情页。`);
    }
    return adapter.getArtistDetail(artistId, this.#buildPublicReadAuth(actor, platform));
  }

  async getAlbumDetail(actor: ActorContext, platform: MusicPlatform, albumId: string): Promise<AlbumDetail> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getAlbumDetail) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持专辑详情页。`);
    }
    return adapter.getAlbumDetail(albumId, this.#buildPublicReadAuth(actor, platform));
  }

  async getPersonalFm(actor: ActorContext, mode: PersonalFmMode = "DEFAULT"): Promise<Song[]> {
    const adapter = this.#providers.get("netease");
    if (!adapter.getPersonalFm) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持私人 FM。");
    }
    return adapter.getPersonalFm(this.#buildPersonalAuth(actor, "netease"), mode);
  }

  async trashPersonalFmSong(actor: ActorContext, songId: string): Promise<{ ok: boolean }> {
    const adapter = this.#providers.get("netease");
    if (!adapter.trashPersonalFmSong) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持私人 FM 垃圾桶。");
    }
    return adapter.trashPersonalFmSong(songId, this.#buildPersonalAuth(actor, "netease"));
  }

  async createPlaylist(actor: ActorContext, platform: MusicPlatform, name: string, trackIds: string[] = []) {
    const adapter = this.#providers.get(platform);
    if (!adapter.createPlaylistWithTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持创建歌单。`);
    }
    return adapter.createPlaylistWithTracks(name, trackIds, this.#buildPersonalAuth(actor, platform));
  }

  async getLikedSongIds(actor: ActorContext, platform: MusicPlatform): Promise<string[]> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getLikedSongIds) return [];
    return adapter.getLikedSongIds(this.#buildPersonalAuth(actor, platform));
  }

  async getDiscover(actor: ActorContext, platform?: MusicPlatform): Promise<Song[]> {
    const mode = platform ?? this.#userState.getSettings(actor.userId).providerMode;
    if (mode === "netease" || mode === "qq") {
      return this.#providers.get(mode).getDiscoverTracks(this.#buildPublicReadAuth(actor, mode));
    }

    // C030: In aggregate mode, combine discover tracks from both Netease and QQ interleaved
    const [neRes, qqRes] = await Promise.allSettled([
      this.#providers.get("netease").getDiscoverTracks(this.#buildPublicReadAuth(actor, "netease")),
      this.#providers.get("qq").getDiscoverTracks(this.#buildPublicReadAuth(actor, "qq")),
    ]);

    const neSongs = neRes.status === "fulfilled" ? neRes.value : [];
    const qqSongs = qqRes.status === "fulfilled" ? qqRes.value : [];
    if (neRes.status === "rejected" && qqRes.status === "rejected") {
      throw neRes.reason;
    }

    const merged: Song[] = [];
    const maxLen = Math.max(neSongs.length, qqSongs.length);
    for (let i = 0; i < maxLen; i += 1) {
      const n = neSongs[i];
      const q = qqSongs[i];
      if (n) merged.push(n);
      if (q) merged.push(q);
    }
    return merged;
  }

  async getDailyRecommend(actor: ActorContext): Promise<Song[]> {
    const adapter = this.#providers.get("netease");
    if (!adapter.getDailyRecommendTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持每日推荐。");
    }
    return adapter.getDailyRecommendTracks(this.#buildPersonalAuth(actor, "netease"));
  }

  async getCloudTracksPage(
    actor: ActorContext,
    options?: { offset?: number; limit?: number },
  ): Promise<CloudTracksPage> {
    const adapter = this.#providers.get("netease");
    if (adapter.getCloudTracksPage) {
      return adapter.getCloudTracksPage(this.#buildPersonalAuth(actor, "netease"), options);
    }
    if (!adapter.getCloudTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持云盘音乐。");
    }
    const all = await adapter.getCloudTracks(this.#buildPersonalAuth(actor, "netease"));
    const safeOffset = Math.max(0, Math.floor(options?.offset ?? 0) || 0);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(options?.limit ?? 100) || 100));
    const slice = all.slice(safeOffset, safeOffset + safeLimit);
    return {
      songs: slice,
      total: all.length,
      offset: safeOffset,
      nextOffset: safeOffset + slice.length,
      limit: safeLimit,
      hasMore: safeOffset + slice.length < all.length,
    };
  }

  async getUserPlaylists(actor: ActorContext, platform: MusicPlatform): Promise<PlaylistSummary[]> {
    return this.#providers.get(platform).getUserPlaylists(this.#buildPersonalAuth(actor, platform));
  }

  async getPlaylistTracks(
    actor: ActorContext,
    platform: MusicPlatform,
    playlistId: string,
    query: PlaylistTrackQuery,
  ): Promise<PlaylistTracksPage> {
    return this.#providers
      .get(platform)
      .getPlaylistTracks(playlistId, query, this.#buildPersonalAuth(actor, platform));
  }

  async addTracksToPlaylist(
    actor: ActorContext,
    platform: MusicPlatform,
    playlistId: string,
    trackIds: string[],
  ): Promise<{ addedCount: number }> {
    const adapter = this.#providers.get(platform);
    if (!adapter.addTracksToPlaylist) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持向歌单添加歌曲。`);
    }
    return adapter.addTracksToPlaylist(playlistId, trackIds, this.#buildPersonalAuth(actor, platform));
  }

  async removeTracksFromPlaylist(
    actor: ActorContext,
    platform: MusicPlatform,
    playlistId: string,
    trackIds: string[],
  ): Promise<{ removedCount: number }> {
    const adapter = this.#providers.get(platform);
    if (!adapter.removeTracksFromPlaylist) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持从歌单移除歌曲。`);
    }
    return adapter.removeTracksFromPlaylist(playlistId, trackIds, this.#buildPersonalAuth(actor, platform));
  }

  async getLyrics(
    actor: ActorContext,
    platform: MusicPlatform,
    songId: string,
    mediaId?: string,
  ): Promise<SongLyrics> {
    return this.#providers
      .get(platform)
      .getLyrics(songId, mediaId, this.#buildPublicReadAuth(actor, platform));
  }

  async getComments(
    actor: ActorContext,
    platform: MusicPlatform,
    songId: string,
    page: number,
    limit: number,
  ): Promise<SongCommentsPage> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getComments) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持评论读取。`);
    }
    return adapter.getComments(songId, page, limit, this.#buildPublicReadAuth(actor, platform));
  }

  async setCommentLiked(
    actor: ActorContext,
    platform: MusicPlatform,
    songId: string,
    commentId: string,
    liked: boolean,
  ): Promise<{ liked: boolean }> {
    const adapter = this.#providers.get(platform);
    if (!adapter.setCommentLiked) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持评论点赞。`);
    }
    return adapter.setCommentLiked(songId, commentId, liked, this.#buildPersonalAuth(actor, platform));
  }

  async toggleSongLike(
    actor: ActorContext,
    platform: MusicPlatform,
    songId: string,
    liked: boolean,
  ): Promise<{ liked: boolean }> {
    const adapter = this.#providers.get(platform);
    if (!adapter.toggleSongLike) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持红心收藏。`);
    }
    return adapter.toggleSongLike(songId, liked, this.#buildPersonalAuth(actor, platform));
  }
}
