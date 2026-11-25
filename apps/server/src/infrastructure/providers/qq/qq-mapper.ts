import {
  type AlbumDetail,
  type AlbumSummary,
  type ArtistDetail,
  type ArtistSummary,
  type ChartDetail,
  type ChartSummary,
  type EntitySearchType,
  type PlaylistSummary,
  type QualityOption,
  type Song,
  type SongComment,
  formatDurationSeconds,
  formatTimestampText,
  normalizeCoverUrl,
  truncateCodePoints,
} from "#shared";
import { evaluateQqAvailability } from "../../../domain/policies/song-availability.js";
import type {
  RawQqAlbumDetailResponse,
  RawQqArtistDetailResponse,
  RawQqChartDetailResponse,
  RawQqEntitySearchResponse,
  RawQqPlaylistDetailItem,
  RawQqRecommendedPlaylistItem,
  RawQqToplistItem,
} from "./qq-cgi-endpoints.js";

export interface RawQqSinger {
  id?: number | string;
  mid?: string;
  name?: string;
}

export interface RawQqSong {
  id?: number | string;
  songid?: number | string;
  mid?: string;
  songmid?: string;
  name?: string;
  songname?: string;
  title?: string;
  singer?: RawQqSinger[];
  album?: { id?: number | string; mid?: string; name?: string; title?: string };
  albumid?: number | string;
  albummid?: string;
  albumname?: string;
  interval?: number;
  file?: {
    media_mid?: string;
    size_128mp3?: number;
    size_320mp3?: number;
    size_flac?: number;
    size_hires?: number;
  };
  strMediaMid?: string;
  size128?: number;
  size320?: number;
  sizeflac?: number;
  pay?: { payplay?: number; pay_play?: number; paydownload?: number; pay_down?: number };
  action?: { switch?: number };
  switch?: number;
  preview?: { tryend?: number };
}

export function getQqAlbumCoverUrl(albumMid: string | undefined): string | undefined {
  const clean = albumMid?.trim();
  if (!clean) return undefined;
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${encodeURIComponent(clean)}.jpg`;
}

export function getQqSingerAvatarUrl(singerMid: string): string {
  return `https://y.gtimg.cn/music/photo_new/T001R300x300M000${encodeURIComponent(singerMid)}.jpg`;
}

function deriveQqQualities(raw: RawQqSong): QualityOption[] {
  const list: QualityOption[] = [{ level: "standard", label: "128K" }];
  const has320 = Number(raw.file?.size_320mp3 ?? raw.size320 ?? 0) > 0;
  const hasFlac = Number(raw.file?.size_flac ?? raw.sizeflac ?? 0) > 0;
  const hasHires = Number(raw.file?.size_hires ?? 0) > 0;

  if (has320 || hasFlac || hasHires) list.push({ level: "exhigh", label: "320K" });
  if (hasFlac || hasHires) list.push({ level: "lossless", label: "FLAC" });
  if (hasHires) list.push({ level: "hires", label: "Hi-Res" });
  return list;
}

export function mapQqSong(raw: RawQqSong, options?: { vipEnabled?: boolean }): Song | null {
  const songMid = (raw.mid ?? raw.songmid ?? "").trim();
  const numericId = raw.id ?? raw.songid;
  const id = songMid || (numericId !== undefined ? String(numericId).trim() : "");
  const rawTitle = (raw.title ?? raw.name ?? raw.songname ?? "").trim();
  if (!id || !rawTitle) return null;
  const title = truncateCodePoints(rawTitle, 500);

  const artists = (raw.singer ?? [])
    .slice(0, 100)
    .map((s) => ({
      id: s.mid || (s.id !== undefined ? String(s.id) : undefined),
      name: truncateCodePoints(s.name?.trim() ?? "", 200),
    }))
    .filter((a) => Boolean(a.name));

  const fullArtistText = artists.map((a) => a.name).join(" / ") || "未知歌手";
  const artistText = truncateCodePoints(fullArtistText, 900);
  const albumName = truncateCodePoints(
    (raw.album?.title ?? raw.album?.name ?? raw.albumname ?? "").trim() || "未知专辑",
    500,
  );
  const albumMid = raw.album?.mid ?? raw.albummid;
  const durationSeconds = Math.max(0, Number(raw.interval ?? 0) || 0);
  const availableQualities = deriveQqQualities(raw);
  const topQuality = availableQualities[availableQualities.length - 1]?.label ?? "128K";

  const availability = evaluateQqAvailability(
    {
      actionSwitch: raw.action?.switch ?? raw.switch,
      payPlay: raw.pay?.payplay ?? raw.pay?.pay_play,
      payDownload: raw.pay?.paydownload ?? raw.pay?.pay_down,
      tryEnd: raw.preview?.tryend,
    },
    { vipEnabled: options?.vipEnabled },
  );

  return {
    id,
    platform: "qq",
    providerSongId: numericId !== undefined ? String(numericId) : undefined,
    mediaId: (raw.file?.media_mid ?? raw.strMediaMid ?? songMid).trim() || undefined,
    title,
    artist: artistText,
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : undefined,
    album: albumName,
    albumId: albumMid || (raw.album?.id !== undefined ? String(raw.album.id) : undefined),
    coverUrl: getQqAlbumCoverUrl(albumMid),
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    quality: topQuality,
    availableQualities,
    availability,
  };
}

