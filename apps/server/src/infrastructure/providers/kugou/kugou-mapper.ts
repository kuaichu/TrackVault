import {
  type AlbumDetail,
  type AlbumSummary,
  type ArtistDetail,
  type ArtistSummary,
  type ChartDetail,
  type ChartSummary,
  type PlaylistSummary,
  type QualityOption,
  type Song,
  type SongArtist,
  type SongComment,
  formatDurationSeconds,
  formatTimestampText,
  normalizeCoverUrl,
  truncateCodePoints,
} from "#shared";
import { evaluateKugouAvailability } from "../../../domain/policies/song-availability.js";

function stripEmTags(raw: string | undefined | null): string {
  if (!raw) return "";
  return raw.replace(/<\/?em>/gi, "").trim();
}

function normalizeHash(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const clean = raw.trim().toUpperCase();
  return /^[0-9A-F]{32}$/.test(clean) ? clean : "";
}

function deriveKugouQualities(flags: {
  has320: boolean;
  hasFlac: boolean;
  hasHires: boolean;
}): QualityOption[] {
  const list: QualityOption[] = [{ level: "standard", label: "128K" }];
  if (flags.has320 || flags.hasFlac || flags.hasHires) {
    list.push({ level: "exhigh", label: "320K" });
  }
  if (flags.hasFlac || flags.hasHires) {
    list.push({ level: "lossless", label: "FLAC" });
  }
  if (flags.hasHires) {
    list.push({ level: "hires", label: "Hi-Res" });
  }
  return list;
}

export function buildKugouMediaId(mixSongId: unknown, albumId: unknown): string | undefined {
  const mix = String(mixSongId ?? "").replace(/\D/g, "") || "0";
  const alb = String(albumId ?? "").replace(/\D/g, "") || "0";
  if (mix === "0" && alb === "0") return undefined;
  return `${mix}:${alb}`;
}

export function parseKugouMediaId(mediaId: string | undefined): { mixSongId: number; albumId: number } {
  if (!mediaId) return { mixSongId: 0, albumId: 0 };
  const [mixRaw, albRaw] = mediaId.split(":");
  const mixSongId = Number(mixRaw ?? 0);
  const albumId = Number(albRaw ?? 0);
  return {
    mixSongId: Number.isFinite(mixSongId) && mixSongId > 0 ? Math.floor(mixSongId) : 0,
    albumId: Number.isFinite(albumId) && albumId > 0 ? Math.floor(albumId) : 0,
  };
}

export interface KugouMapOptions {
  vipEnabled?: boolean;
  isLite?: boolean;
}

export interface RawKugouSearchSong {
  FileHash?: string;
  HQFileHash?: string;
  SQFileHash?: string;
  ResFileHash?: string;
  SongName?: string;
  OriSongName?: string;
  SingerName?: string;
  Singers?: Array<{ id?: number | string; name?: string }>;
  AlbumName?: string;
  AlbumID?: string | number;
  MixSongID?: number | string;
  Duration?: number;
  Privilege?: number;
  PayType?: number;
  Image?: string;
  TransParam?: { union_cover?: string };
}

