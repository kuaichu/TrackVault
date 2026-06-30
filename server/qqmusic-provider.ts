import { createRequire } from "node:module";
import type { DownloadQualityLevel, DownloadQualityOption, Song, SongAudioProbe, SongAudioProbeMode } from "./types.js";
import { getSettings } from "./settings-store.js";

const require = createRequire(import.meta.url);

type QqMusicApi = {
  setCookie: (cookies: string | Record<string, string>) => void;
  api: <T = unknown>(path: string, query?: Record<string, string | number>) => Promise<T>;
};

const qqMusic = require("qq-music-api") as QqMusicApi;

type QqSinger = {
  id?: number | string;
  mid?: string;
  name?: string;
};

type QqSearchSong = {
  id?: number | string;
  songid?: number | string;
  mid?: string;
  songmid?: string;
  strMediaMid?: string;
  media_mid?: string;
  songname?: string;
  name?: string;
  singer?: QqSinger[];
  albumname?: string;
  albummid?: string;
  interval?: number;
  size128?: number;
  size320?: number;
  sizeflac?: number;
};

type QqSearchResult = {
  list?: QqSearchSong[];
};

type QqResolvedSong = {
  url: string;
  qqType: "128" | "320" | "flac";
  extension: "mp3" | "flac";
  bitrate: number;
};

export function isQqMusicSong(song: Pick<Song, "source">) {
  return song.source === "qqmusic";
}

function formatDuration(durationSeconds: number | undefined) {
  if (!durationSeconds || durationSeconds <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(durationSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeQqText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function getQqSongMid(song: QqSearchSong) {
  return normalizeQqText(song.songmid ?? song.mid, "");
}

function getQqMediaMid(song: QqSearchSong, songMid: string) {
  return normalizeQqText(song.strMediaMid ?? song.media_mid, songMid);
}

function getQqAvailableQualities(song: QqSearchSong) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (Number(song.size320 ?? 0) > 0) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if (Number(song.sizeflac ?? 0) > 0) {
    qualities.push({ level: "lossless", label: "FLAC" });
  }

  return qualities;
}

function getHighestQualityLabel(qualities: DownloadQualityOption[]) {
  return qualities[qualities.length - 1]?.label ?? "128K";
}

function getQqCoverUrl(albumMid: string | undefined) {
  const mid = albumMid?.trim();
  return mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg` : undefined;
}

function mapQqSong(song: QqSearchSong): Song | null {
  const songMid = getQqSongMid(song);
  if (!songMid) {
    return null;
  }

  const artists = Array.isArray(song.singer)
    ? song.singer
        .map((artist) => ({
          id: artist.mid || (artist.id ? String(artist.id) : undefined),
          name: normalizeQqText(artist.name, "未知歌手")
        }))
        .filter((artist) => artist.name)
    : [];
  const qualities = getQqAvailableQualities(song);

  return {
    id: songMid,
    title: normalizeQqText(song.songname ?? song.name, "未知歌曲"),
    artist: artists.map((artist) => artist.name).join(" / ") || "未知歌手",
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : undefined,
    album: normalizeQqText(song.albumname, "未知专辑"),
    albumId: song.albummid?.trim() || undefined,
    mediaId: getQqMediaMid(song, songMid),
    coverUrl: getQqCoverUrl(song.albummid),
    duration: formatDuration(Number(song.interval ?? 0)),
    quality: getHighestQualityLabel(qualities),
    availableQualities: qualities,
    source: "qqmusic"
  };
}

function getQqRequestedLabel(level: DownloadQualityLevel) {
  switch (level) {
    case "exhigh":
      return "320K";
    case "lossless":
    case "hires":
      return "FLAC";
    default:
      return "128K";
  }
}

function getQqTypeForLevel(level: DownloadQualityLevel): QqResolvedSong["qqType"] {
  switch (level) {
    case "exhigh":
      return "320";
    case "lossless":
    case "hires":
      return "flac";
    default:
      return "128";
  }
}

function getQqResolvedMeta(qqType: QqResolvedSong["qqType"]) {
  if (qqType === "flac") {
    return { extension: "flac" as const, bitrate: 1000000, label: "FLAC" };
  }

  if (qqType === "320") {
    return { extension: "mp3" as const, bitrate: 320000, label: "MP3 320K" };
  }

  return { extension: "mp3" as const, bitrate: 128000, label: "MP3 128K" };
}

function getQqErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "object" && error && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }

  return "QQ 音乐接口请求失败";
}

async function configureQqCookie() {
  const settings = await getSettings();
  const cookie = settings.qqMusicCookie?.trim();
  qqMusic.setCookie(cookie || {});
}

async function resolveQqSongUrl(song: Song, level: DownloadQualityLevel): Promise<QqResolvedSong> {
  await configureQqCookie();
  const qqType = getQqTypeForLevel(level);
  let url = "";

  try {
    url = await qqMusic.api<string>("song/url", {
      id: song.id,
      mediaId: song.mediaId || song.id,
      type: qqType
    });
  } catch (error) {
    throw new Error(`QQ 音乐链接获取失败：${getQqErrorMessage(error)}。可在后续 QQ 登录接入后填入有效 Cookie 再试。`);
  }

  if (!url || typeof url !== "string") {
    throw new Error("QQ 音乐没有返回可用播放链接，可能需要 QQ Cookie、绿钻权限或该版本暂无版权。");
  }

  const meta = getQqResolvedMeta(qqType);
  return {
    url,
    qqType,
    extension: meta.extension,
    bitrate: meta.bitrate
  };
}

export async function searchQqMusicSongs(query: string): Promise<Song[]> {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }

  await configureQqCookie();
  const data = await qqMusic.api<QqSearchResult>("search", {
    key: keyword,
    pageNo: 1,
    pageSize: 20,
    t: 0
  });

  return (data.list ?? []).map(mapQqSong).filter((song): song is Song => Boolean(song));
}

export async function resolveQqSongStream(song: Song, level: DownloadQualityLevel) {
  const resolved = await resolveQqSongUrl(song, level);
  return {
    url: resolved.url
  };
}

export async function resolveQqDirectDownload(song: Song, level: DownloadQualityLevel) {
  const resolved = await resolveQqSongUrl(song, level);
  const safeTitle = `${song.title}-${song.artist}-${song.id}`
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  return {
    url: resolved.url,
    filename: `${safeTitle}.${resolved.extension}`,
    type: resolved.extension,
    time: null
  };
}

export async function probeQqSongAudio(song: Song, level: DownloadQualityLevel, mode: SongAudioProbeMode): Promise<SongAudioProbe> {
  const resolved = await resolveQqSongUrl(song, level);
  const meta = getQqResolvedMeta(resolved.qqType);

  return {
    songId: song.id,
    mode,
    requestedLevel: level,
    requestedLabel: getQqRequestedLabel(level),
    actualLabel: meta.label,
    actualLevel: resolved.qqType,
    actualBitrate: meta.bitrate,
    actualType: meta.extension.toUpperCase(),
    actualDuration: song.duration,
    trial: false
  };
}
