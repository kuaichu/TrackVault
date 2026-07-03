import { createRequire } from "node:module";
import type { DownloadQualityLevel, DownloadQualityOption, LyricLine, PlaylistSongsPage, QqMusicAccountStatus, QqMusicCookieCheckResult, QqMusicProfileAlbum, QqMusicProfileSinger, QqMusicProfileUser, QqMusicUserProfile, Song, SongAudioProbe, SongAudioProbeMode, SongComment, SongCommentRepliesPage, SongCommentsPage, SongLyrics, UserPlaylist } from "./types.js";
import { getSettings } from "./settings-store.js";

const require = createRequire(import.meta.url);

type QqMusicApi = {
  cookie: Record<string, string>;
  uin?: string;
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
  song_mid?: string;
  strMediaMid?: string;
  media_mid?: string;
  title?: string;
  songname?: string;
  name?: string;
  singer?: QqSinger[];
  albumname?: string;
  album?: {
    id?: number | string;
    mid?: string;
    name?: string;
    title?: string;
  };
  albummid?: string;
  interval?: number;
  size128?: number;
  size320?: number;
  sizeflac?: number;
  file?: {
    media_mid?: string;
    size_128mp3?: number;
    size_320mp3?: number;
    size_flac?: number;
  };
};

type QqLyricResult = {
  lyric?: string;
  trans?: string;
};

type QqRawComment = {
  avatarurl?: string;
  commentid?: string;
  rootcommentid?: string;
  nick?: string;
  rootcommentnick?: string;
  uin?: string;
  encrypt_uin?: string;
  rootcommentcontent?: string;
  praisenum?: number;
  ispraise?: number;
  time?: number;
  middlecommentcontent?: Array<{
    subcommentcontent?: string;
  }> | null;
};

type QqCommentsResult = {
  comment?: {
    commentlist?: QqRawComment[];
    commenttotal?: number;
  };
  hotComment?: {
    commentlist?: QqRawComment[];
    commenttotal?: number;
  };
};

type QqSearchResult = {
  list?: QqSearchSong[];
};

type QqNewSongsResult = {
  list?: QqSearchSong[];
};

type QqUserSonglistItem = {
  dissid?: number | string;
  tid?: number | string;
  id?: number | string;
  dirid?: number | string;
  diss_name?: string;
  title?: string;
  diss_cover?: string;
  logo?: string;
  song_cnt?: number;
  songnum?: number;
  total_song_num?: number;
  listen_num?: number;
  visitnum?: number;
  creator?: {
    name?: string;
    nick?: string;
  };
};

type QqUserSonglistsResult = {
  list?: QqUserSonglistItem[];
  creator?: {
    hostname?: string;
  };
};

type QqCollectedSonglistsResult = {
  list?: QqUserSonglistItem[];
  total?: number;
};

type QqCollectionResult = Record<string, unknown>;

type QqSonglistDetail = {
  dissid?: number | string;
  disstid?: number | string;
  dirid?: number | string;
  dissname?: string;
  title?: string;
  logo?: string;
  songnum?: number;
  total_song_num?: number;
  visitnum?: number;
  songlist?: QqSearchSong[];
};

type QqAudioType = "m4a" | "128" | "320" | "flac";

type QqResolvedSong = {
  url: string;
  qqType: QqAudioType;
  extension: "m4a" | "mp3" | "flac";
  bitrate: number;
};

type QqProfileDetail = Record<string, unknown>;

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
  return normalizeQqText(song.songmid ?? song.song_mid ?? song.mid, "");
}

function getQqMediaMid(song: QqSearchSong, songMid: string) {
  return normalizeQqText(song.strMediaMid ?? song.media_mid ?? song.file?.media_mid, songMid);
}

