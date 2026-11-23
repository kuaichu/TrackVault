import type {
  AlbumDetail,
  AlbumSummary,
  ArtistDetail,
  ArtistSummary,
  ChartDetail,
  ChartSummary,
  EntitySearchResult,
  EntitySearchType,
  MusicPlatform,
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
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";

export class CatalogService {
  readonly #providers: ProviderRegistry;
  readonly #credentials: CredentialRepository;
  readonly #userState: UserStateRepository;

  constructor(deps: {
    providers: ProviderRegistry;
    credentials: CredentialRepository;
    userState: UserStateRepository;
  }) {
    this.#providers = deps.providers;
    this.#credentials = deps.credentials;
    this.#userState = deps.userState;
  }

  #buildAuth(actor: ActorContext, platform: MusicPlatform): ProviderAuthContext {
    const binding = this.#credentials.getBindingView(actor.userId, platform);
    return {
      platform,
      cookie: this.#credentials.getDecryptedCookie(actor.userId, platform),
      scopeKey: actor.userId,
      accountUid: binding.accountUid,
    };
  }

  async search(
    actor: ActorContext,
    query: string,
    mode: ProviderMode,
  ): Promise<{ results: Song[]; warnings: string[] }> {
    const keyword = query.trim();
    if (!keyword) return { results: [], warnings: [] };

    if (mode === "netease" || mode === "qq") {
      const results = await this.#providers.get(mode).searchTracks(keyword, this.#buildAuth(actor, mode));
      return { results, warnings: [] };
    }

    // Aggregate mode: query both in parallel, surface partial failure explicitly in warnings instead of silent swallow
    const [neteaseRes, qqRes] = await Promise.allSettled([
      this.#providers.get("netease").searchTracks(keyword, this.#buildAuth(actor, "netease"), 20),
      this.#providers.get("qq").searchTracks(keyword, this.#buildAuth(actor, "qq"), 20),
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
      const res = await adapter.searchEntities(keyword, type, this.#buildAuth(actor, platform), 20);
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
    return adapter.getRecommendedPlaylists(this.#buildAuth(actor, platform), 10);
  }

  async getCharts(actor: ActorContext, platform: MusicPlatform): Promise<ChartSummary[]> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getCharts) return [];
    return adapter.getCharts(this.#buildAuth(actor, platform));
  }

  async getChartDetail(actor: ActorContext, platform: MusicPlatform, chartId: string): Promise<ChartDetail> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getChartDetail) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持排行榜详情。`);
    }
    return adapter.getChartDetail(chartId, this.#buildAuth(actor, platform));
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
    return adapter.getArtistDetail(artistId, this.#buildAuth(actor, platform));
  }

  async getAlbumDetail(actor: ActorContext, platform: MusicPlatform, albumId: string): Promise<AlbumDetail> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getAlbumDetail) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持专辑详情页。`);
    }
    return adapter.getAlbumDetail(albumId, this.#buildAuth(actor, platform));
  }

  async getPersonalFm(actor: ActorContext): Promise<Song[]> {
    const adapter = this.#providers.get("netease");
    if (!adapter.getPersonalFm) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持私人 FM。");
    }
    return adapter.getPersonalFm(this.#buildAuth(actor, "netease"));
  }

  async createPlaylist(actor: ActorContext, platform: MusicPlatform, name: string, trackIds: string[] = []) {
    const adapter = this.#providers.get(platform);
    if (!adapter.createPlaylistWithTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持创建歌单。`);
    }
    return adapter.createPlaylistWithTracks(name, trackIds, this.#buildAuth(actor, platform));
  }

  async getLikedSongIds(actor: ActorContext, platform: MusicPlatform): Promise<string[]> {
    const adapter = this.#providers.get(platform);
    if (!adapter.getLikedSongIds) return [];
    return adapter.getLikedSongIds(this.#buildAuth(actor, platform));
  }

  async getDiscover(actor: ActorContext, platform?: MusicPlatform): Promise<Song[]> {
    const resolved: MusicPlatform =
      platform ?? (this.#userState.getSettings(actor.userId).providerMode === "qq" ? "qq" : "netease");
    return this.#providers.get(resolved).getDiscoverTracks(this.#buildAuth(actor, resolved));
  }

  async getDailyRecommend(actor: ActorContext): Promise<Song[]> {
    const adapter = this.#providers.get("netease");
    if (!adapter.getDailyRecommendTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持每日推荐。");
    }
    return adapter.getDailyRecommendTracks(this.#buildAuth(actor, "netease"));
  }

  async getCloudTracks(actor: ActorContext): Promise<Song[]> {
    const adapter = this.#providers.get("netease");
    if (!adapter.getCloudTracks) {
      throw new AppError("FEATURE_UNSUPPORTED", "暂不支持云盘音乐。");
    }
    return adapter.getCloudTracks(this.#buildAuth(actor, "netease"));
  }

  async getUserPlaylists(actor: ActorContext, platform: MusicPlatform): Promise<PlaylistSummary[]> {
    return this.#providers.get(platform).getUserPlaylists(this.#buildAuth(actor, platform));
  }

  async getPlaylistTracks(
    actor: ActorContext,
    platform: MusicPlatform,
    playlistId: string,
    query: PlaylistTrackQuery,
  ): Promise<PlaylistTracksPage> {
    return this.#providers
      .get(platform)
      .getPlaylistTracks(playlistId, query, this.#buildAuth(actor, platform));
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
    return adapter.addTracksToPlaylist(playlistId, trackIds, this.#buildAuth(actor, platform));
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
    return adapter.removeTracksFromPlaylist(playlistId, trackIds, this.#buildAuth(actor, platform));
  }

  async getLyrics(
    actor: ActorContext,
    platform: MusicPlatform,
    songId: string,
    mediaId?: string,
  ): Promise<SongLyrics> {
    return this.#providers.get(platform).getLyrics(songId, mediaId, this.#buildAuth(actor, platform));
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
    return adapter.getComments(songId, page, limit, this.#buildAuth(actor, platform));
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
    return adapter.setCommentLiked(songId, commentId, liked, this.#buildAuth(actor, platform));
  }

  async isSongLiked(actor: ActorContext, platform: MusicPlatform, songId: string): Promise<boolean> {
    const adapter = this.#providers.get(platform);
    if (!adapter.isSongLiked) return false;
    return adapter.isSongLiked(songId, this.#buildAuth(actor, platform));
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
    return adapter.toggleSongLike(songId, liked, this.#buildAuth(actor, platform));
  }
}