export interface RawQqPlaylist {
  tid?: number | string;
  dissid?: number | string;
  disstid?: number | string;
  diss_name?: string;
  dissname?: string;
  title?: string;
  diss_cover?: string;
  pic_url?: string;
  logo?: string;
  song_cnt?: number;
  songnum?: number;
  nickname?: string;
  creator?: { name?: string };
}

export function mapQqPlaylist(
  raw: RawQqPlaylist,
  fallbackCreator: string,
  owned: boolean,
): PlaylistSummary | null {
  // Never fall back to dirid (folder index like 201 is not a valid disstid for songlist API)
  const rawId = raw.tid ?? raw.dissid ?? raw.disstid;
  const id = rawId !== undefined && rawId !== null ? String(rawId).trim() : "";
  const name = (raw.diss_name ?? raw.dissname ?? raw.title ?? "").trim();
  if (!id || id === "0" || !name) return null;

  return {
    id,
    platform: "qq",
    name,
    coverUrl: normalizeCoverUrl(raw.diss_cover ?? raw.pic_url ?? raw.logo, 300),
    trackCount: Math.max(0, Number(raw.song_cnt ?? raw.songnum ?? 0) || 0),
    creatorName: (raw.nickname ?? raw.creator?.name ?? fallbackCreator).trim() || fallbackCreator,
    owned,
  };
}

export function mapQqPlaylistDetail(
  cleanId: string,
  cd: RawQqPlaylistDetailItem,
  options?: { currentUin?: string; vipEnabled?: boolean },
): { playlist: PlaylistSummary; songs: Song[] } {
  const songs = (cd.songlist ?? [])
    .map((item) => mapQqSong(item, { vipEnabled: options?.vipEnabled }))
    .filter((s): s is Song => s !== null);
  const creatorUin = cd.uin !== undefined && cd.uin !== null ? String(cd.uin).replace(/\D/g, "") : "";
  const owned = Boolean(options?.currentUin && creatorUin && options.currentUin === creatorUin);

  const playlist: PlaylistSummary = {
    id: cleanId,
    platform: "qq",
    name: cd.dissname?.trim() || `QQ 歌单 ${cleanId}`,
    coverUrl: normalizeCoverUrl(cd.logo, 300),
    trackCount: songs.length,
    creatorName: cd.nickname?.trim() || "QQ 音乐用户",
    owned,
    description: cd.desc?.trim() || undefined,
  };

  return { playlist, songs };
}

export function mapQqRecommendedPlaylists(
  grids: readonly RawQqRecommendedPlaylistItem[],
  limit: number,
): PlaylistSummary[] {
  return grids
    .filter((item) => item.id !== undefined && Boolean(item.title?.trim()))
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id),
      platform: "qq" as const,
      name: item.title?.trim() ?? "",
      coverUrl: normalizeCoverUrl(item.picurl, 400),
      trackCount: 0,
      creatorName: item.creator?.nick?.trim() || "QQ 音乐推荐",
      owned: false,
    }));
}