function getQqAvailableQualities(song: QqSearchSong) {
  const qualities: DownloadQualityOption[] = [{ level: "standard", label: "128K" }];

  if (Number(song.size320 ?? song.file?.size_320mp3 ?? 0) > 0) {
    qualities.push({ level: "exhigh", label: "320K" });
  }

  if (Number(song.sizeflac ?? song.file?.size_flac ?? 0) > 0) {
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
    providerSongId: song.id || song.songid ? String(song.id ?? song.songid) : undefined,
    title: normalizeQqText(song.songname ?? song.title ?? song.name, "未知歌曲"),
    artist: artists.map((artist) => artist.name).join(" / ") || "未知歌手",
    primaryArtistId: artists[0]?.id,
    artists: artists.length > 0 ? artists : undefined,
    album: normalizeQqText(song.albumname ?? song.album?.title ?? song.album?.name, "未知专辑"),
    albumId: song.albummid?.trim() || song.album?.mid?.trim() || (song.album?.id ? String(song.album.id) : undefined),
    mediaId: getQqMediaMid(song, songMid),
    coverUrl: getQqCoverUrl(song.albummid ?? song.album?.mid),
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

function getQqTypeForLevel(level: DownloadQualityLevel): QqAudioType {
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

function getQqAudioTypeLabel(qqType: QqAudioType) {
  switch (qqType) {
    case "flac":
      return "FLAC";
    case "320":
      return "320K";
    case "m4a":
      return "M4A";
    default:
      return "128K";
  }
}

function getQqResolvedMeta(qqType: QqAudioType) {
  if (qqType === "flac") {
    return { extension: "flac" as const, bitrate: 1000000, label: "FLAC" };
  }

  if (qqType === "320") {
    return { extension: "mp3" as const, bitrate: 320000, label: "MP3 320K" };
  }

  if (qqType === "m4a") {
    return { extension: "m4a" as const, bitrate: 128000, label: "M4A 128K" };
  }

  return { extension: "mp3" as const, bitrate: 128000, label: "MP3 128K" };
}

function buildQqSongAudioProbe(
  song: Song,
  mode: SongAudioProbeMode,
  requestedLevel: DownloadQualityLevel,
  resolved: QqResolvedSong
): SongAudioProbe {
  const meta = getQqResolvedMeta(resolved.qqType);

  return {
    songId: song.id,
    mode,
    requestedLevel,
    requestedLabel: getQqRequestedLabel(requestedLevel),
    actualLabel: meta.label,
    actualLevel: resolved.qqType,
    actualBitrate: meta.bitrate,
    actualType: meta.extension.toUpperCase(),
    actualDuration: song.duration,
    trial: false
  };
}

function getQqDownloadProbeFallbackLevels(song: Song, requestedLevel: DownloadQualityLevel) {
  const availableLevels = new Set((song.availableQualities ?? []).map((quality) => quality.level));
  const levels: DownloadQualityLevel[] = [requestedLevel];

  if (getQqTypeForLevel(requestedLevel) === "flac" && availableLevels.has("exhigh")) {
    levels.push("exhigh");
  }

  if (getQqTypeForLevel(requestedLevel) !== "128") {
    levels.push("standard");
  }

  const seenQqTypes = new Set<QqAudioType>();
  return levels.filter((level) => {
    const qqType = getQqTypeForLevel(level);
    if (seenQqTypes.has(qqType)) {
      return false;
    }

    seenQqTypes.add(qqType);
    return true;
  });
}

function getQqPlaybackFallbackTypes(level: DownloadQualityLevel) {
  const requestedType = getQqTypeForLevel(level);
  const fallbackTypes: QqAudioType[] = [requestedType];

  if (requestedType === "flac") {
    fallbackTypes.push("320");
  }

  if (requestedType !== "128") {
    fallbackTypes.push("128");
  }

  fallbackTypes.push("m4a");

  const seen = new Set<QqAudioType>();
  return fallbackTypes.filter((type) => {
    if (seen.has(type)) {
      return false;
    }

    seen.add(type);
    return true;
  });
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

function parseQqCookie(cookie: string) {
  const cookieObj: Record<string, string> = {};

  cookie
    .replace(/\r?\n+/g, "; ")
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const equalIndex = part.indexOf("=");
      const colonIndex = part.indexOf(":");
      const separatorIndex = equalIndex >= 0
        ? equalIndex
        : colonIndex >= 0
          ? colonIndex
          : -1;
      if (separatorIndex <= 0) {
        return;
      }

      const key = part.slice(0, separatorIndex).trim().replace(/^"+|"+$/g, "");
      const value = part.slice(separatorIndex + 1).trim().replace(/^"+|"+$/g, "");
      if (key && value) {
        cookieObj[key] = value;
      }
    });

  if (Number(cookieObj.login_type) === 2 && cookieObj.wxuin) {
    cookieObj.uin = cookieObj.wxuin;
  }

  cookieObj.uin = (cookieObj.uin || "").replace(/\D/g, "");
  return cookieObj;
}

function serializeQqCookie(cookieObj: Record<string, string>) {
  return Object.entries(cookieObj)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function fetchQqJson(path: string, query: Record<string, string | number>, cookieObj: Record<string, string>): Promise<QqCollectionResult> {
  const url = new URL(path);
  Object.entries(query).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    headers: {
      Cookie: serializeQqCookie(cookieObj),
      Referer: "https://y.qq.com/",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`QQ 音乐接口状态异常：${response.status}`);
  }

  const text = await response.text();
  const jsonText = text.replace(/^[\w$]+\(/, "").replace(/\);?$/, "");
  const data = JSON.parse(jsonText) as QqCollectionResult;
  const code = data.code ?? data.result;
  if (code === 1000 || code === 301) {
    throw new Error("QQ 音乐登录态失效或权限不足");
  }

  return data;
}

function getQqCollectedAlbums(cookieObj: Record<string, string>) {
  return fetchQqJson("https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg", {
    ct: 20,
    cid: 205360956,
    userid: cookieObj.uin,
    reqtype: 2,
    sin: 0,
    ein: 19
  }, cookieObj);
}

function getQqFollowSingers(cookieObj: Record<string, string>) {
  return fetchQqJson("https://c.y.qq.com/rsc/fcgi-bin/fcg_order_singer_getlist.fcg", {
    utf8: 1,
    page: 1,
    perpage: 20,
    uin: cookieObj.uin,
    g_tk: 5381,
    format: "json"
  }, cookieObj);
}

function getQqFollowUsers(cookieObj: Record<string, string>) {
  return fetchQqJson("https://c.y.qq.com/rsc/fcgi-bin/friend_follow_or_listen_list.fcg", {
    utf8: 1,
    start: 0,
    num: 20,
    uin: cookieObj.uin,
    format: "json",
    g_tk: 5381
  }, cookieObj);
}

function getQqFans(cookieObj: Record<string, string>) {
  return fetchQqJson("https://c.y.qq.com/rsc/fcgi-bin/friend_follow_or_listen_list.fcg", {
    utf8: 1,
    start: 0,
    num: 20,
    uin: cookieObj.uin,
    format: "json",
    g_tk: 5381,
    is_listen: 1
  }, cookieObj);
}

function getQqCookieIdentity(cookie: string) {
  const cookieObj = parseQqCookie(cookie);
  if (!cookieObj.uin) {
    throw new Error("QQ 音乐 Cookie 缺少 uin 或 wxuin，请重新导入 Cookie。");
  }

  return cookieObj;
}

async function getRequiredQqCookie() {
  const settings = await getSettings();
  const cookie = settings.qqMusicCookie?.trim() ?? "";
  if (!cookie) {
    throw new Error("请先导入 QQ 音乐 Cookie。");
  }

  const cookieObj = getQqCookieIdentity(cookie);
  qqMusic.setCookie(cookieObj);
  return cookieObj;
}

function getQqPlaylistId(playlist: QqUserSonglistItem | QqSonglistDetail) {
  const record = playlist as Record<string, unknown>;
  return normalizeQqText(record.dissid ?? record.disstid ?? record.tid ?? record.id ?? record.dirid, "");
}

function getQqImageUrl(url: unknown) {
  if (typeof url !== "string" || !url.trim()) {
    return undefined;
  }

  const trimmed = url.trim();
  return trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
}

function mapQqPlaylist(playlist: QqUserSonglistItem, creatorName: string, owned: boolean): UserPlaylist | null {
  const id = getQqPlaylistId(playlist);
  if (!id) {
    return null;
  }

  return {
    id: `qq:${id}`,
    name: normalizeQqText(playlist.diss_name ?? playlist.title, "未命名歌单"),
    coverUrl: getQqImageUrl(playlist.diss_cover ?? playlist.logo),
    trackCount: Number(playlist.song_cnt ?? playlist.songnum ?? playlist.total_song_num ?? 0),
    creatorName: normalizeQqText(playlist.creator?.name ?? playlist.creator?.nick, creatorName),
    playCount: Number(playlist.listen_num ?? playlist.visitnum ?? 0),
    owned
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getRecordString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function getRecordNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, value);
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(/,/g, ""));
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }

  return 0;
}

