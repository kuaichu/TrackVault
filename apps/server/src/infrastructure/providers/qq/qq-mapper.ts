import {
  type PlaylistSummary,
  type QualityOption,
  type Song,
  type SongComment,
  normalizeCoverUrl,
} from "#shared";
import { evaluateQqAvailability } from "../../../domain/policies/song-availability.js";
import { formatDurationSeconds, formatNeteaseTime, truncateCodePoints } from "../netease/netease-mapper.js";

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

function getQqAlbumCover(albumMid: string | undefined): string | undefined {
  const clean = albumMid?.trim();
  if (!clean) return undefined;
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${encodeURIComponent(clean)}.jpg`;
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

export function mapQqSong(raw: RawQqSong): Song | null {
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

  const availability = evaluateQqAvailability({
    actionSwitch: raw.action?.switch ?? raw.switch,
    payPlay: raw.pay?.payplay ?? raw.pay?.pay_play,
    payDownload: raw.pay?.paydownload ?? raw.pay?.pay_down,
    tryEnd: raw.preview?.tryend,
  });

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
    coverUrl: getQqAlbumCover(albumMid),
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
    timeText: formatNeteaseTime(ts),
    time: ts,
    liked: Number(raw.ispraise ?? 0) === 1,
    likedCount: Math.max(0, Number(raw.praisenum ?? 0) || 0),
    replyCount: 0,
  };
}
