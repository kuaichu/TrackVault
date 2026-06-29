import { createRequire } from "node:module";
import { formatImageUrl, type UnifiedTrack, toSongFromUnifiedTrack } from "./music-platform/types.js";
import type { Song } from "./types.js";

const require = createRequire(import.meta.url);
const qqMusic = require("qq-music-api") as {
  api: (path: string, query?: Record<string, string | number>) => Promise<any>;
};

type QqSinger = {
  id?: number | string;
  mid?: string;
  name?: string;
};

type QqSearchSong = {
  songid?: number | string;
  songmid?: string;
  songname?: string;
  interval?: number;
  albumid?: number | string;
  albummid?: string;
  albumname?: string;
  media_mid?: string;
  strMediaMid?: string;
  singer?: QqSinger[];
  size320?: number;
  sizeflac?: number;
  sizeape?: number;
  pay?: {
    payplay?: number;
    paydownload?: number;
  };
  preview?: {
    trybegin?: number;
    tryend?: number;
    trysize?: number;
  };
};

function getQqQualityLabel(song: QqSearchSong) {
  if ((song.sizeflac ?? 0) > 0 || (song.sizeape ?? 0) > 0) {
    return "FLAC";
  }

  if ((song.size320 ?? 0) > 0) {
    return "320K";
  }

  return "128K";
}

function getQqAvailableQualities(song: QqSearchSong) {
  const qualities = [{ level: "standard", label: "128K" }] as UnifiedTrack["availableQualities"];

  if ((song.size320 ?? 0) > 0) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if ((song.sizeflac ?? 0) > 0 || (song.sizeape ?? 0) > 0) {
    qualities.push({ level: "lossless", label: "FLAC" });
  }

  return qualities;
}

function buildQqCoverUrl(song: QqSearchSong) {
  const albumMid = song.albummid?.trim();
  if (!albumMid) {
    return undefined;
  }

  return formatImageUrl(`https://y.qq.com/music/photo_new/T002R800x800M000${albumMid}.jpg`, 160);
}

function mapQqSearchSong(song: QqSearchSong): Song | null {
  const songId = song.songmid?.trim() || (song.songid ? String(song.songid) : "");
  if (!songId) {
    return null;
  }

  const artists =
    song.singer?.map((artist) => ({
      id: artist.mid?.trim() || (artist.id ? String(artist.id) : undefined),
      name: artist.name?.trim() || "未知歌手"
    })).filter((artist) => artist.name) ?? [];

  const unifiedTrack: UnifiedTrack = {
    id: songId,
    platform: "qq",
    title: song.songname?.trim() || "未知歌曲",
    artists,
    album: {
      id: song.albummid?.trim() || (song.albumid ? String(song.albumid) : undefined),
      name: song.albumname?.trim() || "未知专辑",
      coverUrl: buildQqCoverUrl(song)
    },
    durationMs: typeof song.interval === "number" && song.interval > 0 ? song.interval * 1000 : undefined,
    qualityLabel: getQqQualityLabel(song),
    availableQualities: getQqAvailableQualities(song),
    source: "qq-search"
  };

  return toSongFromUnifiedTrack(unifiedTrack);
}

export async function searchQqSongs(query: string): Promise<Song[]> {
  const keyword = query.trim();
  if (!keyword) {
    return [];
  }

  const data = await qqMusic.api("search", {
    key: keyword,
    pageNo: 1,
    pageSize: 20,
    t: 0
  });

  const list = Array.isArray(data?.list) ? (data.list as QqSearchSong[]) : [];
  return list.map(mapQqSearchSong).filter((song): song is Song => Boolean(song));
}