export function mapKugouSearchSong(raw: RawKugouSearchSong, options?: KugouMapOptions): Song | null {
  const hash128 = normalizeHash(raw.FileHash);
  const hash320 = normalizeHash(raw.HQFileHash);
  const hashFlac = normalizeHash(raw.SQFileHash);
  const hashHires = normalizeHash(raw.ResFileHash);
  const id = hash128 || hash320 || hashFlac || hashHires;
  const rawTitle = stripEmTags(raw.SongName || raw.OriSongName);
  if (!id || !rawTitle) return null;

  const artists: SongArtist[] = (raw.Singers ?? [])
    .slice(0, 50)
    .map((s) => ({
      id: s.id && String(s.id) !== "0" ? String(s.id) : undefined,
      name: truncateCodePoints(stripEmTags(s.name), 200),
    }))
    .filter((a) => Boolean(a.name));

  const fallbackArtist = stripEmTags(raw.SingerName) || "未知歌手";
  const artistText = truncateCodePoints(
    artists.length > 0 ? artists.map((a) => a.name).join(" / ") : fallbackArtist,
    900,
  );
  const albumName = truncateCodePoints(stripEmTags(raw.AlbumName) || "未知专辑", 500);
  const albumIdStr = raw.AlbumID && String(raw.AlbumID) !== "0" ? String(raw.AlbumID) : undefined;
  const mixSongIdStr = raw.MixSongID && String(raw.MixSongID) !== "0" ? String(raw.MixSongID) : undefined;
  const durationSeconds = Math.max(0, Math.round(Number(raw.Duration ?? 0) || 0));

  const availableQualities = deriveKugouQualities({
    has320: Boolean(hash320),
    hasFlac: Boolean(hashFlac),
    hasHires: Boolean(hashHires),
  });

  return {
    id,
    platform: "kugou",
    providerSongId: mixSongIdStr,
    mediaId: buildKugouMediaId(mixSongIdStr, albumIdStr),
    title: truncateCodePoints(rawTitle, 500),
    artist: artistText,
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : [{ name: fallbackArtist }],
    album: albumName,
    albumId: albumIdStr,
    coverUrl: normalizeCoverUrl(raw.Image ?? raw.TransParam?.union_cover, 400),
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    quality: availableQualities[availableQualities.length - 1]?.label ?? "128K",
    availableQualities,
    availability: evaluateKugouAvailability(
      { privilege: raw.Privilege, payType: raw.PayType, hasHash: Boolean(id) },
      options,
    ),
  };
}

export interface RawKugouPlaylistSong {
  hash?: string;
  name?: string;
  filename?: string;
  timelen?: number;
  duration?: number;
  album_id?: string | number;
  albuminfo?: { id?: number | string; name?: string };
  mixsongid?: number | string;
  add_mixsongid?: number | string;
  album_audio_id?: number | string;
  privilege?: number;
  feetype?: number;
  pay_type?: number;
  cover?: string;
  trans_param?: { union_cover?: string };
  singerinfo?: Array<{ id?: number | string; name?: string }>;
  relate_goods?: Array<{ hash?: string; level?: number; bitrate?: number }>;
}

function splitCombinedArtistTitle(
  rawName: string,
  knownArtists: readonly SongArtist[],
): {
  title: string;
  fallbackArtist: string;
} {
  const clean = stripEmTags(rawName);
  const sepIdx = clean.indexOf(" - ");
  if (sepIdx > 0) {
    const left = clean.slice(0, sepIdx).trim();
    const right = clean.slice(sepIdx + 3).trim();
    if (right) {
      return { title: right, fallbackArtist: left || "未知歌手" };
    }
  }
  return {
    title: clean,
    fallbackArtist: knownArtists[0]?.name || "未知歌手",
  };
}

export function mapKugouPlaylistSong(raw: RawKugouPlaylistSong, options?: KugouMapOptions): Song | null {
  const goods = raw.relate_goods ?? [];
  const baseHash = normalizeHash(raw.hash) || normalizeHash(goods.find((g) => g.level === 2)?.hash);
  const hash320 = normalizeHash(goods.find((g) => g.level === 4)?.hash);
  const hashFlac = normalizeHash(goods.find((g) => g.level === 5)?.hash);
  const hashHires = normalizeHash(goods.find((g) => g.level === 6)?.hash);
  const id = baseHash || hash320 || hashFlac || hashHires;
  if (!id) return null;

  const artists: SongArtist[] = (raw.singerinfo ?? [])
    .slice(0, 50)
    .map((s) => ({
      id: s.id && String(s.id) !== "0" ? String(s.id) : undefined,
      name: truncateCodePoints(stripEmTags(s.name), 200),
    }))
    .filter((a) => Boolean(a.name));

  const { title, fallbackArtist } = splitCombinedArtistTitle(raw.name ?? raw.filename ?? "", artists);
  if (!title) return null;

  const artistText = truncateCodePoints(
    artists.length > 0 ? artists.map((a) => a.name).join(" / ") : fallbackArtist,
    900,
  );
  const rawAlbumId = raw.albuminfo?.id ?? raw.album_id;
  const albumIdStr = rawAlbumId && String(rawAlbumId) !== "0" ? String(rawAlbumId) : undefined;
  const albumName = truncateCodePoints(stripEmTags(raw.albuminfo?.name) || "未知专辑", 500);
  const rawMixId = raw.mixsongid ?? raw.add_mixsongid ?? raw.album_audio_id;
  const mixSongIdStr = rawMixId && String(rawMixId) !== "0" ? String(rawMixId) : undefined;

  const rawTime = Number(raw.timelen ?? raw.duration ?? 0) || 0;
  const durationSeconds = rawTime > 1000 ? Math.round(rawTime / 1000) : Math.max(0, Math.round(rawTime));

  const availableQualities = deriveKugouQualities({
    has320: Boolean(hash320),
    hasFlac: Boolean(hashFlac),
    hasHires: Boolean(hashHires),
  });

  return {
    id,
    platform: "kugou",
    providerSongId: mixSongIdStr,
    mediaId: buildKugouMediaId(mixSongIdStr, albumIdStr),
    title: truncateCodePoints(title, 500),
    artist: artistText,
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : [{ name: fallbackArtist }],
    album: albumName,
    albumId: albumIdStr,
    coverUrl: normalizeCoverUrl(raw.cover ?? raw.trans_param?.union_cover, 400),
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    quality: availableQualities[availableQualities.length - 1]?.label ?? "128K",
    availableQualities,
    availability: evaluateKugouAvailability(
      { privilege: raw.privilege, payType: raw.pay_type ?? raw.feetype, hasHash: true },
      options,
    ),
  };
}

