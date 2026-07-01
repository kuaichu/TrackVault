import { createRequire } from "node:module";
import type { DownloadQualityLevel, DownloadQualityOption, LyricLine, PlaylistSongsPage, QqMusicAccountStatus, QqMusicCookieCheckResult, Song, SongAudioProbe, SongAudioProbeMode, SongComment, SongCommentRepliesPage, SongCommentsPage, SongLyrics, UserPlaylist } from "./types.js";
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

type QqResolvedSong = {
  url: string;
  qqType: "128" | "320" | "flac";
  extension: "mp3" | "flac";
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
  const avatarUrl = firstStringByKeys(detail, ["headurl", "headUrl", "avatar", "avatarUrl", "pic", "logo"]);
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
