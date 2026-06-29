import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { Song } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { toSongFromUnifiedTrack } from "./music-platform/types.js";

const require = createRequire(import.meta.url);
const { recommend_songs } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type RecommendSong = {
  id: number;
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
  sq?: unknown | null;
  hr?: unknown | null;
};

type RecommendBody = {
  data?: {
    dailySongs?: RecommendSong[];
  };
};

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

function mapRecommendSong(song: RecommendSong): Song {
  const unifiedTrack = toUnifiedNeteaseTrack(
    {
      id: song.id,
      name: song.name,
      dt: song.dt,
      ar: song.ar,
      al: song.al,
      h: song.h,
      sq: song.sq,
      hr: song.hr
    },
    {
      source: "netease-daily",
      coverUrl: song.al?.picUrl
    }
  );

  if (!unifiedTrack) {
    return {
      id: String(song.id),
      title: song.name?.trim() || "未知歌曲",
      artist: "未知歌手",
      album: "未知专辑",
      duration: "00:00",
      quality: "128K",
      availableQualities: [{ level: "standard", label: "128K" }],
      source: "netease-daily"
    };
  }

  return toSongFromUnifiedTrack(unifiedTrack);
}

export async function getDailyRecommendSongs(): Promise<Song[]> {
  const cookie = await getCookie();
  const response = await recommend_songs({ cookie });
  const body = response.body as RecommendBody;

  return (body.data?.dailySongs ?? []).map(mapRecommendSong);
}
