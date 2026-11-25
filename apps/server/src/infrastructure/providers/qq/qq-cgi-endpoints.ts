import type { EntitySearchType } from "#shared";
import type { RawQqComment, RawQqPlaylist, RawQqSong } from "./qq-mapper.js";

export const QQ_ALBUM_CID = 205360838;
export const QQ_LYRIC_CID = 205360956;

export function isQqAuthInvalidCode(code: unknown): boolean {
  if (code === undefined || code === null) return false;
  const n = Number(code);
  return n === 1000 || n === 301 || n === 401 || n === 403;
}

export const QQ_PROFILE_HOMEPAGE_URL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg";
export const QQ_COLLECTED_PLAYLISTS_URL = "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg";
export const QQ_CREATED_PLAYLISTS_URL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss";
export const QQ_PLAYLIST_DETAIL_URL = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
export const QQ_LEGACY_SEARCH_URL = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
export const QQ_LYRIC_URL = "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
export const QQ_COMMENT_LIST_URL = "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_h5.fcg";
export const QQ_COMMENT_PRAISE_URL = "https://c.y.qq.com/base/fcgi-bin/fcg_global_comment_praise_h5.fcg";

export interface RawQqProfileResponse {
  code?: number;
  data?: {
    creator?: {
      nick?: string;
      headpic?: string;
      uin?: string | number;
    };
    vip?: { viplevel?: number; greenvip?: number; endtime?: number };
  };
}

export interface RawQqSearchResponse {
  req?: { data?: { body?: { song?: { list?: RawQqSong[] } } } };
}

export interface RawQqLegacySearchResponse {
  data?: { song?: { list?: RawQqSong[] } };
}

export interface RawQqDiscoverResponse {
  new_song?: { data?: { songlist?: RawQqSong[] } };
}

export interface RawQqCollectedPlaylistsResponse {
  code?: number;
  data?: { totaldiss?: number; cdlist?: RawQqPlaylist[] };
}

export interface RawQqCreatedPlaylistsResponse {
  code?: number;
  data?: { hostname?: string; disslist?: RawQqPlaylist[] };
}

export interface RawQqPlaylistDetailItem {
  disstid?: string;
  dissname?: string;
  logo?: string;
  nickname?: string;
  uin?: string | number;
  desc?: string;
  songlist?: RawQqSong[];
}

export interface RawQqPlaylistDetailResponse {
  code?: number;
  cdlist?: RawQqPlaylistDetailItem[];
}

export interface RawQqSongInfoResponse {
  songinfo?: {
    data?: {
      track_info?: { id?: number | string };
    };
  };
}

export interface RawQqLyricResponse {
  lyric?: string;
  trans?: string;
}

export interface RawQqCommentsResponse {
  code?: number;
  comment?: { commenttotal?: number; commentlist?: RawQqComment[] };
  hot_comment?: { commentlist?: RawQqComment[] };
}

export interface RawQqCommentPraiseResponse {
  code?: number;
  msg?: string;
}

export interface RawQqVkeyMidUrlInfo {
  purl?: string;
  opi30surl?: string;
  songmid?: string;
  filename?: string;
  result?: number;
}

export interface RawQqVkeyResponse {
  code?: number;
  req_0?: {
    code?: number;
    data?: {
      sip?: string[];
      midurlinfo?: RawQqVkeyMidUrlInfo[];
    };
  };
}

export interface RawQqRecommendedPlaylistItem {
  id?: number | string;
  title?: string;
  picurl?: string;
  creator?: { nick?: string };
}

export interface RawQqRecommendedPlaylistsResponse {
  rec?: { data?: { grids?: RawQqRecommendedPlaylistItem[] } };
}

export interface RawQqToplistItem {
  topId?: number;
  title?: string;
  headPicUrl?: string;
  frontPicUrl?: string;
  musichallPicUrl?: string;
  updateTime?: string;
  totalNum?: number;
  song?: Array<{ title?: string; singerName?: string }>;
}

export interface RawQqChartsResponse {
  charts?: { data?: { group?: Array<{ toplist?: RawQqToplistItem[] }> } };
}

export interface RawQqChartDetailResponse {
  detail?: {
    data?: {
      data?: {
        topId?: number;
        title?: string;
        headPicUrl?: string;
        frontPicUrl?: string;
        updateTime?: string;
        totalNum?: number;
      };
      songInfoList?: RawQqSong[];
    };
  };
}

export interface RawQqArtistAlbumItem {
  albumMid?: string;
  albumName?: string;
  publishDate?: string;
  albumType?: string;
  singerName?: string;
  totalNum?: number;
}

export interface RawQqArtistDetailResponse {
  singerInfo?: {
    data?: {
      singer_list?: Array<{
        basic_info?: { singer_mid?: string; name?: string };
        ex_info?: { desc?: string };
      }>;
    };
  };
  singerSongs?: {
    data?: {
      totalNum?: number;
      songList?: Array<{ songInfo?: RawQqSong }>;
    };
  };
  singerAlbums?: {
    data?: {
      total?: number;
      albumList?: RawQqArtistAlbumItem[];
    };
  };
}