function findFirstArray(input: unknown, keys: string[], visited = new Set<unknown>()): unknown[] {
  if (!input || typeof input !== "object" || visited.has(input)) {
    return [];
  }

  visited.add(input);
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  for (const value of Object.values(record)) {
    const found = findFirstArray(value, keys, visited);
    if (found.length > 0) {
      return found;
    }
  }

  return [];
}

function getResultTotal(input: unknown, fallback: number) {
  const record = asRecord(input);
  if (!record) {
    return fallback;
  }

  return getRecordNumber(record, ["total", "totalnum", "totalNum", "total_num", "num", "count"]) || fallback;
}

function getQqSingerAvatar(mid: string) {
  return mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : undefined;
}

function mapQqProfileAlbum(input: unknown): QqMusicProfileAlbum | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const albumRecord = asRecord(record.album) ?? record;
  const id = getRecordString(albumRecord, ["mid", "albummid", "albumMid", "album_mid", "id", "albumid", "albumId"]);
  const name = getRecordString(albumRecord, ["name", "albumname", "albumName", "title", "diss_name"]);
  if (!id || !name) {
    return null;
  }

  const coverUrl =
    getQqImageUrl(getRecordString(albumRecord, ["pic", "picurl", "picUrl", "cover", "coverUrl", "logo"])) ??
    getQqCoverUrl(id);
  const singerRecord = asRecord(record.singer) ?? asRecord(record.artist);
  const artistName =
    getRecordString(record, ["singername", "singerName", "artistName", "singer", "artist"]) ||
    (singerRecord ? getRecordString(singerRecord, ["name", "title"]) : "") ||
    "未知歌手";

  return {
    id,
    name,
    coverUrl,
    artistName,
    songCount: getRecordNumber(record, ["songnum", "songNum", "song_count", "songCount", "total_song_num"]),
    publishTime: getRecordString(record, ["publicTime", "publishTime", "pub_time", "date", "time"]) || undefined
  };
}