export interface RawKugouKmrSong {
  songname?: string;
  audio_name?: string;
  author_name?: string;
  authors?: Array<{ author_id?: string | number; author_name?: string }>;
  base?: {
    album_id?: number | string;
    author_name?: string;
    audio_name?: string;
    album_audio_id?: number | string;
  };
  album_id?: number | string;
  album_audio_id?: number | string;
  album_info?: {
    album_id?: number | string;
    album_name?: string;
    sizable_cover?: string;
    cover?: string;
  };
  audio_info?: {
    hash?: string;
    hash_128?: string;
    hash_320?: string;
    hash_flac?: string;
    hash_high?: string;
    duration?: number;
    duration_128?: number;
  };
  hash?: string;
  hash_320?: string;
  hash_flac?: string;
  hash_high?: string;
  timelength?: number;
  timelength_320?: number;
  trans_param?: { union_cover?: string };
  privilege_download?: { privilege?: number; privilege_128?: number };
  copyright?: { privilege?: number; privilege_128?: number };
  deprecated?: { hash?: string; pay_type?: number; duration?: number };
  privilege_128?: number;
  pay_type?: number;
}

export function mapKugouKmrSong(raw: RawKugouKmrSong, options?: KugouMapOptions): Song | null {
  const hash128 =
    normalizeHash(raw.audio_info?.hash_128) ||
    normalizeHash(raw.audio_info?.hash) ||
    normalizeHash(raw.hash) ||
    normalizeHash(raw.deprecated?.hash);
  const hash320 = normalizeHash(raw.audio_info?.hash_320) || normalizeHash(raw.hash_320);
  const hashFlac = normalizeHash(raw.audio_info?.hash_flac) || normalizeHash(raw.hash_flac);
  const hashHires = normalizeHash(raw.audio_info?.hash_high) || normalizeHash(raw.hash_high);
  const id = hash128 || hash320 || hashFlac || hashHires;
  const rawTitle = stripEmTags(raw.songname ?? raw.base?.audio_name ?? raw.audio_name);
  if (!id || !rawTitle) return null;

  const artists: SongArtist[] = (raw.authors ?? [])
    .slice(0, 50)
    .map((a) => ({
      id: a.author_id && String(a.author_id) !== "0" ? String(a.author_id) : undefined,
      name: truncateCodePoints(stripEmTags(a.author_name), 200),
    }))
    .filter((a) => Boolean(a.name));

  const fallbackArtist = stripEmTags(raw.author_name ?? raw.base?.author_name) || "未知歌手";
  const artistText = truncateCodePoints(
    artists.length > 0 ? artists.map((a) => a.name).join(" / ") : fallbackArtist,
    900,
  );
  const rawAlbId = raw.album_id ?? raw.base?.album_id ?? raw.album_info?.album_id;
  const albumIdStr = rawAlbId && String(rawAlbId) !== "0" ? String(rawAlbId) : undefined;
  const albumName = truncateCodePoints(stripEmTags(raw.album_info?.album_name) || "未知专辑", 500);
  const rawMixId = raw.album_audio_id ?? raw.base?.album_audio_id;
  const mixSongIdStr = rawMixId && String(rawMixId) !== "0" ? String(rawMixId) : undefined;

  const rawMs =
    Number(
      raw.audio_info?.duration ??
        raw.audio_info?.duration_128 ??
        raw.deprecated?.duration ??
        raw.timelength ??
        raw.timelength_320 ??
        0,
    ) || 0;
  const durationSeconds = rawMs > 1000 ? Math.round(rawMs / 1000) : Math.max(0, Math.round(rawMs));

  const availableQualities = deriveKugouQualities({
    has320: Boolean(hash320),
    hasFlac: Boolean(hashFlac),
    hasHires: Boolean(hashHires),
  });

  const privilege =
    raw.privilege_download?.privilege ??
    raw.privilege_download?.privilege_128 ??
    raw.copyright?.privilege ??
    raw.copyright?.privilege_128 ??
    raw.privilege_128;
  const payType = raw.deprecated?.pay_type ?? raw.pay_type;

  return {
    id,
    platform: "kugou",
    providerSongId: mixSongIdStr,
    mediaId: buildKugouMediaId(mixSongIdStr, albumIdStr),
    title: truncateCodePoints(rawTitle, 500),
    artist: artistText,
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : [{ name: fallbackArtist }],
    album: albumName,
    albumId: albumIdStr,
    coverUrl: normalizeCoverUrl(
      raw.album_info?.sizable_cover ?? raw.album_info?.cover ?? raw.trans_param?.union_cover,
      400,
    ),
    durationSeconds,
    duration: formatDurationSeconds(durationSeconds),
    quality: availableQualities[availableQualities.length - 1]?.label ?? "128K",
    availableQualities,
    availability: evaluateKugouAvailability({ privilege, payType, hasHash: true }, options),
  };
}