export function mapQqCharts(groups: ReadonlyArray<{ toplist?: RawQqToplistItem[] }>): ChartSummary[] {
  const seen = new Set<string>();
  const list: ChartSummary[] = [];
  for (const group of groups) {
    for (const item of group.toplist ?? []) {
      if (!item.topId || !item.title?.trim()) continue;
      const id = String(item.topId);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id,
        platform: "qq",
        name: item.title.trim(),
        coverUrl: normalizeCoverUrl(item.headPicUrl || item.frontPicUrl || item.musichallPicUrl, 400),
        updateFrequency: item.updateTime ? `更新于 ${item.updateTime}` : undefined,
        trackCount: Math.max(0, Number(item.totalNum ?? 0) || 0),
        previewTracks: (item.song ?? [])
          .slice(0, 3)
          .map((s) => [s.title, s.singerName].filter(Boolean).join(" - "))
          .filter(Boolean),
      });
    }
  }
  return list.slice(0, 36);
}

export function mapQqChartDetail(
  topId: number,
  res: RawQqChartDetailResponse,
  options?: { vipEnabled?: boolean },
): ChartDetail {
  const info = res.detail?.data?.data;
  const songs = (res.detail?.data?.songInfoList ?? [])
    .map((item) => mapQqSong(item, { vipEnabled: options?.vipEnabled }))
    .filter((song): song is Song => song !== null);

  return {
    chart: {
      id: String(topId),
      platform: "qq",
      name: info?.title?.trim() || `QQ 榜单 ${topId}`,
      coverUrl: normalizeCoverUrl(info?.headPicUrl || info?.frontPicUrl, 400),
      updateFrequency: info?.updateTime ? `更新于 ${info.updateTime}` : undefined,
      trackCount: Math.max(songs.length, Number(info?.totalNum ?? 0) || 0),
    },
    songs,
  };
}

export function mapQqArtistDetail(
  singerMid: string,
  res: RawQqArtistDetailResponse,
  options?: { vipEnabled?: boolean },
): ArtistDetail | null {
  const info = res.singerInfo?.data?.singer_list?.[0];
  const hotSongs = (res.singerSongs?.data?.songList ?? [])
    .map((item) => (item.songInfo ? mapQqSong(item.songInfo, { vipEnabled: options?.vipEnabled }) : null))
    .filter((song): song is Song => song !== null);

  const name = info?.basic_info?.name?.trim() || hotSongs[0]?.artist.split(" / ")[0] || "";
  if (!name) return null;

  const albums: AlbumSummary[] = (res.singerAlbums?.data?.albumList ?? [])
    .filter((a) => Boolean(a.albumMid?.trim()) && Boolean(a.albumName?.trim()))
    .map((a) => {
      const albumMid = a.albumMid?.trim() ?? "";
      return {
        id: albumMid,
        platform: "qq" as const,
        name: a.albumName?.trim() ?? "",
        coverUrl: getQqAlbumCoverUrl(albumMid),
        artistName: a.singerName?.trim() || name,
        artistId: singerMid,
        publishDate: a.publishDate?.trim() || undefined,
        trackCount: typeof a.totalNum === "number" && a.totalNum > 0 ? a.totalNum : undefined,
        albumType: a.albumType?.trim() || undefined,
      };
    });

  return {
    id: singerMid,
    platform: "qq",
    name,
    avatarUrl: getQqSingerAvatarUrl(singerMid),
    briefDesc: info?.ex_info?.desc?.trim() || undefined,
    songCount: res.singerSongs?.data?.totalNum ?? hotSongs.length,
    albumCount: res.singerAlbums?.data?.total ?? albums.length,
    hotSongs,
    albums,
  };
}