function mapQqProfileSinger(input: unknown): QqMusicProfileSinger | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id = getRecordString(record, ["mid", "singermid", "singer_mid", "singerMid", "id"]);
  const name = getRecordString(record, ["name", "singername", "singerName", "title"]);
  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    avatarUrl: getQqImageUrl(getRecordString(record, ["pic", "picurl", "picUrl", "avatar", "avatarUrl", "headurl", "headUrl"])) ?? getQqSingerAvatar(id),
    fanCount: getRecordNumber(record, ["fans", "fansnum", "fanNum", "fan_count", "fansCount"]),
    songCount: getRecordNumber(record, ["songnum", "songNum", "song_count", "songCount"])
  };
}

function mapQqProfileUser(input: unknown): QqMusicProfileUser | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const id = getRecordString(record, ["uin", "encrypt_uin", "id", "userid", "userId"]);
  const nickname = getRecordString(record, ["nick", "nickname", "name", "hostname", "title"]);
  if (!id || !nickname) {
    return null;
  }

  return {
    id,
    nickname,
    avatarUrl: getQqImageUrl(getRecordString(record, ["headurl", "headUrl", "avatar", "avatarUrl", "pic", "logo"])),
    signature: getRecordString(record, ["desc", "signature", "intro", "msg"]) || "这个用户还没有简介。",
    fanCount: getRecordNumber(record, ["fans", "fansnum", "fanNum", "followeds", "followedNum"]),
    followed: Boolean(record.followed ?? record.isfollow ?? record.isFollow)
  };
}

function compactMappedList<T>(items: unknown[], mapper: (item: unknown) => T | null, limit = 12) {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const mapped of items.map(mapper)) {
    if (!mapped) {
      continue;
    }

    const identity = "id" in (mapped as Record<string, unknown>) ? String((mapped as Record<string, unknown>).id) : JSON.stringify(mapped);
    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    output.push(mapped);
    if (output.length >= limit) {
      break;
    }
  }

  return output;
}

function getRawQqPlaylistId(playlistId: string) {
  return playlistId.replace(/^qq:/, "").trim();
}

function filterSongs(songs: Song[], keyword: string) {
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  if (!normalizedKeyword) {
    return songs;
  }

  return songs.filter((song) =>
    [song.title, song.artist, song.album].some((field) => field.toLocaleLowerCase().includes(normalizedKeyword))
  );
}

function sortSongs(songs: Song[], sortMode: string) {
  if (sortMode === "default") {
    return songs;
  }

  const compareText = (left: string, right: string) => left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  const sortedSongs = [...songs];

  sortedSongs.sort((left, right) => {
    switch (sortMode) {
      case "title-asc":
        return compareText(left.title, right.title);
      case "title-desc":
        return compareText(right.title, left.title);
      case "artist-asc":
        return compareText(left.artist, right.artist) || compareText(left.title, right.title);
      case "artist-desc":
        return compareText(right.artist, left.artist) || compareText(right.title, left.title);
      default:
        return 0;
    }
  });

  return sortedSongs;
}

function parseQqTimestamp(raw: string) {
  const match = raw.match(/^(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(match[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
  return minutes * 60 + seconds + fraction;
}

function parseQqLrc(raw: string | undefined) {
  if (!raw?.trim()) {
    return [];
  }

  const lines: LyricLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g)];
    if (stamps.length === 0) {
      continue;
    }

    const text = row.replace(/\[(\d{1,2}:\d{2}(?:[.:]\d{1,3})?)\]/g, "").trim();
    if (!text || /^[a-z]+:/i.test(text)) {
      continue;
    }

    for (const stamp of stamps) {
      const time = parseQqTimestamp(stamp[1]);
      if (time !== null) {
        lines.push({ time, text });
      }
    }
  }

  return lines.sort((left, right) => left.time - right.time);
}

function mergeQqTranslations(lines: LyricLine[], translations: LyricLine[]) {
  if (translations.length === 0) {
    return lines;
  }

  const translationMap = new Map(translations.map((line) => [line.time.toFixed(3), line.text]));
  return lines.map((line) => ({
    ...line,
    translation: translationMap.get(line.time.toFixed(3))
  }));
}

function formatQqCommentTime(timestamp: number | undefined) {
  if (!timestamp) {
    return "";
  }

  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(milliseconds));
}

function mapQqComment(comment: QqRawComment): SongComment | null {
  const id = normalizeQqText(comment.rootcommentid ?? comment.commentid, "");
  const content = normalizeQqText(comment.rootcommentcontent, "");
  if (!id || !content) {
    return null;
  }

  const inlineReply = comment.middlecommentcontent?.find((item) => item.subcommentcontent?.trim());

  return {
    id,
    userId: normalizeQqText(comment.uin ?? comment.encrypt_uin, ""),
    nickname: normalizeQqText(comment.rootcommentnick ?? comment.nick, "QQ 音乐用户").replace(/^@/, ""),
    avatarUrl: getQqImageUrl(comment.avatarurl),
    content,
    timeText: formatQqCommentTime(comment.time),
    time: typeof comment.time === "number" ? (comment.time > 10_000_000_000 ? comment.time : comment.time * 1000) : undefined,
    liked: Number(comment.ispraise ?? 0) === 1,
    likedCount: Math.max(0, Number(comment.praisenum ?? 0)),
    replyCount: 0,
    replyContent: inlineReply?.subcommentcontent?.trim()
  };
}