export interface RawKugouRankItem {
  rankid?: number | string;
  rankname?: string;
  imgurl?: string;
  img_9?: string;
  album_img_9?: string;
  update_frequency?: string;
  songinfo?: Array<{ name?: string; author?: string; songname?: string }>;
}

export function mapKugouCharts(items: readonly RawKugouRankItem[]): ChartSummary[] {
  const seen = new Set<string>();
  const out: ChartSummary[] = [];
  for (const item of items) {
    const id = item.rankid !== undefined ? String(item.rankid).trim() : "";
    const name = item.rankname?.trim() ?? "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const previewTracks = (item.songinfo ?? [])
      .slice(0, 3)
      .map((s) => {
        if (s.name && s.author) return `${s.name} - ${s.author}`;
        return s.songname?.trim() ?? "";
      })
      .filter(Boolean);
    out.push({
      id,
      platform: "kugou",
      name,
      coverUrl: normalizeCoverUrl(item.imgurl || item.album_img_9 || item.img_9, 400),
      updateFrequency: item.update_frequency?.trim() || undefined,
      previewTracks: previewTracks.length > 0 ? previewTracks : undefined,
    });
  }
  return out.slice(0, 36);
}

export function mapKugouChartDetail(
  chartId: string,
  info: RawKugouRankItem | undefined,
  songs: Song[],
  total?: number,
): ChartDetail {
  return {
    chart: {
      id: chartId,
      platform: "kugou",
      name: info?.rankname?.trim() || `酷狗榜单 ${chartId}`,
      coverUrl:
        normalizeCoverUrl(info?.imgurl || info?.album_img_9 || info?.img_9, 400) ?? songs[0]?.coverUrl,
      updateFrequency: info?.update_frequency?.trim() || undefined,
      trackCount: Math.max(songs.length, Number(total ?? 0) || 0),
    },
    songs,
  };
}

export interface RawKugouRecommendedPlaylist {
  global_collection_id?: string;
  specialid?: number | string;
  specialname?: string;
  imgurl?: string;
  flexible_cover?: string;
  songcount?: number;
  count?: number;
  nickname?: string;
  intro?: string;
}

