import { mergeLyricTranslations, parseLrc } from "#audio-tags";
import {
  type PlaylistSort,
  type PlaylistSummary,
  type PlaylistTracksPage,
  type ProviderCapabilities,
  type QrCheckResult,
  type QrStartResult,
  type QualityLevel,
  type Song,
  type SongCommentsPage,
  type SongLyrics,
  normalizeCoverUrl,
} from "#shared";
import { AppError } from "../../../domain/errors.js";
import { buildDownwardQualityOrder, isQualityDowngraded } from "../../../domain/policies/quality-policy.js";
import type {
  AudioResolveTarget,
  CreatePlaylistResult,
  CredentialVerificationResult,
  MusicProviderAdapter,
  PlaylistTrackQuery,
  ProviderAuthContext,
  ResolvedAudio,
} from "../../../domain/ports/music-provider.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { ScopedLruCache } from "../../security/scoped-lru-cache.js";
import { computeQqGtk, extractEssentialQqCookie, parseQqCookie, serializeQqCookie } from "./qq-cookie.js";
import { QqMusicHttpClient } from "./qq-http-client.js";
import {
  type RawQqComment,
  type RawQqPlaylist,
  type RawQqSong,
  mapQqComment,
  mapQqPlaylist,
  mapQqSong,
} from "./qq-mapper.js";
import { QqQrAuthManager } from "./qq-qr-auth.js";

type QqFileSpec = { prefix: string; ext: string; bitrate: number; level: QualityLevel };

const QQ_QUALITY_SPECS: Record<"flac" | "320" | "128" | "m4a", QqFileSpec> = {
  flac: { prefix: "F000", ext: "flac", bitrate: 950_000, level: "lossless" },
  "320": { prefix: "M800", ext: "mp3", bitrate: 320_000, level: "exhigh" },
  "128": { prefix: "M500", ext: "mp3", bitrate: 128_000, level: "standard" },
  m4a: { prefix: "C400", ext: "m4a", bitrate: 96_000, level: "standard" },
};

function levelToQqSpecs(level: QualityLevel): QqFileSpec[] {
  const ordered = buildDownwardQualityOrder(level);
  const specs: QqFileSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: QqFileSpec) => {
    if (!seen.has(spec.prefix)) {
      seen.add(spec.prefix);
      specs.push(spec);
    }
  };
  for (const item of ordered) {
    if (item === "hires" || item === "lossless" || item === "jymaster") add(QQ_QUALITY_SPECS.flac);
    else if (item === "exhigh" || item === "jyeffect" || item === "sky") add(QQ_QUALITY_SPECS["320"]);
    else add(QQ_QUALITY_SPECS["128"]);
  }
  add(QQ_QUALITY_SPECS["128"]);
  add(QQ_QUALITY_SPECS.m4a);
  return specs;
}