function firstStringByKeys(input: unknown, keys: string[], visited = new Set<unknown>()): string | undefined {
  if (!input || typeof input !== "object" || visited.has(input)) {
    return undefined;
  }

  visited.add(input);
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstStringByKeys(item, keys, visited);
        if (found) {
          return found;
        }
      }
      continue;
    }

    const found = firstStringByKeys(value, keys, visited);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function firstTruthyVip(input: unknown, visited = new Set<unknown>()): number | string | undefined {
  if (!input || typeof input !== "object" || visited.has(input)) {
    return undefined;
  }

  visited.add(input);
  const record = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLocaleLowerCase();
    const mayBeVipKey = normalizedKey.includes("vip") || normalizedKey.includes("green") || normalizedKey.includes("lv");
    if (!mayBeVipKey) {
      continue;
    }

    if (typeof value === "number" && value > 0) {
      return value;
    }

    if (typeof value === "string" && value.trim() && value !== "0" && value.toLocaleLowerCase() !== "false") {
      return value.trim();
    }

    if (typeof value === "boolean" && value) {
      return 1;
    }
  }

  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = firstTruthyVip(item, visited);
        if (found) {
          return found;
        }
      }
      continue;
    }

    const found = firstTruthyVip(value, visited);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function toQqAccountStatus(cookieObj: Record<string, string>, detail: QqProfileDetail | null, message: string): QqMusicAccountStatus {
  const displayName =
    firstStringByKeys(detail, ["nick", "nickname", "hostname", "creatorName", "name"]) ??
    (cookieObj.uin ? `QQ ${cookieObj.uin}` : null);
  const avatarUrl = getQqImageUrl(firstStringByKeys(detail, ["headurl", "headUrl", "avatar", "avatarUrl", "pic", "logo"]));
  const vipType = firstTruthyVip(detail);

  return {
    ok: Boolean(cookieObj.uin),
    uin: cookieObj.uin || null,
    displayName,
    avatarUrl,
    vipEnabled: Boolean(vipType),
    vipType,
    message
  };
}

async function configureQqCookie() {
  const settings = await getSettings();
  const cookie = settings.qqMusicCookie?.trim();
  qqMusic.setCookie(cookie || {});
}

export async function checkQqMusicCookie(cookie: string): Promise<QqMusicCookieCheckResult> {
  const trimmed = cookie.trim();
  if (!trimmed) {
    return {
      ok: false,
      uin: null,
      message: "请先粘贴 QQ 音乐网页登录后的 Cookie。"
    };
  }

  const cookieObj = parseQqCookie(trimmed);
  if (!cookieObj.uin) {
    return {
      ok: false,
      uin: null,
      message: "QQ 音乐 Cookie 缺少 uin 或 wxuin，请从 y.qq.com 登录后的 Cookies 里完整复制。"
    };
  }

  if (!cookieObj.qm_keyst && !cookieObj.qqmusic_key) {
    return {
      ok: false,
      uin: cookieObj.uin,
      message: "QQ 音乐 Cookie 缺少 qm_keyst 或 qqmusic_key，无法用于获取会员音源。"
    };
  }

  qqMusic.setCookie(cookieObj);

  try {
    const refreshed = await qqMusic.api<{ musickey?: string }>("user/refresh");
    const refreshedKey = refreshed.musickey?.trim();
    const nextCookie: Record<string, string> = {
      ...cookieObj,
      ...(refreshedKey ? { qm_keyst: refreshedKey, qqmusic_key: refreshedKey } : {})
    };

    return {
      ok: true,
      uin: nextCookie.uin,
      message: `QQ 音乐 Cookie 有效：${nextCookie.uin}`,
      refreshedCookie: serializeQqCookie(nextCookie)
    };
  } catch (error) {
    return {
      ok: true,
      uin: cookieObj.uin,
      message: `QQ 音乐 Cookie 已保存，但刷新 key 失败：${getQqErrorMessage(error)}。如果试听/下载仍失败，请重新登录 QQ 音乐后再提取。`,
      refreshedCookie: serializeQqCookie(cookieObj)
    };
  }
}

export async function getQqMusicAccountStatus(): Promise<QqMusicAccountStatus> {
  const settings = await getSettings();
  const cookie = settings.qqMusicCookie?.trim() ?? "";
  if (!cookie) {
    return {
      ok: false,
      uin: null,
      displayName: null,
      vipEnabled: false,
      message: "未导入 QQ 音乐 Cookie。"
    };
  }

  const cookieObj = parseQqCookie(cookie);
  if (!cookieObj.uin) {
    return {
      ok: false,
      uin: null,
      displayName: null,
      vipEnabled: false,
      message: "QQ 音乐 Cookie 缺少 uin 或 wxuin。"
    };
  }

  qqMusic.setCookie(cookieObj);

  try {
    const detail = await qqMusic.api<QqProfileDetail>("user/detail", { id: cookieObj.uin });
    return toQqAccountStatus(cookieObj, detail, "QQ 音乐账号信息已同步。");
  } catch (error) {
    return toQqAccountStatus(cookieObj, null, `QQ 音乐账号信息读取失败：${getQqErrorMessage(error)}`);
  }
}