export function mapQqAlbumDetail(
  albumMid: string,
  res: RawQqAlbumDetailResponse,
  options?: { vipEnabled?: boolean },
): AlbumDetail | null {
  const basic = res.detail?.data?.basicInfo;
  if (!basic?.albumName?.trim()) return null;

  const songs = (res.songs?.data?.songList ?? [])
    .map((item) => (item.songInfo ? mapQqSong(item.songInfo, { vipEnabled: options?.vipEnabled }) : null))
    .filter((song): song is Song => song !== null);

  const artists = (res.detail?.data?.singer?.singerList ?? [])
    .map((s) => ({ id: s.mid?.trim() || undefined, name: s.name?.trim() ?? "" }))
    .filter((s) => Boolean(s.name));

  return {
    id: albumMid,
    platform: "qq",
    name: basic.albumName.trim(),
    coverUrl: getQqAlbumCoverUrl(albumMid),
    artists: artists.length > 0 ? artists : [{ name: "未知歌手" }],
    publishDate: basic.publishDate?.trim() || undefined,
    company: res.detail?.data?.company?.name?.trim() || undefined,
    description: basic.desc?.trim() || undefined,
    trackCount: Math.max(songs.length, Number(res.songs?.data?.totalNum ?? 0) || 0),
    songs,
  };
}

export function mapQqEntitySearchResult(
  type: EntitySearchType,
  res: RawQqEntitySearchResponse,
): { artists?: ArtistSummary[]; albums?: AlbumSummary[]; playlists?: PlaylistSummary[] } {
  const body = res.req?.data?.body;
  if (type === "artist") {
    return {
      artists: (body?.singer?.list ?? [])
        .filter((a) => Boolean(a.singerMID?.trim()) && Boolean(a.singerName?.trim()))
        .map((a) => ({
          id: a.singerMID?.trim() ?? "",
          platform: "qq" as const,
          name: a.singerName?.trim() ?? "",
          avatarUrl: normalizeCoverUrl(a.singerPic, 300),
          songCount: typeof a.songNum === "number" ? a.songNum : undefined,
          albumCount: typeof a.albumNum === "number" ? a.albumNum : undefined,
        })),
    };
  }

  if (type === "album") {
    return {
      albums: (body?.album?.list ?? [])
        .filter((a) => Boolean(a.albumMID?.trim()) && Boolean(a.albumName?.trim()))
        .map((a) => ({
          id: a.albumMID?.trim() ?? "",
          platform: "qq" as const,
          name: a.albumName?.trim() ?? "",
          coverUrl: normalizeCoverUrl(a.albumPic, 400),
          artistName: a.singerName?.trim() || "未知歌手",
          artistId: a.singerMID?.trim() || undefined,
          publishDate: a.publicTime?.trim() || undefined,
          trackCount: typeof a.song_count === "number" ? a.song_count : undefined,
        })),
    };
  }

  return {
    playlists: (body?.songlist?.list ?? [])
      .filter((p) => p.dissid !== undefined && Boolean(p.dissname?.trim()))
      .map((p) => ({
        id: String(p.dissid),
        platform: "qq" as const,
        name: p.dissname?.trim() ?? "",
        coverUrl: normalizeCoverUrl(p.imgurl, 400),
        trackCount: Math.max(0, Number(p.song_count ?? 0) || 0),
        creatorName: p.creator?.name?.trim() || "QQ 音乐用户",
        owned: false,
      })),
  };
}

export interface RawQqComment {
  rootcommentid?: string;
  commentid?: string;
  uin?: string | number;
  encrypt_uin?: string;
  rootcommentnick?: string;
  nick?: string;
  avatarurl?: string;
  rootcommentcontent?: string;
  time?: number;
  ispraise?: number;
  praisenum?: number;
}

export function mapQqComment(raw: RawQqComment): SongComment | null {
  const id = (raw.rootcommentid ?? raw.commentid ?? "").trim();
  const content = (raw.rootcommentcontent ?? "").trim();
  if (!id || !content) return null;

  const ts =
    typeof raw.time === "number" ? (raw.time > 10_000_000_000 ? raw.time : raw.time * 1000) : undefined;

  return {
    id,
    userId: String(raw.uin ?? raw.encrypt_uin ?? ""),
    nickname: (raw.rootcommentnick ?? raw.nick ?? "QQ 音乐用户").replace(/^@/, "").trim() || "QQ 音乐用户",
    avatarUrl: normalizeCoverUrl(raw.avatarurl, 120),
    content,
    timeText: formatTimestampText(ts),
    time: ts,
    liked: Number(raw.ispraise ?? 0) === 1,
    likedCount: Math.max(0, Number(raw.praisenum ?? 0) || 0),
    replyCount: 0,
  };
}
