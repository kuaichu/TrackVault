import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { Song } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { toSongFromUnifiedTrack } from "./music-platform/types.js";

const require = createRequire(import.meta.url);
const { user_cloud } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type CloudSongItem = {
  privateCloud?: {
    song?: string;
    artist?: string;
    album?: string;
    bitrate?: number;
    fileSize?: number;
  };
  simpleSong?: {
    id?: number;
    name?: string;
    dt?: number;
    ar?: Array<{
      id?: number;
      name?: string;
    }>;
  al?: {
    id?: number;
    name?: string;
    picUrl?: string;
  };
    h?: unknown | null;
    m?: unknown | null;
    l?: {
      br?: number;
    } | null;
    sq?: unknown | null;
    hr?: unknown | null;
  };
};

type CloudBody = {
  data?: CloudSongItem[];
  count?: number;
  size?: number;
  maxSize?: number;
  hasMore?: boolean;
};

const CLOUD_PAGE_SIZE = 500;

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

function mapCloudSong(item: CloudSongItem): Song | null {
  const song = item.simpleSong;
  const privateCloud = item.privateCloud;
  const unifiedTrack = song
    ? toUnifiedNeteaseTrack(
        {
          id: song.id,
          name: song.name ?? privateCloud?.song,
          dt: song.dt,
          ar: song.ar,
          al: song.al,
          h: song.h ?? (song.l?.br && song.l.br >= 320000 ? { br: song.l.br } : null),
          sq: song.sq,
          hr: song.hr
        },
        {
          source: "netease-cloud",
          coverUrl: song.al?.picUrl
        }
      )
    : null;

  if (!unifiedTrack) {
    return null;
  }

  const mapped = toSongFromUnifiedTrack(unifiedTrack);
  return {
    ...mapped,
    title: mapped.title || privateCloud?.song?.trim() || "未知歌曲",
    artist: mapped.artist || privateCloud?.artist?.trim() || "未知歌手",
    album: mapped.album || privateCloud?.album?.trim() || "云盘音乐"
  };
}

export async function getCloudSongs(): Promise<{ songs: Song[]; count: number; size: number; maxSize: number }> {
  const cookie = await getCookie();
  const songs: Song[] = [];
  let count = 0;
  let size = 0;
  let maxSize = 0;

  for (let offset = 0; ; offset += CLOUD_PAGE_SIZE) {
    const response = await user_cloud({
      limit: CLOUD_PAGE_SIZE,
      offset,
      cookie
    });
    const body = response.body as CloudBody;
    const pageSongs = body.data ?? [];
    count = body.count ?? count;
    size = body.size ?? size;
    maxSize = body.maxSize ?? maxSize;

    for (const item of pageSongs) {
      const mapped = mapCloudSong(item);
      if (mapped) {
        songs.push(mapped);
      }
    }

    if (!body.hasMore || pageSongs.length < CLOUD_PAGE_SIZE) {
      break;
    }
  }

  return {
    songs,
    count: count || songs.length,
    size,
    maxSize
  };
}