export async function getQqMusicUserProfile(): Promise<QqMusicUserProfile> {
  const cookieObj = await getRequiredQqCookie();
  const issues: QqMusicUserProfile["issues"] = [];
  const [detailResult, createdResult, collectedPlaylistsResult, collectedAlbumsResult, followSingersResult, followUsersResult, fansResult] =
    await Promise.allSettled([
      qqMusic.api<QqProfileDetail>("user/detail", { id: cookieObj.uin }),
      qqMusic.api<QqUserSonglistsResult>("user/songlist", { id: cookieObj.uin }),
      qqMusic.api<QqCollectedSonglistsResult>("user/collect/songlist", { id: cookieObj.uin, pageNo: 1, pageSize: 50 }),
      getQqCollectedAlbums(cookieObj),
      getQqFollowSingers(cookieObj),
      getQqFollowUsers(cookieObj),
      getQqFans(cookieObj)
    ]);

  const addIssue = (section: string, result: PromiseSettledResult<unknown>) => {
    if (result.status === "rejected") {
      issues.push({ section, message: getQqErrorMessage(result.reason) });
    }
  };

  addIssue("主页资料", detailResult);
  addIssue("创建歌单", createdResult);
  addIssue("收藏歌单", collectedPlaylistsResult);
  addIssue("收藏专辑", collectedAlbumsResult);
  addIssue("关注歌手", followSingersResult);
  addIssue("关注用户", followUsersResult);
  addIssue("粉丝", fansResult);

  const detail = detailResult.status === "fulfilled" ? detailResult.value : null;
  const account = toQqAccountStatus(
    cookieObj,
    detail,
    detailResult.status === "fulfilled" ? "QQ 音乐个人资料已同步。" : "QQ 音乐基础资料读取失败，已显示可用数据。"
  );
  const creatorName =
    createdResult.status === "fulfilled"
      ? normalizeQqText(createdResult.value.creator?.hostname, account.displayName ?? `QQ ${cookieObj.uin}`)
      : account.displayName ?? `QQ ${cookieObj.uin}`;
  const createdPlaylists =
    createdResult.status === "fulfilled"
      ? (createdResult.value.list ?? []).map((playlist) => mapQqPlaylist(playlist, creatorName, true)).filter((playlist): playlist is UserPlaylist => Boolean(playlist))
      : [];
  const collectedPlaylists =
    collectedPlaylistsResult.status === "fulfilled"
      ? (collectedPlaylistsResult.value.list ?? []).map((playlist) => mapQqPlaylist(playlist, creatorName, false)).filter((playlist): playlist is UserPlaylist => Boolean(playlist))
      : [];
  const seenPlaylistIds = new Set<string>();
  const uniqueCollectedPlaylists = collectedPlaylists.filter((playlist) => {
    if (createdPlaylists.some((item) => item.id === playlist.id) || seenPlaylistIds.has(playlist.id)) {
      return false;
    }

    seenPlaylistIds.add(playlist.id);
    return true;
  });
  const detailRecord = asRecord(detail) ?? {};
  const collectedAlbumItems = collectedAlbumsResult.status === "fulfilled"
    ? findFirstArray(collectedAlbumsResult.value, ["list", "albumlist", "albums", "data", "items"])
    : [];
  const followSingerItems = followSingersResult.status === "fulfilled"
    ? findFirstArray(followSingersResult.value, ["list", "singerlist", "singers", "data", "items"])
    : [];
  const followUserItems = followUsersResult.status === "fulfilled"
    ? findFirstArray(followUsersResult.value, ["list", "userlist", "users", "follow", "data", "items"])
    : [];
  const fanItems = fansResult.status === "fulfilled"
    ? findFirstArray(fansResult.value, ["list", "userlist", "users", "fans", "data", "items"])
    : [];

  return {
    account,
    detail: {
      signature: getRecordString(detailRecord, ["desc", "signature", "intro", "msg"]) || "这个 QQ 音乐账号还没有公开简介。",
      level: getRecordNumber(detailRecord, ["level", "lv", "userLevel"]) || undefined,
      listenSongs: getRecordNumber(detailRecord, ["listen_num", "listenSongs", "listenSongsNum", "totalListen", "songnum"]) || undefined,
      locationText: getRecordString(detailRecord, ["location", "place", "city", "province"]) || undefined,
      ageText: getRecordString(detailRecord, ["age", "ageText"]) || undefined
    },
    stats: {
      createdPlaylists: createdPlaylists.length,
      collectedPlaylists: getResultTotal(collectedPlaylistsResult.status === "fulfilled" ? collectedPlaylistsResult.value : null, uniqueCollectedPlaylists.length),
      collectedAlbums: getResultTotal(collectedAlbumsResult.status === "fulfilled" ? collectedAlbumsResult.value : null, collectedAlbumItems.length),
      followSingers: getResultTotal(followSingersResult.status === "fulfilled" ? followSingersResult.value : null, followSingerItems.length),
      followUsers: getResultTotal(followUsersResult.status === "fulfilled" ? followUsersResult.value : null, followUserItems.length),
      fans: getResultTotal(fansResult.status === "fulfilled" ? fansResult.value : null, fanItems.length)
    },
    createdPlaylists,
    collectedPlaylists: uniqueCollectedPlaylists,
    collectedAlbums: compactMappedList(collectedAlbumItems, mapQqProfileAlbum, 12),
    followSingers: compactMappedList(followSingerItems, mapQqProfileSinger, 12),
    followUsers: compactMappedList(followUserItems, mapQqProfileUser, 12),
    fans: compactMappedList(fanItems, mapQqProfileUser, 12),
    issues
  };
}