export interface RawQqAlbumDetailResponse {
  detail?: {
    data?: {
      basicInfo?: {
        albumMid?: string;
        albumName?: string;
        publishDate?: string;
        desc?: string;
      };
      company?: { name?: string };
      singer?: { singerList?: Array<{ mid?: string; name?: string }> };
    };
  };
  songs?: {
    data?: {
      totalNum?: number;
      songList?: Array<{ songInfo?: RawQqSong }>;
    };
  };
}

export interface RawQqSearchArtistItem {
  singerMID?: string;
  singerName?: string;
  singerPic?: string;
  songNum?: number;
  albumNum?: number;
}

export interface RawQqSearchAlbumItem {
  albumMID?: string;
  albumName?: string;
  albumPic?: string;
  publicTime?: string;
  singerMID?: string;
  singerName?: string;
  song_count?: number;
}

export interface RawQqSearchPlaylistItem {
  dissid?: string | number;
  dissname?: string;
  imgurl?: string;
  song_count?: number;
  creator?: { name?: string };
}

export interface RawQqEntitySearchResponse {
  req?: {
    data?: {
      body?: {
        singer?: { list?: RawQqSearchArtistItem[] };
        album?: { list?: RawQqSearchAlbumItem[] };
        songlist?: { list?: RawQqSearchPlaylistItem[] };
      };
    };
  };
}

export function buildQqSearchPayload(
  query: string,
  searchType: number,
  limit: number,
): Record<string, unknown> {
  return {
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicDesktop",
      param: {
        query,
        search_type: searchType,
        num_per_page: limit,
        page_num: 1,
      },
    },
  };
}

export function buildQqEntitySearchPayload(
  query: string,
  type: EntitySearchType,
  limit: number,
): Record<string, unknown> {
  const searchType = type === "artist" ? 1 : type === "album" ? 2 : 3;
  return buildQqSearchPayload(query, searchType, limit);
}

export function buildQqDiscoverPayload(): Record<string, unknown> {
  return {
    new_song: {
      module: "newsong.NewSongServer",
      method: "get_new_song_info",
      param: { type: 5 },
    },
  };
}

export function buildQqSongDetailPayload(songMid: string): Record<string, unknown> {
  return {
    songinfo: {
      module: "music.pf_song_detail_svr",
      method: "get_song_detail_yqq",
      param: { song_mid: songMid, song_type: 0 },
    },
  };
}

export function buildQqVkeyPayload(input: {
  filenames: string[];
  guid: string;
  songMid: string;
  uin: string;
}): Record<string, unknown> {
  return {
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        filename: input.filenames,
        guid: input.guid,
        songmid: input.filenames.map(() => input.songMid),
        songtype: input.filenames.map(() => 0),
        uin: input.uin,
        loginflag: 1,
        platform: "20",
      },
    },
  };
}

export function buildQqRecommendedPlaylistsPayload(size: number): Record<string, unknown> {
  return {
    rec: {
      module: "playlist.HotRecommendServer",
      method: "get_new_hot_recommend",
      param: { cmd: 0, page: 0, daily_page: 0, size },
    },
  };
}

export function buildQqChartsPayload(): Record<string, unknown> {
  return {
    charts: {
      module: "musicToplist.ToplistInfoServer",
      method: "GetAll",
      param: {},
    },
  };
}

export function buildQqChartDetailPayload(topId: number): Record<string, unknown> {
  return {
    detail: {
      module: "musicToplist.ToplistInfoServer",
      method: "GetDetail",
      param: { topId, offset: 0, num: 100 },
    },
  };
}

export function buildQqArtistDetailPayload(singerMid: string): Record<string, unknown> {
  return {
    singerInfo: {
      module: "music.musichallSinger.SingerInfoInter",
      method: "GetSingerDetail",
      param: {
        singer_mids: [singerMid],
        ex_singer: 1,
        wiki_singer: 1,
        group_singer: 0,
        pic: 1,
        photos: 0,
      },
    },
    singerSongs: {
      module: "music.musichallSong.SongListInter",
      method: "GetSingerSongList",
      param: { singerMid, begin: 0, num: 50, order: 1 },
    },
    singerAlbums: {
      module: "music.musichallAlbum.AlbumListServer",
      method: "GetAlbumList",
      param: { singerMid, begin: 0, num: 30, order: 0 },
    },
  };
}

export function buildQqAlbumDetailPayload(albumMid: string): Record<string, unknown> {
  return {
    detail: {
      module: "music.musichallAlbum.AlbumInfoServer",
      method: "GetAlbumDetail",
      param: { albumMid },
    },
    songs: {
      module: "music.musichallAlbum.AlbumSongList",
      method: "GetAlbumSongList",
      param: { albumMid, begin: 0, num: 100, order: 2 },
    },
  };
}
