import { createRequire } from "node:module";
import { getSession } from "./account-store.js";
import { getSettings } from "./settings-store.js";
import type { SongInsight, SongInsightTag } from "./types.js";

const require = createRequire(import.meta.url);
const {
  music_first_listen_info,
  record_recent_song,
  song_detail,
  song_wiki_summary,
  user_record
} = require("NeteaseCloudMusicApi") as Record<string, (query: Record<string, unknown>) => Promise<{ body: unknown }>>;

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function normalizeTimestamp(value: unknown) {
  const parsed = toNumber(value);
  if (!parsed || parsed <= 0) {
    return undefined;
  }

  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function formatDateText(timestamp: number | undefined) {
  if (!timestamp) {
    return undefined;
  }

  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
}

function formatCompactCount(count: number | undefined) {
  if (typeof count !== "number" || !Number.isFinite(count)) {
    return undefined;
  }

  if (count >= 10000) {
    return `${(count / 10000).toFixed(count >= 100000 ? 0 : 1).replace(/\.0$/, "")}万次`;
  }

  return `${count} 次`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function findTimestampByKey(value: unknown, keyPattern: RegExp, depth = 0): number | undefined {
  if (depth > 7) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTimestampByKey(item, keyPattern, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const timestamp = normalizeTimestamp(item);
      if (timestamp) {
        return timestamp;
      }
    }

    const found = findTimestampByKey(item, keyPattern, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function songIdMatches(value: unknown, songId: string): boolean {
  const parsed = toNumber(value);
  return parsed !== undefined && String(parsed) === songId;
}

function findPlayRecord(records: unknown, songId: string): AnyRecord | null {
  for (const item of asArray(records)) {
    if (!isRecord(item)) {
      continue;
    }

    const song = item.song;
    if (isRecord(song) && songIdMatches(song.id, songId)) {
      return item;
    }
  }

  return null;
}

function findRecentListenTime(value: unknown, songId: string, depth = 0): number | undefined {
  if (depth > 8) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecentListenTime(item, songId, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const candidateSong = value.song ?? value.resource ?? value.data;
  const resourceId = value.resourceId ?? value.songId ?? value.id;
  const hasSongId = (isRecord(candidateSong) && songIdMatches(candidateSong.id, songId)) || songIdMatches(resourceId, songId);
  if (hasSongId) {
    return (
      normalizeTimestamp(value.playTime) ??
      normalizeTimestamp(value.time) ??
      normalizeTimestamp(value.listenTime) ??
      normalizeTimestamp(value.updateTime) ??
      normalizeTimestamp(value.createTime)
    );
  }

  for (const item of Object.values(value)) {
    const found = findRecentListenTime(item, songId, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function getTitle(value: unknown) {
  if (!isRecord(value)) {
    return "";
  }

  const mainTitle = isRecord(value.mainTitle) ? toText(value.mainTitle.title) : "";
  return mainTitle || toText(value.title) || toText(value.text) || toText(value.name);
}

function collectWikiTags(wikiBody: unknown) {
  const tags: SongInsightTag[] = [];
  const data = isRecord(wikiBody) ? wikiBody.data : undefined;
  const blocks = isRecord(data) ? asArray(data.blocks) : [];
  const basicBlock = blocks.find((block) => isRecord(block) && block.code === "SONG_PLAY_ABOUT_SONG_BASIC");

  if (!isRecord(basicBlock)) {
    return tags;
  }

  for (const creative of asArray(basicBlock.creatives)) {
    if (!isRecord(creative)) {
      continue;
    }

    const label = getTitle(creative.uiElement);
    const values = new Set<string>();

    const uiElement = isRecord(creative.uiElement) ? creative.uiElement : {};
    for (const textLink of asArray(uiElement.textLinks)) {
      const text = isRecord(textLink) ? toText(textLink.text) : "";
      if (text) {
        values.add(text);
      }
    }

    for (const resource of asArray(creative.resources)) {
      if (!isRecord(resource)) {
        continue;
      }

      const title = getTitle(resource.uiElement);
      if (title) {
        values.add(title);
      }
    }

    if (label && values.size > 0) {
      tags.push({ label, values: [...values].slice(0, 4) });
    }
  }

  return tags.slice(0, 6);
}

function getSongDetailSong(detailBody: unknown) {
  const songs = isRecord(detailBody) ? asArray(detailBody.songs) : [];
  return isRecord(songs[0]) ? songs[0] : null;
}

function getOriginText(detailSong: AnyRecord | null) {
  if (!detailSong) {
    return undefined;
  }

  const originCoverType = toNumber(detailSong.originCoverType);
  const origin = isRecord(detailSong.originSongSimpleData) ? detailSong.originSongSimpleData : null;
  const originName = origin ? toText(origin.name) : "";
  const originArtists = origin ? asArray(origin.artists).map((artist) => (isRecord(artist) ? toText(artist.name) : "")).filter(Boolean).join(" / ") : "";

  if (originName) {
    return originArtists ? `翻唱自 ${originName} · ${originArtists}` : `翻唱自 ${originName}`;
  }

  if (originCoverType === 1) {
    return "原曲";
  }

  if (originCoverType === 2) {
    return "翻唱曲";
  }

  return undefined;
}

function getSourceText(detailSong: AnyRecord | null) {
  if (!detailSong) {
    return undefined;
  }

  const alias = asArray(detailSong.alia).map(toText).find(Boolean);
  const album = isRecord(detailSong.al) ? toText(detailSong.al.name) : "";
  return alias || (album ? `收录于《${album}》` : undefined);
}

async function getCookie() {
  const settings = await getSettings();
  return settings.neteaseCookie.trim();
}

export async function getNeteaseSongInsight(songId: string): Promise<SongInsight> {
  const cookie = await getCookie();
  const requestConfig = cookie ? { cookie } : {};
  const session = await getSession().catch(() => null);
  const uid = session?.profile?.provider === "netease" ? session.profile.id : "";

  const [detailResult, wikiResult, firstListenResult, userRecordResult, recentResult] = await Promise.allSettled([
    song_detail({ ids: songId, ...requestConfig }),
    song_wiki_summary({ id: songId, ...requestConfig }),
    cookie ? music_first_listen_info({ id: songId, ...requestConfig }) : Promise.reject(new Error("missing cookie")),
    cookie && uid ? user_record({ uid, type: 0, ...requestConfig }) : Promise.reject(new Error("missing user")),
    cookie ? record_recent_song({ limit: 100, ...requestConfig }) : Promise.reject(new Error("missing cookie"))
  ]);

  const detailBody = detailResult.status === "fulfilled" ? detailResult.value.body : null;
  const wikiBody = wikiResult.status === "fulfilled" ? wikiResult.value.body : null;
  const firstListenBody = firstListenResult.status === "fulfilled" ? firstListenResult.value.body : null;
  const userRecordBody = userRecordResult.status === "fulfilled" ? userRecordResult.value.body : null;
  const recentBody = recentResult.status === "fulfilled" ? recentResult.value.body : null;

  const detailSong = getSongDetailSong(detailBody);
  const allRecord = isRecord(userRecordBody) ? findPlayRecord(userRecordBody.allData, songId) : null;
  const weekRecord = isRecord(userRecordBody) ? findPlayRecord(userRecordBody.weekData, songId) : null;
  const playCount = toNumber(allRecord?.playCount) ?? toNumber(weekRecord?.playCount);
  const firstListenTime = findTimestampByKey(firstListenBody, /first.*(listen|play).*time|first.*time|listen.*time/i);
  const recentListenTime = findRecentListenTime(recentBody, songId);
  const publishTime = detailSong ? normalizeTimestamp(detailSong.publishTime) : undefined;
  const tags = collectWikiTags(wikiBody);

  return {
    songId,
    listening: {
      playCount,
      playCountText: formatCompactCount(playCount),
      firstListenText: formatDateText(firstListenTime),
      recentListenText: formatDateText(recentListenTime),
      note: cookie ? undefined : "登录网易云后可读取个人听歌记忆"
    },
    encyclopedia: {
      tags,
      sourceText: getSourceText(detailSong),
      releaseText: publishTime ? `发行于 ${formatDateText(publishTime)}` : undefined,
      originText: getOriginText(detailSong)
    }
  };
}