async function resolveQqSongUrlByType(song: Song, qqType: QqAudioType): Promise<QqResolvedSong> {
  await configureQqCookie();
  let url = "";

  try {
    url = await qqMusic.api<string>("song/url", {
      id: song.id,
      mediaId: song.mediaId || song.id,
      type: qqType
    });
  } catch (error) {
    throw new Error(`QQ 音乐链接获取失败：${getQqErrorMessage(error)}。请检查 QQ Cookie、会员权限或尝试较低音质。`);
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

async function resolveQqSongUrl(song: Song, level: DownloadQualityLevel): Promise<QqResolvedSong> {
  return resolveQqSongUrlByType(song, getQqTypeForLevel(level));
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

export async function getQqDiscoverSongs(): Promise<Song[]> {
  await configureQqCookie();
  const data = await qqMusic.api<QqNewSongsResult>("new/songs", {
    type: 0
  });

  return (data.list ?? []).map(mapQqSong).filter((song): song is Song => Boolean(song)).slice(0, 30);
}

export async function getQqUserPlaylists(): Promise<UserPlaylist[]> {
  const cookieObj = await getRequiredQqCookie();
  const [createdResult, collectedResult] = await Promise.allSettled([
    qqMusic.api<QqUserSonglistsResult>("user/songlist", { id: cookieObj.uin }),
    qqMusic.api<QqCollectedSonglistsResult>("user/collect/songlist", { id: cookieObj.uin, pageNo: 1, pageSize: 50 })
  ]);

  const creatorName =
    createdResult.status === "fulfilled"
      ? normalizeQqText(createdResult.value.creator?.hostname, `QQ ${cookieObj.uin}`)
      : `QQ ${cookieObj.uin}`;
  const createdPlaylists =
    createdResult.status === "fulfilled"
      ? (createdResult.value.list ?? []).map((playlist) => mapQqPlaylist(playlist, creatorName, true)).filter((playlist): playlist is UserPlaylist => Boolean(playlist))
      : [];
  const collectedPlaylists =
    collectedResult.status === "fulfilled"
      ? (collectedResult.value.list ?? []).map((playlist) => mapQqPlaylist(playlist, creatorName, false)).filter((playlist): playlist is UserPlaylist => Boolean(playlist))
      : [];
  const seen = new Set<string>();

  return [...createdPlaylists, ...collectedPlaylists].filter((playlist) => {
    if (seen.has(playlist.id)) {
      return false;
    }

    seen.add(playlist.id);
    return true;
  });
}

export async function getQqPlaylistSongs(playlistId: string, page = 1, limit = 100, keyword = "", sortMode = "default"): Promise<PlaylistSongsPage> {
  await configureQqCookie();
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit) || 100));
  const rawPlaylistId = getRawQqPlaylistId(playlistId);
  if (!rawPlaylistId) {
    throw new Error("缺少 QQ 音乐歌单 ID。");
  }

  const data = await qqMusic.api<QqSonglistDetail>("songlist", {
    id: rawPlaylistId
  });
  const allSongs = (data.songlist ?? []).map(mapQqSong).filter((song): song is Song => Boolean(song));
  const filteredSongs = sortSongs(filterSongs(allSongs, keyword), sortMode);
  const offset = (safePage - 1) * safeLimit;
  const songs = filteredSongs.slice(offset, offset + safeLimit);

  return {
    songs,
    page: safePage,
    limit: safeLimit,
    hasMore: offset + songs.length < filteredSongs.length,
    total: filteredSongs.length,
    sourceTotal: allSongs.length,
    keyword: keyword.trim()
  };
}

export async function getQqSongLyrics(songId: string, mediaId?: string): Promise<SongLyrics> {
  const songMid = (mediaId || songId).trim();
  if (!songMid) {
    throw new Error("缺少 QQ 音乐 songmid。");
  }

  await configureQqCookie();
  const data = await qqMusic.api<QqLyricResult>("lyric", {
    songmid: songMid
  });
  const lines = mergeQqTranslations(parseQqLrc(data.lyric), parseQqLrc(data.trans));

  return {
    songId,
    lines,
    source: "qqmusic"
  };
}

