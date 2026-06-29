import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { Song } from "./types.js";
import { toUnifiedNeteaseTrack } from "./music-platform/netease-adapter.js";
import { toSongFromUnifiedTrack } from "./music-platform/types.js";

const require = createRequire(import.meta.url);
const { personalized_newsong } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");
const DISCOVER_CACHE_TTL_MS = 10 * 60 * 1000;

let discoverCache: { fetchedAt: number; songs: Song[] } | null = null;
let discoverRefreshPromise: Promise<Song[]> | null = null;

type PersonalizedNewSongItem = {
  song?: {
    id?: number;
    name?: string;
    duration?: number;
    artists?: Array<{
      id?: number;
      name?: string;
    }>;
    album?: {
      id?: number;
      name?: string;
      picUrl?: string;
    };
    hMusic?: unknown | null;
    sqMusic?: unknown | null;
    hrMusic?: unknown | null;
  };
};

type PersonalizedNewSongBody = {
  result?: PersonalizedNewSongItem[];
};

function mapDiscoverSong(item: PersonalizedNewSongItem): Song | null {
  const song = item.song;
  const unifiedTrack = song
    ? toUnifiedNeteaseTrack(
        {
          id: song.id,
          name: song.name,
          duration: song.duration,
          artists: song.artists,
          album: song.album
            ? {
                id: song.album.id,
                name: song.album.name,
                picUrl: song.album.picUrl
              }
            : undefined,
          h: song.hMusic,
          sq: song.sqMusic,
          hr: song.hrMusic
        },
        {
          source: "netease-discover",
          coverUrl: song.album?.picUrl
        }
      )
    : null;

  return unifiedTrack ? toSongFromUnifiedTrack(unifiedTrack) : null;
}

async function fetchDiscoverSongs(): Promise<Song[]> {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  const response = await personalized_newsong({
    limit: 30,
    ...(cookie ? { cookie } : {})
  });
  const body = response.body as PersonalizedNewSongBody;

  return (body.result ?? []).map(mapDiscoverSong).filter((song): song is Song => Boolean(song));
}

async function refreshDiscoverCache() {
  if (!discoverRefreshPromise) {
    discoverRefreshPromise = fetchDiscoverSongs()
      .then((songs) => {
        discoverCache = {
          fetchedAt: Date.now(),
          songs
        };
        return songs;
      })
      .finally(() => {
        discoverRefreshPromise = null;
      });
  }

  return discoverRefreshPromise;
}

export async function getDiscoverSongs(): Promise<Song[]> {
  const cacheAge = discoverCache ? Date.now() - discoverCache.fetchedAt : Number.POSITIVE_INFINITY;

  if (discoverCache && cacheAge < DISCOVER_CACHE_TTL_MS) {
    return discoverCache.songs;
  }

  if (discoverCache) {
    void refreshDiscoverCache().catch(() => undefined);
    return discoverCache.songs;
  }

  return refreshDiscoverCache();
}