export function mapKugouRecommendedPlaylists(
  items: readonly RawKugouRecommendedPlaylist[],
  limit: number,
): PlaylistSummary[] {
  const out: PlaylistSummary[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = (item.global_collection_id || (item.specialid ? String(item.specialid) : "")).trim();
    const name = stripEmTags(item.specialname);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      platform: "kugou",
      name,
      coverUrl: normalizeCoverUrl(item.flexible_cover || item.imgurl, 400),
      trackCount: Math.max(0, Number(item.songcount ?? item.count ?? 0) || 0),
      creatorName: item.nickname?.trim() || "酷狗音乐推荐",
      owned: false,
      description: item.intro?.trim() || undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface RawKugouArtistInfo {
  author_id?: string | number;
  author_name?: string;
  sizable_avatar?: string;
  album_count?: number;
  song_count?: number;
  intro?: string;
  long_intro?: Array<{ title?: string; content?: string }>;
}

export interface RawKugouAlbumItem {
  album_id?: string | number;
  albumid?: string | number;
  album_name?: string;
  albumname?: string;
  sizable_cover?: string;
  img?: string;
  author_name?: string;
  singer?: string;
  authors?: Array<{ author_id?: string | number; author_name?: string }>;
  publish_date?: string;
  publish_time?: string;
  songcount?: number;
  total?: number;
  intro?: string;
  company?: string;
}

export function mapKugouArtistDetail(
  artistId: string,
  info: RawKugouArtistInfo | undefined,
  hotSongs: Song[],
  rawAlbums: readonly RawKugouAlbumItem[],
): ArtistDetail | null {
  const name = stripEmTags(info?.author_name) || hotSongs[0]?.artist.split(" / ")[0] || "";
  if (!name) return null;

  const descFromLong = info?.long_intro
    ?.map((seg) => seg.content?.trim())
    .filter(Boolean)
    .join("\n\n");

  const albums: AlbumSummary[] = rawAlbums
    .filter((a) => Boolean(a.album_id ?? a.albumid) && Boolean((a.album_name ?? a.albumname)?.trim()))
    .map((a) => ({
      id: String(a.album_id ?? a.albumid),
      platform: "kugou" as const,
      name: stripEmTags(a.album_name ?? a.albumname),
      coverUrl: normalizeCoverUrl(a.sizable_cover ?? a.img, 400),
      artistName: stripEmTags(a.author_name ?? a.singer) || name,
      artistId,
      publishDate: (a.publish_date ?? a.publish_time)?.split(" ")[0]?.trim() || undefined,
      trackCount: typeof a.songcount === "number" && a.songcount > 0 ? a.songcount : undefined,
    }));

  return {
    id: artistId,
    platform: "kugou",
    name,
    avatarUrl: normalizeCoverUrl(info?.sizable_avatar, 400),
    briefDesc: info?.intro?.trim() || descFromLong || undefined,
    songCount: typeof info?.song_count === "number" ? info.song_count : hotSongs.length,
    albumCount: typeof info?.album_count === "number" ? info.album_count : albums.length,
    hotSongs,
    albums,
  };
}

export function mapKugouAlbumDetail(
  albumId: string,
  info: RawKugouAlbumItem | undefined,
  songs: Song[],
  totalCount?: number,
): AlbumDetail | null {
  const name = stripEmTags(info?.album_name ?? info?.albumname) || songs[0]?.album || "";
  if (!name) return null;

  const artists: SongArtist[] = (info?.authors ?? [])
    .map((a) => ({
      id: a.author_id && String(a.author_id) !== "0" ? String(a.author_id) : undefined,
      name: stripEmTags(a.author_name),
    }))
    .filter((a) => Boolean(a.name));

  const fallbackArtist = stripEmTags(info?.author_name ?? info?.singer) || songs[0]?.artist || "未知歌手";

  return {
    id: albumId,
    platform: "kugou",
    name,
    coverUrl: normalizeCoverUrl(info?.sizable_cover ?? info?.img, 400) ?? songs[0]?.coverUrl,
    artists: artists.length > 0 ? artists : [{ name: fallbackArtist }],
    publishDate: (info?.publish_date ?? info?.publish_time)?.split(" ")[0]?.trim() || undefined,
    company: info?.company?.trim() || undefined,
    description: info?.intro?.trim() || undefined,
    trackCount: Math.max(songs.length, Number(totalCount ?? info?.songcount ?? 0) || 0),
    songs,
  };
}

export interface RawKugouEntityAuthor {
  AuthorId?: number | string;
  AuthorName?: string;
  Avatar?: string;
  FirstFrameImage?: string;
  AudioCount?: number;
  AlbumCount?: number;
}

export interface RawKugouEntitySpecial {
  gid?: string;
  global_collection_id?: string;
  specialid?: number | string;
  specialname?: string;
  img?: string;
  song_count?: number;
  nickname?: string;
  intro?: string;
}

export function mapKugouSearchArtists(items: readonly RawKugouEntityAuthor[]): ArtistSummary[] {
  return items
    .filter((a) => Boolean(a.AuthorId) && Boolean(stripEmTags(a.AuthorName)))
    .map((a) => ({
      id: String(a.AuthorId),
      platform: "kugou" as const,
      name: stripEmTags(a.AuthorName),
      avatarUrl: normalizeCoverUrl(a.Avatar || a.FirstFrameImage, 300),
      songCount: typeof a.AudioCount === "number" ? a.AudioCount : undefined,
      albumCount: typeof a.AlbumCount === "number" ? a.AlbumCount : undefined,
    }));
}

export function mapKugouSearchAlbums(items: readonly RawKugouAlbumItem[]): AlbumSummary[] {
  return items
    .filter((a) => Boolean(a.albumid ?? a.album_id) && Boolean(stripEmTags(a.albumname ?? a.album_name)))
    .map((a) => ({
      id: String(a.albumid ?? a.album_id),
      platform: "kugou" as const,
      name: stripEmTags(a.albumname ?? a.album_name),
      coverUrl: normalizeCoverUrl(a.img ?? a.sizable_cover, 400),
      artistName: stripEmTags(a.singer ?? a.author_name) || "未知歌手",
      publishDate: (a.publish_time ?? a.publish_date)?.split(" ")[0]?.trim() || undefined,
      trackCount: typeof a.songcount === "number" ? a.songcount : undefined,
    }));
}

export function mapKugouSearchPlaylists(items: readonly RawKugouEntitySpecial[]): PlaylistSummary[] {
  return items
    .filter(
      (p) => Boolean(p.gid || p.global_collection_id || p.specialid) && Boolean(stripEmTags(p.specialname)),
    )
    .map((p) => ({
      id: String(p.gid || p.global_collection_id || p.specialid),
      platform: "kugou" as const,
      name: stripEmTags(p.specialname),
      coverUrl: normalizeCoverUrl(p.img, 400),
      trackCount: Math.max(0, Number(p.song_count ?? 0) || 0),
      creatorName: p.nickname?.trim() || "酷狗用户",
      owned: false,
      description: p.intro?.trim() || undefined,
    }));
}

export interface RawKugouComment {
  id?: number | string;
  user_id?: number | string;
  user_name?: string;
  user_pic?: string;
  content?: string;
  addtime?: string;
  reply_num?: number;
  like?: {
    count?: number;
    likenum?: number;
    haslike?: boolean;
  };
}

export function mapKugouComment(raw: RawKugouComment): SongComment | null {
  const id = raw.id !== undefined ? String(raw.id).trim() : "";
  const content = raw.content?.trim() ?? "";
  if (!id || !content) return null;

  let parsedMs: number | undefined;
  if (raw.addtime) {
    const dt = Date.parse(`${raw.addtime.replace(" ", "T")}+08:00`);
    if (!Number.isNaN(dt)) parsedMs = dt;
  }

  return {
    id,
    userId: String(raw.user_id ?? ""),
    nickname: raw.user_name?.trim() || "酷狗用户",
    avatarUrl: normalizeCoverUrl(raw.user_pic, 120),
    content,
    timeText: parsedMs ? formatTimestampText(parsedMs) : (raw.addtime?.slice(0, 16) ?? ""),
    time: parsedMs,
    liked: Boolean(raw.like?.haslike),
    likedCount: Math.max(0, Number(raw.like?.likenum ?? raw.like?.count ?? 0) || 0),
    replyCount: Math.max(0, Number(raw.reply_num ?? 0) || 0),
  };
}