function decodeBase64IfNeeded(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  if (raw.trim().startsWith("[")) return raw;
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function sortAndFilterSongs(songs: Song[], keyword?: string, sort?: PlaylistSort): Song[] {
  const needle = keyword?.trim().toLowerCase() ?? "";
  let list = needle
    ? songs.filter(
        (s) =>
          s.title.toLowerCase().includes(needle) ||
          s.artist.toLowerCase().includes(needle) ||
          s.album.toLowerCase().includes(needle),
      )
    : [...songs];

  switch (sort) {
    case "title-asc":
      list = list.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
      break;
    case "title-desc":
      list = list.sort((a, b) => b.title.localeCompare(a.title, "zh-CN"));
      break;
    case "artist-asc":
      list = list.sort((a, b) => a.artist.localeCompare(b.artist, "zh-CN"));
      break;
    case "duration-desc":
      list = list.sort((a, b) => b.durationSeconds - a.durationSeconds);
      break;
    case "duration-asc":
      list = list.sort((a, b) => a.durationSeconds - b.durationSeconds);
      break;
    default:
      break;
  }
  return list;
}

/**
 * Stateless QQ Music Adapter:
 * - Zero dependency on the global-singleton `qq-music-api` library.
 * - Explicit per-request cookies, dynamic g_tk, strict credential verification, and scoped LRU caches.
 */
export class QqMusicAdapter implements MusicProviderAdapter {
  readonly platform = "qq" as const;
  readonly capabilities: ProviderCapabilities = {
    platform: "qq",
    canLikeSong: false,
    canManagePlaylistTracks: false,
    canCreatePlaylist: true,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
  };

  readonly #client: QqMusicHttpClient;
  readonly #qrAuth: QqQrAuthManager;
  readonly #discoverCache = new ScopedLruCache<Song[]>({ maxEntries: 20, defaultTtlMs: 5 * 60 * 1000 });
  readonly #playlistCache = new ScopedLruCache<{ playlist: PlaylistSummary; songs: Song[] }>({
    maxEntries: 80,
    defaultTtlMs: 2 * 60 * 1000,
  });
  readonly #lyricCache = new ScopedLruCache<SongLyrics>({ maxEntries: 300, defaultTtlMs: 30 * 60 * 1000 });

  constructor(http: SafeHttpClient) {
    this.#client = new QqMusicHttpClient(http);
    this.#qrAuth = new QqQrAuthManager(http);
  }

  #parseCookie(auth: ProviderAuthContext): Record<string, string> | undefined {
    if (!auth.cookie?.trim()) return undefined;
    const parsed = parseQqCookie(auth.cookie);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  }

  #requireCookie(auth: ProviderAuthContext): Record<string, string> {
    const parsed = this.#parseCookie(auth);
    if (!parsed?.uin || !(parsed.qm_keyst || parsed.qqmusic_key)) {
      throw new AppError("CREDENTIAL_REQUIRED", "请先绑定有效的 QQ 音乐账号凭证。");
    }
    return parsed;
  }

  /**
   * Real upstream credential verification (fixes v1 bug that returned ok: true on catch).
   */
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

    try {
      const profile = await this.#client.requestJson<{
        code?: number;
        data?: {
          creator?: {
            nick?: string;
            headpic?: string;
            uin?: string | number;
            userInfoUI?: { iconlist?: Array<{ type?: number; desc?: string }> };
            nums?: Record<string, unknown>;
          };
          vip?: { viplevel?: number; greenvip?: number; endtime?: number };
        };
      }>({
        url: "https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg",
        query: {
          cid: 205360838,
          userid: essential.uin,
          reqfrom: 1,
          format: "json",
          g_tk: computeQqGtk(essential),
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap: essential,
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
      // Explicit VIP path check (no recursive blind scan over arbitrary "lv"/"green" keys)
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
        normalizedCookie: serializeQqCookie(essential),
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

  async searchTracks(query: string, auth: ProviderAuthContext, limit = 25): Promise<Song[]> {
    const keyword = query.trim();
    if (!keyword) return [];
    const safeLimit = Math.min(50, Math.max(1, limit));
    const cookieMap = this.#parseCookie(auth);

    const response = await this.#client.musicu<{
      req?: { data?: { body?: { song?: { list?: RawQqSong[] } } } };
    }>(
      {
        req: {
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: {
            query: keyword,
            search_type: 0,
            num_per_page: safeLimit,
            page_num: 1,
          },
        },
      },
      cookieMap,
    );

    const list = response.req?.data?.body?.song?.list ?? [];
    if (list.length > 0) {
      return list.map(mapQqSong).filter((song): song is Song => song !== null);
    }

    // Clean single fallback to legacy search endpoint
    const fallback = await this.#client.requestJson<{ data?: { song?: { list?: RawQqSong[] } } }>({
      url: "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
      query: {
        format: "json",
        w: keyword,
        p: 1,
        n: safeLimit,
        cr: 1,
        g_tk: cookieMap ? computeQqGtk(cookieMap) : 5381,
      },
      cookieMap,
    });
    return (fallback.data?.song?.list ?? []).map(mapQqSong).filter((song): song is Song => song !== null);
  }

  async getDiscoverTracks(auth: ProviderAuthContext): Promise<Song[]> {
    const cached = this.#discoverCache.get("public", "discover");
    if (cached) return cached;

    const cookieMap = this.#parseCookie(auth);
    const response = await this.#client.musicu<{
      new_song?: { data?: { songlist?: RawQqSong[] } };
    }>(
      {
        new_song: {
          module: "newsong.NewSongServer",
          method: "get_new_song_info",
          param: { type: 5 },
        },
      },
      cookieMap,
    );

    const songs = (response.new_song?.data?.songlist ?? [])
      .map(mapQqSong)
      .filter((song): song is Song => song !== null)
      .slice(0, 30);

    this.#discoverCache.set("public", "discover", songs);
    return songs;
  }

  async getUserPlaylists(auth: ProviderAuthContext): Promise<PlaylistSummary[]> {
    const cookieMap = this.#requireCookie(auth);
    const gtk = computeQqGtk(cookieMap);

    const [createdRes, collectedRes] = await Promise.allSettled([
      this.#client.requestJson<{
        data?: { hostname?: string; disslist?: RawQqPlaylist[] };
      }>({
        url: "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss",
        query: {
          hostUin: 0,
          hostuin: cookieMap.uin,
          sin: 0,
          size: 200,
          g_tk: gtk,
          loginUin: cookieMap.uin,
          format: "json",
          inCharset: "utf8",
          outCharset: "utf-8",
          notice: 0,
          platform: "yqq.json",
          needNewCode: 0,
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap,
      }),
      this.#client.requestJson<{
        data?: { cdlist?: RawQqPlaylist[] };
      }>({
        url: "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
        query: {
          ct: 20,
          cid: 205360956,
          userid: cookieMap.uin,
          reqtype: 3,
          sin: 0,
          ein: 50,
          format: "json",
          g_tk: gtk,
        },
        referer: "https://y.qq.com/portal/profile.html",
        cookieMap,
      }),
    ]);

    const fallbackCreator =
      createdRes.status === "fulfilled"
        ? createdRes.value.data?.hostname?.trim() || `QQ ${cookieMap.uin}`
        : `QQ ${cookieMap.uin}`;

    const created =
      createdRes.status === "fulfilled"
        ? (createdRes.value.data?.disslist ?? [])
            .map((p) => mapQqPlaylist(p, fallbackCreator, true))
            .filter((p): p is PlaylistSummary => p !== null)
        : [];

    const collected =
      collectedRes.status === "fulfilled"
        ? (collectedRes.value.data?.cdlist ?? [])
            .map((p) => mapQqPlaylist(p, fallbackCreator, false))
            .filter((p): p is PlaylistSummary => p !== null)
        : [];

    const seen = new Set<string>();
    return [...created, ...collected].filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  async #fetchPlaylistRaw(
    playlistId: string,
    auth: ProviderAuthContext,
  ): Promise<{ playlist: PlaylistSummary; songs: Song[] }> {
    const cleanId = playlistId.replace(/^qq:/i, "").trim();
    if (!cleanId) {
      throw new AppError("VALIDATION_ERROR", "缺少 QQ 音乐歌单 ID。");
    }

    const cached = this.#playlistCache.get(auth.scopeKey, cleanId);
    if (cached) return cached;

    const cookieMap = this.#parseCookie(auth);
    const data = await this.#client.requestJson<{
      cdlist?: Array<{
        disstid?: string;
        dissname?: string;
        logo?: string;
        nickname?: string;
        desc?: string;
        songlist?: RawQqSong[];
      }>;
    }>({
      url: "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
      query: {
        type: 1,
        utf8: 1,
        disstid: cleanId,
        loginUin: cookieMap?.uin ?? 0,
        format: "json",
      },
      referer: "https://y.qq.com/n/yqq/playlist",
      cookieMap,
    });

    const cd = data.cdlist?.[0];
    const songs = (cd?.songlist ?? []).map(mapQqSong).filter((s): s is Song => s !== null);
    const playlist: PlaylistSummary = {
      id: cleanId,
      platform: "qq",
      name: cd?.dissname?.trim() || `QQ 歌单 ${cleanId}`,
      coverUrl: normalizeCoverUrl(cd?.logo, 300),
      trackCount: songs.length,
      creatorName: cd?.nickname?.trim() || "QQ 音乐用户",
      owned: false,
      description: cd?.desc?.trim() || undefined,
    };

    const bundle = { playlist, songs };
    this.#playlistCache.set(auth.scopeKey, cleanId, bundle);
    return bundle;
  }

  async getAllPlaylistTracks(
    playlistId: string,
    auth: ProviderAuthContext,
    maxTracks = 2000,
  ): Promise<Song[]> {
    const { songs } = await this.#fetchPlaylistRaw(playlistId, auth);
    return songs.slice(0, maxTracks);
  }

  async getPlaylistTracks(
    playlistId: string,
    query: PlaylistTrackQuery,
    auth: ProviderAuthContext,
  ): Promise<PlaylistTracksPage> {
    const safePage = Math.max(1, Math.floor(query.page) || 1);
    const safeLimit = Math.min(200, Math.max(1, Math.floor(query.limit) || 50));
    const { playlist, songs: allSongs } = await this.#fetchPlaylistRaw(playlistId, auth);

    const filtered = sortAndFilterSongs(allSongs, query.keyword, query.sort);
    const offset = (safePage - 1) * safeLimit;
    const pageSongs = filtered.slice(offset, offset + safeLimit);

    return {
      playlist,
      songs: pageSongs,
      total: filtered.length,
      page: safePage,
      limit: safeLimit,
      hasMore: offset + pageSongs.length < filtered.length,
    };
  }

  async createPlaylistWithTracks(
    name: string,
    trackMids: string[],
    auth: ProviderAuthContext,
  ): Promise<CreatePlaylistResult> {
    const cookieMap = this.#requireCookie(auth);
    const playlistName = name.trim();
    const uniqueMids = [...new Set(trackMids.map((m) => m.trim()).filter(Boolean))];
    if (!playlistName) throw new AppError("VALIDATION_ERROR", "请输入 QQ 音乐新歌单名称。");
    if (uniqueMids.length === 0) throw new AppError("VALIDATION_ERROR", "没有可导入的 QQ 歌曲。");

    const gtk = computeQqGtk(cookieMap);
    const createBody = new URLSearchParams({
      loginUin: cookieMap.uin ?? "",
      hostUin: "0",
      format: "json",
      inCharset: "utf8",
      outCharset: "utf8",
      notice: "0",
      platform: "yqq",
      needNewCode: "0",
      g_tk: String(gtk),
      uin: cookieMap.uin ?? "",
      name: playlistName,
      show: "1",
      formsender: "1",
      utf8: "1",
      qzreferrer: "https://y.qq.com/portal/profile.html",
    }).toString();

    const created = await this.#client.requestJson<{ code?: number; dirid?: number | string; msg?: string }>({
      url: "https://c.y.qq.com/splcloud/fcgi-bin/create_playlist.fcg",
      method: "POST",
      query: { g_tk: gtk },
      body: createBody,
      contentType: "application/x-www-form-urlencoded",
      referer: "https://y.qq.com/n/yqq/playlist",
      cookieMap,
    });

    if (Number(created.code) !== 0 || !created.dirid) {
      throw new AppError(
        "UPSTREAM_ERROR",
        created.msg || `创建 QQ 歌单失败 (code ${created.code ?? "unknown"})`,
      );
    }

    const dirid = String(created.dirid);
    const chunkSize = 50;
    for (let i = 0; i < uniqueMids.length; i += chunkSize) {
      const chunk = uniqueMids.slice(i, i + chunkSize);
      const addRes = await this.#client.requestJson<{ code?: number; msg?: string }>({
        url: "https://c.y.qq.com/splcloud/fcgi-bin/fcg_music_add2songdir.fcg",
        query: {
          g_tk: gtk,
          midlist: chunk.join(","),
          typelist: chunk.map(() => "13").join(","),
          dirid,
          addtype: "",
          formsender: 4,
          r2: 0,
          r3: 1,
          utf8: 1,
          format: "json",
        },
        referer: "https://y.qq.com/n/yqq/playlist",
        cookieMap,
      });
      if (Number(addRes.code) !== 0) {
        throw new AppError("UPSTREAM_ERROR", addRes.msg || `向 QQ 歌单添加歌曲失败 (code ${addRes.code})`);
      }
    }

    return {
      playlistId: dirid,
      playlistName,
      playlistUrl: "https://y.qq.com/n/ryqq/profile/like/song",
      addedCount: uniqueMids.length,
    };
  }

  async getLyrics(
    songId: string,
    mediaId: string | undefined,
    _auth: ProviderAuthContext,
  ): Promise<SongLyrics> {
    const targetMid = (mediaId && !/^\d+$/.test(mediaId) ? mediaId : songId).trim();
    const cached = this.#lyricCache.get("public", targetMid);
    if (cached) return cached;

    try {
      const data = await this.#client.requestJson<{ lyric?: string; trans?: string }>({
        url: "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
        query: {
          songmid: targetMid,
          pcachetime: Date.now(),
          g_tk: 5381,
          loginUin: 0,
          hostUin: 0,
          format: "json",
          inCharset: "utf8",
          outCharset: "utf-8",
          notice: 0,
          platform: "yqq",
          needNewCode: 0,
        },
        referer: "https://y.qq.com/",
      });

      const lines = mergeLyricTranslations(
        parseLrc(decodeBase64IfNeeded(data.lyric)),
        parseLrc(decodeBase64IfNeeded(data.trans)),
      );
      const result: SongLyrics = {
        songId,
        platform: "qq",
        lines,
        source: lines.length > 0 ? "qqmusic" : "none",
      };
      this.#lyricCache.set("public", targetMid, result, lines.length > 0 ? 30 * 60 * 1000 : 5 * 60 * 1000);
      return result;
    } catch {
      return { songId, platform: "qq", lines: [], source: "none" };
    }
  }

  async getComments(
    songId: string,
    page: number,
    limit: number,
    auth: ProviderAuthContext,
  ): Promise<SongCommentsPage> {
    const safeId = songId.trim();
    if (!/^\d+$/.test(safeId)) {
      throw new AppError("VALIDATION_ERROR", "QQ 音乐评论需要数字 songid。");
    }
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));
    const cookieMap = this.#parseCookie(auth);

    const data = await this.#client.requestJson<{
      comment?: { commenttotal?: number; commentlist?: RawQqComment[] };
      hot_comment?: { commentlist?: RawQqComment[] };
    }>({
      url: "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg",
      query: {
        biztype: 1,
        topid: safeId,
        loginUin: cookieMap?.uin ?? 0,
        cmd: 8,
        pagenum: safePage - 1,
        pagesize: safeLimit,
        format: "json",
      },
      cookieMap,
    });

    const comments = (data.comment?.commentlist ?? [])
      .map(mapQqComment)
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const hotComments =
      safePage === 1
        ? (data.hot_comment?.commentlist ?? [])
            .map(mapQqComment)
            .filter((c): c is NonNullable<typeof c> => c !== null)
        : [];
    const total = Math.max(0, Number(data.comment?.commenttotal ?? 0) || comments.length);

    return {
      songId: safeId,
      platform: "qq",
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: comments.length >= safeLimit,
      hotComments,
      comments,
    };
  }

  async setCommentLiked(
    _songId: string,
    commentId: string,
    liked: boolean,
    auth: ProviderAuthContext,
  ): Promise<{ liked: boolean }> {
    const cookieMap = this.#requireCookie(auth);
    const res = await this.#client.requestJson<{ code?: number; msg?: string }>({
      url: "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_praise_h5.fcg",
      query: {
        g_tk: computeQqGtk(cookieMap),
        loginUin: cookieMap.uin,
        format: "json",
        inCharset: "utf8",
        outCharset: "utf-8",
        cmd: liked ? 1 : 2,
        reqtype: 2,
        commentid: commentId.trim(),
      },
      cookieMap,
    });
    if (Number(res.code ?? 0) !== 0) {
      throw new AppError("UPSTREAM_ERROR", res.msg || "QQ 音乐评论点赞失败。");
    }
    return { liked };
  }

  async resolveAudio(
    target: AudioResolveTarget,
    level: QualityLevel,
    _mode: "playback" | "download",
    auth: ProviderAuthContext,
  ): Promise<ResolvedAudio> {
    const cookieMap = this.#parseCookie(auth);
    const songMid = target.id.trim();
    const mediaMid = (target.mediaId || songMid).trim();
    const specs = levelToQqSpecs(level);
    const guid = String(Math.floor(Math.random() * 10_000_000));

    for (const spec of specs) {
      const filename = `${spec.prefix}${mediaMid}${spec.ext ? `.${spec.ext}` : ""}`;
      const res = await this.#client
        .musicu<{
          req_0?: {
            data?: {
              sip?: string[];
              midurlinfo?: Array<{ purl?: string; songmid?: string }>;
            };
          };
        }>(
          {
            req_0: {
              module: "vkey.GetVkeyServer",
              method: "CgiGetVkey",
              param: {
                filename: [filename],
                guid,
                songmid: [songMid],
                songtype: [0],
                uin: cookieMap?.uin ?? "0",
                loginflag: 1,
                platform: "20",
              },
            },
          },
          cookieMap,
        )
        .catch(() => null);

      const purl = res?.req_0?.data?.midurlinfo?.[0]?.purl?.trim();
      const sipList = res?.req_0?.data?.sip ?? [];
      const sip = sipList.find((s) => s.startsWith("https://")) ?? sipList[0];
      if (!purl || !sip) continue;

      const fullUrl = `${sip.replace(/^http:\/\//i, "https://")}${purl}`;
      const downgraded = isQualityDowngraded(level, {
        bitrate: spec.bitrate,
        format: spec.ext,
        level: spec.level,
      });

      return {
        url: fullUrl,
        format: spec.ext,
        bitrate: spec.bitrate,
        level: spec.level,
        durationSeconds: target.durationSeconds ?? null,
        trial: false,
        downgraded,
      };
    }

    throw new AppError(
      "COPYRIGHT_UNAVAILABLE",
      "QQ 音乐未返回可用音频链接，请检查 QQ 音乐账号绑定、绿钻权限或该曲目版权状态。",
    );
  }

  async startQrLogin(scopeKey: string): Promise<QrStartResult> {
    return this.#qrAuth.start(scopeKey);
  }

  async checkQrLogin(
    scopeKey: string,
    key: string,
  ): Promise<QrCheckResult & { rawCookie?: string; verification?: CredentialVerificationResult }> {
    const check = await this.#qrAuth.check(scopeKey, key);
    if (check.status === "confirmed" && check.rawCookie) {
      const verification = await this.verifyCredential(check.rawCookie);
      return { ...check, verification };
    }
    return check;
  }
}