export async function getQqSongComments(songId: string, page = 1, limit = 20): Promise<SongCommentsPage> {
  const safeSongId = songId.trim();
  if (!safeSongId || !/^\d+$/.test(safeSongId)) {
    throw new Error("QQ 音乐评论需要数字 songid，当前歌曲缺少该信息。");
  }

  await configureQqCookie();
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));
  const data = await qqMusic.api<QqCommentsResult>("comment", {
    id: safeSongId,
    pageNo: safePage,
    pageSize: safeLimit,
    biztype: 1,
    type: 0
  });
  const comments = (data.comment?.commentlist ?? []).map(mapQqComment).filter((comment): comment is SongComment => Boolean(comment));
  const hotComments = safePage === 1
    ? (data.hotComment?.commentlist ?? []).map(mapQqComment).filter((comment): comment is SongComment => Boolean(comment))
    : [];
  const total = Number(data.comment?.commenttotal ?? comments.length);

  return {
    songId: safeSongId,
    total: Math.max(0, total),
    page: safePage,
    limit: safeLimit,
    hasMore: comments.length >= safeLimit,
    hotComments,
    comments
  };
}

export async function getQqSongCommentReplies(songId: string, parentCommentId: string): Promise<SongCommentRepliesPage> {
  return {
    songId,
    parentCommentId,
    replies: [],
    total: 0,
    hasMore: false
  };
}

export async function setQqSongCommentLiked(commentId: string, liked: boolean) {
  await getRequiredQqCookie();
  const safeCommentId = commentId.trim();
  if (!safeCommentId) {
    throw new Error("缺少 QQ 音乐评论 ID。");
  }

  await qqMusic.api("comment/like", {
    id: safeCommentId,
    type: liked ? 1 : 2
  });

  return { liked };
}

export async function resolveQqSongStream(song: Song, level: DownloadQualityLevel) {
  const fallbackTypes = getQqPlaybackFallbackTypes(level);
  let lastError: Error | null = null;

  for (const qqType of fallbackTypes) {
    try {
      const resolved = await resolveQqSongUrlByType(song, qqType);
      return {
        url: resolved.url
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("播放音源获取失败");
    }
  }

  const triedText = fallbackTypes.map(getQqAudioTypeLabel).join(" / ");
  const suffix = lastError ? `最后错误：${lastError.message}` : "请检查 QQ Cookie、会员权限或该版本版权状态。";
  throw new Error(`QQ 音乐未返回可播放链接（已尝试 ${triedText}）。${suffix}`);
}

export async function resolveQqDirectDownload(song: Song, level: DownloadQualityLevel) {
  const fallbackTypes = getQqPlaybackFallbackTypes(level);
  let resolved: QqResolvedSong | null = null;
  let lastError: Error | null = null;

  for (const qqType of fallbackTypes) {
    try {
      resolved = await resolveQqSongUrlByType(song, qqType);
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("下载链接获取失败");
    }
  }

  if (!resolved) {
    const requestedLabel = getQqRequestedLabel(level);
    const triedText = fallbackTypes.map(getQqAudioTypeLabel).join(" / ");
    const suffix = lastError ? `最后错误：${lastError.message}` : "请检查 QQ Cookie、绿钻权限或该版本版权状态。";
    throw new Error(`QQ 音乐未返回 ${requestedLabel} 下载链接（已尝试 ${triedText}）。${suffix}`);
  }

  const meta = getQqResolvedMeta(resolved.qqType);
  const safeTitle = [song.title, song.artist]
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" - ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "TrackVault 下载";

  return {
    url: resolved.url,
    filename: `${safeTitle}.${resolved.extension}`,
    type: resolved.extension,
    quality: meta.label,
    time: null
  };
}

export async function probeQqSongAudio(song: Song, level: DownloadQualityLevel, mode: SongAudioProbeMode): Promise<SongAudioProbe> {
  if (mode !== "download") {
    const fallbackTypes = getQqPlaybackFallbackTypes(level);
    let lastError: Error | null = null;

    for (const qqType of fallbackTypes) {
      try {
        return buildQqSongAudioProbe(song, mode, level, await resolveQqSongUrlByType(song, qqType));
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("播放音源检测失败");
      }
    }

    const triedText = fallbackTypes.map(getQqAudioTypeLabel).join(" / ");
    const suffix = lastError ? `最后错误：${lastError.message}` : "请检查 QQ Cookie、会员权限或该版本版权状态。";
    throw new Error(`QQ 音乐未返回可播放链接（已尝试 ${triedText}）。${suffix}`);
  }

  const fallbackLevels = getQqDownloadProbeFallbackLevels(song, level);
  let lastError: Error | null = null;
  for (const fallbackLevel of fallbackLevels) {
    try {
      return buildQqSongAudioProbe(song, mode, level, await resolveQqSongUrl(song, fallbackLevel));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("下载音源检测失败");
    }
  }

  const requestedLabel = getQqRequestedLabel(level);
  const fallbackText = fallbackLevels.length > 1 ? "，降级检测也失败" : "";
  const suffix = lastError ? `最后错误：${lastError.message}` : "请检查 QQ Cookie、绿钻权限或该版本版权状态。";
  throw new Error(`QQ 音乐未返回 ${requestedLabel} 下载链接${fallbackText}。${suffix}`);
}
