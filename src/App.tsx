import { type CSSProperties, FormEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  addSongToPlaylist,
  checkNeteaseCookie,
  getAdminConfig as getAdminConfigRemote,
  sendNeteaseCaptcha,
  downloadTaskFile,
  cancelNeteaseImportAuditJob,
  createNeteaseImportAuditPlayablePlaylist,
  exportPlaylistCompare,
  exportNeteaseImportAuditJob,
  getAlbumProfile,
  getArtistProfile,
  getPlaylistCompareJob,
  getNeteaseImportAuditJob,
  getPlaylistTransferRunJob,
  exportPlaylistTransferJob,
  importPlaylistTransferToNetease,
  getSongLiked,
  getSession,
  getPlayHistory,
  getPlayerState as getPlayerStateRemote,
  getCloudSongs,
  getDailyRecommendSongs,
  getDiscoverSongs,
  getPlaylistSongs,
  getPlaylists,
  getSongCommentReplies,
  getSongComments,
  getUserEvents,
  getUserProfile,
  getUserSocialList,
  getSearchHistory,
  getLyrics,
  getSettings,
  getStreamUrl,
  getTasks,
  checkNeteaseQrLogin,
  isDirectDownloadBlockedError,
  removeSearchHistory as removeSearchHistoryRemote,
  removeSongsFromPlaylist,
  resolveArtistByName,
  loginAccount,
  loginWithNeteaseCellphone,
  logoutAccount,
  savePlayHistory,
  savePlayerState as savePlayerStateRemote,
  saveSearchHistory,
  saveAdminConfig as saveAdminConfigRemote,
  setSongLiked,
  saveSettings,
  setSongCommentLiked,
  setUserFollowed,
  startNeteaseQrLogin,
  startDirectSongDownload,
  startServerSongDownload,
  startNeteaseImportAuditJob,
  startPlaylistCompareJob,
  startPlaylistTransferRunJob,
  replyToSongComment,
  searchSongs
} from "./api";
import type { AdminConfigUpdate, AdminConfigView, AlbumProfile, AppSettings, ArtistProfile, AuthSession, DownloadQualityLevel, DownloadTask, LyricLine, NeteaseCookieCheckResult, NeteaseImportAudit, NeteaseImportAuditJob, NeteaseImportAuditStatus, NeteaseTransferImportResult, PersistedPlayerState, PlaylistCompareJob, PlaylistCompareResult, PlaylistCompareStatus, PlaylistTransferJob, PlaylistTransferRunJob, Song, SongArtist, SongComment, SongCommentRepliesPage, SongCommentsPage, TransferExportFormat, TransferSourceProvider, TransferTargetProvider, TransferExportResult, UserEventItem, UserEventsPage, UserPlaylist, UserProfile, UserSocialListKind, UserSocialPage, UserSocialUser } from "./types";

const quickKeywords = ["周杰伦", "陈奕迅", "林俊杰", "告五人", "Taylor Swift"];
const PLAYLIST_SONGS_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 20;
const COMMENT_REPLY_PAGE_SIZE = 20;
const USER_SOCIAL_PAGE_SIZE = 30;
const USER_EVENTS_PAGE_SIZE = 20;
const neteaseEmojiMap: Record<string, string> = {
  "[爱心]": "\u2764\uFE0F",
  "[心碎]": "\uD83D\uDC94",
  "[强]": "\uD83D\uDC4D",
  "[弱]": "\uD83D\uDC4E",
  "[大笑]": "\uD83D\uDE04",
  "[可爱]": "\uD83D\uDE0A",
  "[憨笑]": "\uD83D\uDE01",
  "[呲牙]": "\uD83D\uDE01",
  "[亲亲]": "\uD83D\uDE18",
  "[色]": "\uD83D\uDE0D",
  "[流泪]": "\uD83D\uDE22",
  "[大哭]": "\uD83D\uDE2D",
  "[惊恐]": "\uD83D\uDE31",
  "[惊讶]": "\uD83D\uDE2E",
  "[晕]": "\uD83D\uDE35",
  "[生病]": "\uD83E\uDD12",
  "[口罩]": "\uD83D\uDE37",
  "[撇嘴]": "\uD83D\uDE15",
  "[尴尬]": "\uD83D\uDE05",
  "[开心]": "\uD83D\uDE04",
  "[鬼脸]": "\uD83D\uDE1C",
  "[拜]": "\uD83D\uDE4F",
  "[礼物]": "\uD83C\uDF81",
  "[蛋糕]": "\uD83C\uDF82",
  "[钟情]": "\uD83D\uDC98",
  "[星星]": "\u2B50",
  "[便便]": "\uD83D\uDCA9",
  "[牵手]": "\uD83E\uDD1D",
  "[跳舞]": "\uD83D\uDC83"
};
const settingsQualityOptions: Array<{ level: DownloadQualityLevel; label: string }> = [
  { level: "hires", label: "Hi-Res" },
  { level: "lossless", label: "FLAC" },
  { level: "exhigh", label: "320K" },
  { level: "standard", label: "128K" }
];

const playbackQualityOptions: Array<{ level: DownloadQualityLevel; label: string }> = [
  { level: "standard", label: "128K" },
  { level: "exhigh", label: "320K" },
  { level: "lossless", label: "FLAC" },
  { level: "hires", label: "Hi-Res" }
];
const playlistSortOptions: Array<{ value: PlaylistSortMode; label: string }> = [
  { value: "default", label: "默认顺序" },
  { value: "title-asc", label: "标题 A-Z" },
  { value: "title-desc", label: "标题 Z-A" },
  { value: "artist-asc", label: "歌手 A-Z" },
  { value: "artist-desc", label: "歌手 Z-A" }
];
const PLAYLIST_SORT_MENU_ESTIMATED_HEIGHT = 214;
const FLOATING_MENU_MARGIN = 12;
const defaultSettings: AppSettings = {
  accountName: "本地账号",
  vipEnabled: false,
  providerMode: "netease",
  downloadDirectory: "downloads",
  neteaseCookie: "",
  notes: "",
  defaultPlaybackQuality: "standard",
  defaultDownloadQuality: "hires",
  maxConcurrentDownloads: 3
};

const defaultAdminConfig: AdminConfigView = {
  trustedUserWhitelistText: "",
  hasSystemDefaultToken: false,
  systemFallbackEnabled: false
};

type MainTab = "search" | "account" | "settings";
type NavKey = "discover" | "search" | "daily" | "playlists" | "transfer" | "cloud" | "downloads" | "history" | "artist" | "album";
type RightPanelTab = "queue" | "lyrics" | "comments";
type DownloadIssueDialog = {
  song: Song;
  message: string;
  attemptedLevel: DownloadQualityLevel;
  attemptedLabel: string;
};
type ResultSource = "search" | "playlist" | "cloud" | "daily" | "discover" | "artist" | "album";
type UserProfileView = "profile" | UserSocialListKind | "events";
type PlaylistSortMode = "default" | "title-asc" | "title-desc" | "artist-asc" | "artist-desc";
type FloatingMenuStyle = Pick<CSSProperties, "top" | "left" | "width" | "maxHeight">;
type SongContextMenuState = { song: Song; x: number; y: number };
type UserProfileTarget = { id: string; fallbackName?: string; fallbackAvatarUrl?: string };
type NeteaseLoginMode = "qr" | "cellphone" | "cookie";
type ViewSnapshot = {
  results: Song[];
  playQueue: Song[];
  resultSource: ResultSource;
  activePlaylist: UserPlaylist | null;
  activeArtist: ArtistProfile | null;
  activeAlbum: AlbumProfile | null;
  selectedPlaylistId: string | null;
  playlistSongsPage: number;
  playlistSongsLimit: number;
  playlistSongsHasMore: boolean;
  playlistSongsTotal: number;
  playlistSearchInput: string;
  playlistSearchKeyword: string;
  cloudMeta: { count: number; size: number; maxSize: number };
  qualitySelections: Record<string, DownloadQualityLevel>;
  qualitySelectionTouched: Record<string, true>;
  resultScrollTop: number;
};

type ViewState = { mainTab: MainTab; navKey: NavKey; snapshot: ViewSnapshot };

const navText: Record<NavKey, { title: string; subtitle: string }> = {
  discover: { title: "发现音乐", subtitle: "推荐新歌与近期值得听的音乐" },
  search: { title: "搜索", subtitle: "按歌曲、歌手或专辑检索并试听下载" },
  daily: { title: "每日推荐", subtitle: "读取网易云今日为你推荐的歌曲" },
  playlists: { title: "我的歌单", subtitle: "读取网易云账号歌单并载入歌曲" },
  transfer: { title: "歌单互转", subtitle: "跨平台匹配、缺失识别与文字歌单导出" },
  cloud: { title: "云盘音乐", subtitle: "读取网易云音乐云盘并载入歌曲" },
  downloads: { title: "下载管理", subtitle: "查看服务器下载任务、进度和输出文件" },
  history: { title: "播放历史", subtitle: "回看最近播放并快速继续收听" }
  ,
  artist: { title: "歌手", subtitle: "查看歌手热门歌曲与简介" },
  album: { title: "专辑", subtitle: "查看专辑详情与曲目列表" }
};

const SEARCH_HISTORY_STORAGE_KEY = "net-music-down:search-history";
const DISCOVER_CACHE_STORAGE_KEY = "net-music-down:discover-cache";
const PLAY_HISTORY_STORAGE_KEY = "net-music-down:play-history";
const PLAYER_STATE_STORAGE_KEY = "net-music-down:player-state";
const DISCOVER_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const USER_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PLAYER_STATE: PersistedPlayerState = {
  currentTrack: null,
  playQueue: [],
  playbackSeconds: 0,
  volume: 72,
  playbackMode: "sequential"
};
const QR_LOGIN_DEFAULT_MESSAGE = "打开网易云音乐 App 扫码登录。";
const CELLPHONE_LOGIN_DEFAULT_MESSAGE = "请输入手机号并发送验证码登录。";
const COOKIE_LOGIN_DEFAULT_MESSAGE = "粘贴网页登录后的 MUSIC_U Cookie。";
const COOKIE_LOGIN_GUIDE = "Chrome/Edge：F12 -> Application / 应用 -> Cookies -> https://music.163.com -> MUSIC_U -> 复制 Value。Firefox：F12 -> 存储 -> Cookies -> https://music.163.com -> MUSIC_U -> 复制值。直接粘贴值，或 MUSIC_U:\"...\" 都可以。";

type SongCachePayload = {
  savedAt: number;
  songs: Song[];
};

type RgbColor = { r: number; g: number; b: number };
type HslColor = { h: number; s: number; l: number };
type PlayerTheme = {
  base: string;
  panel: string;
  soft: string;
  glow: string;
  accent: string;
};

type PlayerThemeStyle = CSSProperties & {
  "--player-theme-base": string;
  "--player-theme-panel": string;
  "--player-theme-soft": string;
  "--player-theme-glow": string;
  "--player-theme-accent": string;
  "--player-cover-image": string;
};

const defaultPlayerTheme: PlayerTheme = {
  base: "18, 24, 36",
  panel: "12, 18, 28",
  soft: "42, 56, 78",
  glow: "143, 205, 236",
  accent: "167, 223, 247"
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function rgbToHsl({ r, g, b }: RgbColor): HslColor {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 215, s: 0.12, l: lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0);
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }

  return { h: hue * 60, s: saturation, l: lightness };
}

function hslToRgb({ h, s, l }: HslColor): RgbColor {
  const hue = (((h % 360) + 360) % 360) / 360;

  if (s <= 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }

  const hueToRgb = (p: number, q: number, t: number) => {
    let nextT = t;
    if (nextT < 0) nextT += 1;
    if (nextT > 1) nextT -= 1;
    if (nextT < 1 / 6) return p + (q - p) * 6 * nextT;
    if (nextT < 1 / 2) return q;
    if (nextT < 2 / 3) return p + (q - p) * (2 / 3 - nextT) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255)
  };
}

function rgbToCss({ r, g, b }: RgbColor) {
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

function buildPlayerThemeFromColor(color: RgbColor): PlayerTheme {
  const hsl = rgbToHsl(color);
  const saturation = clampNumber(hsl.s, 0.18, 0.62);

  return {
    base: rgbToCss(hslToRgb({ h: hsl.h, s: saturation * 0.48, l: 0.15 })),
    panel: rgbToCss(hslToRgb({ h: hsl.h, s: saturation * 0.5, l: 0.12 })),
    soft: rgbToCss(hslToRgb({ h: hsl.h, s: saturation * 0.6, l: 0.24 })),
    glow: rgbToCss(hslToRgb({ h: hsl.h, s: saturation * 0.72, l: 0.36 })),
    accent: rgbToCss(hslToRgb({ h: hsl.h, s: saturation * 0.84, l: 0.62 }))
  };
}

function buildFallbackPlayerTheme(seed: string): PlayerTheme {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return buildPlayerThemeFromColor(hslToRgb({ h: hash % 360, s: 0.42, l: 0.42 }));
}

function pickAtmosphereColor(image: HTMLImageElement): RgbColor {
  const canvas = document.createElement("canvas");
  const size = 48;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available");
  }

  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  let totalWeight = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 220) {
      continue;
    }

    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    const hsl = rgbToHsl(color);
    if (hsl.l < 0.12 || hsl.l > 0.86) {
      continue;
    }

    const chromaWeight = clampNumber(hsl.s * 1.8, 0.08, 1.2);
    const midLightWeight = 1 - Math.abs(hsl.l - 0.48) * 1.45;
    const weight = Math.max(0.04, chromaWeight * clampNumber(midLightWeight, 0.25, 1));
    red += color.r * weight;
    green += color.g * weight;
    blue += color.b * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    throw new Error("No usable cover pixels");
  }

  return {
    r: red / totalWeight,
    g: green / totalWeight,
    b: blue / totalWeight
  };
}

function loadSearchHistory() {
  try {
    const rawHistory = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    if (!rawHistory) {
      return [];
    }

    const parsedHistory = JSON.parse(rawHistory);
    if (!Array.isArray(parsedHistory)) {
      return [];
    }

    return parsedHistory.filter((item): item is string => typeof item === "string").slice(0, 10);
  } catch {
    return [];
  }
}

function loadCachedDiscoverSongs() {
  try {
    const rawCache = window.localStorage.getItem(DISCOVER_CACHE_STORAGE_KEY);
    if (!rawCache) {
      return [];
    }

    const parsedCache = JSON.parse(rawCache) as Partial<SongCachePayload>;
    if (!Array.isArray(parsedCache.songs) || !parsedCache.savedAt) {
      return [];
    }

    if (Date.now() - parsedCache.savedAt > DISCOVER_CACHE_TTL_MS) {
      return [];
    }

    return parsedCache.songs.filter((song): song is Song => Boolean(song?.id && song.title));
  } catch {
    return [];
  }
}

function saveCachedDiscoverSongs(songs: Song[]) {
  try {
    window.localStorage.setItem(
      DISCOVER_CACHE_STORAGE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        songs
      } satisfies SongCachePayload)
    );
  } catch {
    // Cache writes are best-effort; the API result itself is still authoritative.
  }
}

function loadPlayHistory() {
  try {
    const rawHistory = window.localStorage.getItem(PLAY_HISTORY_STORAGE_KEY);
    if (!rawHistory) {
      return [];
    }

    const parsedHistory = JSON.parse(rawHistory);
    if (!Array.isArray(parsedHistory)) {
      return [];
    }

    return parsedHistory
      .filter((item): item is Song => Boolean(item?.id && item?.title && item?.artist))
      .slice(0, 30);
  } catch {
    return [];
  }
}

function loadPlayerState(): PersistedPlayerState {
  try {
    const rawState = window.localStorage.getItem(PLAYER_STATE_STORAGE_KEY);
    if (!rawState) {
      return DEFAULT_PLAYER_STATE;
    }

    const parsedState = JSON.parse(rawState) as Partial<PersistedPlayerState>;
    const queue = Array.isArray(parsedState.playQueue)
      ? parsedState.playQueue.filter((item): item is Song => Boolean(item?.id && item?.title && item?.artist)).slice(0, 100)
      : [];
    const currentTrack =
      parsedState.currentTrack && parsedState.currentTrack.id && parsedState.currentTrack.title && parsedState.currentTrack.artist
        ? parsedState.currentTrack
        : null;
    const playbackSeconds = Number.isFinite(parsedState.playbackSeconds) ? Math.max(0, Number(parsedState.playbackSeconds)) : 0;
    const volume = Number.isFinite(parsedState.volume) ? Math.min(100, Math.max(0, Math.round(Number(parsedState.volume)))) : 72;

    return {
      currentTrack,
      playQueue: queue,
      playbackSeconds,
      volume,
      playbackMode: parsedState.playbackMode === "shuffle" ? "shuffle" : "sequential"
    };
  } catch {
    return DEFAULT_PLAYER_STATE;
  }
}

function savePlayerStateLocal(state: PersistedPlayerState) {
  try {
    window.localStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort only.
  }
}

function hasPersistedPlayerState(state: PersistedPlayerState) {
  return Boolean(
    state.currentTrack ||
      state.playQueue.length > 0 ||
      state.playbackSeconds > 0 ||
      state.volume !== DEFAULT_PLAYER_STATE.volume ||
      state.playbackMode === "shuffle"
  );
}

function statusLabel(status: DownloadTask["status"]) {
  switch (status) {
    case "queued":
      return "排队中";
    case "preparing":
      return "准备中";
    case "downloading":
      return "下载中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function parseDurationSeconds(duration: string) {
  const [minutesText, secondsText] = duration.split(":");
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }

  return minutes * 60 + seconds;
}

function formatPlaybackTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
}

function formatFileSize(size?: number) {
  if (!size || size <= 0) {
    return "--";
  }

  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function formatCompactCount(count: number) {
  if (count >= 100000000) {
    return `${(count / 100000000).toFixed(1).replace(/\.0$/, "")} 亿`;
  }

  if (count >= 10000) {
    return `${(count / 10000).toFixed(1).replace(/\.0$/, "")} 万`;
  }

  return count.toLocaleString();
}

function formatGenderLabel(gender: UserProfile["gender"]) {
  if (gender === "male") {
    return "男";
  }

  if (gender === "female") {
    return "女";
  }

  return "未知";
}

function formatUserEventType(type: number | undefined) {
  const labels: Record<number, string> = {
    13: "分享歌单",
    17: "分享节目",
    18: "分享单曲",
    19: "分享专辑",
    21: "分享视频",
    22: "转发动态",
    24: "分享专栏",
    28: "分享节目",
    35: "分享歌单",
    39: "发布视频",
    41: "分享视频"
  };

  return typeof type === "number" ? labels[type] ?? "用户动态" : "用户动态";
}

function formatUserEventResourceType(resource: UserEventItem["resource"]) {
  if (!resource) {
    return "";
  }

  const labels: Record<NonNullable<UserEventItem["resource"]>["type"], string> = {
    song: "单曲",
    playlist: "歌单",
    album: "专辑",
    video: "视频",
    resource: "资源"
  };

  return labels[resource.type];
}

function getDailyRecommendDateLabel(now = new Date()) {
  const date = new Date(now);

  if (date.getHours() < 6) {
    date.setDate(date.getDate() - 1);
  }

  return `${String(date.getMonth() + 1).padStart(2, "0")}月${String(date.getDate()).padStart(2, "0")}日`;
}

function MusicGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="music-glyph">
      <path d="M9 18.25c0 1.24-1.18 2.25-2.63 2.25S3.75 19.49 3.75 18.25 4.93 16 6.37 16c.56 0 1.08.15 1.5.4V5.2c0-.56.37-1.05.9-1.2l9-2.5c.76-.21 1.48.36 1.48 1.15v12.1c0 1.24-1.18 2.25-2.63 2.25S14 15.99 14 14.75s1.18-2.25 2.62-2.25c.56 0 1.08.15 1.5.4V5.18L9 7.72v10.53Z" />
    </svg>
  );
}

function VaultGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" className="brand-glyph">
      <circle cx="32" cy="31" r="19" className="brand-glyph-disc" />
      <circle cx="32" cy="31" r="8" className="brand-glyph-label" />
      <circle cx="32" cy="31" r="2.8" className="brand-glyph-dot" />
      <path className="brand-glyph-ring" d="M20.5 31c0-6.35 5.15-11.5 11.5-11.5" />
      <path className="brand-glyph-ring" d="M43.5 31c0 6.35-5.15 11.5-11.5 11.5" />
      <path className="brand-glyph-lock" d="M25 34.5h14v10.25c0 1.8-1.45 3.25-3.25 3.25h-7.5A3.25 3.25 0 0 1 25 44.75V34.5Z" />
      <path className="brand-glyph-shackle" d="M28.75 34.5v-2.15c0-2.45 1.55-4.15 3.25-4.15s3.25 1.7 3.25 4.15v2.15" />
      <path className="brand-glyph-keyhole" d="M32 39.1a1.85 1.85 0 0 1 1 3.4v2.35h-2V42.5a1.85 1.85 0 0 1 1-3.4Z" />
    </svg>
  );
}

function PreviewIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="action-svg">
      <path d="M8 5.75v12.5L18 12 8 5.75Z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="action-svg">
      <path d="M12 4.5v10" />
      <path d="m7.75 10.75 4.25 4.25 4.25-4.25" />
      <path d="M5.5 19.5h13" />
    </svg>
  );
}

function PlaylistAddIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="action-svg">
      <path d="M5 7h9" />
      <path d="M5 12h8" />
      <path d="M5 17h6" />
      <path d="M17 11.5v7" />
      <path d="M13.5 15h7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="lock-svg">
      <path d="M7.5 10.5V8.75a4.5 4.5 0 1 1 9 0v1.75" />
      <rect x="5.5" y="10.5" width="13" height="9" rx="2.75" ry="2.75" />
      <path d="M12 14.25v2.5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="quality-chevron">
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}

type PlayerIconName = "heart" | "more" | "next" | "pause" | "play" | "previous" | "queue" | "shuffle" | "volume";

function PlayerIcon({ name }: { name: PlayerIconName }) {
  const paths: Record<PlayerIconName, JSX.Element> = {
    heart: <path d="M12 20.2 5.4 13.9C2.1 10.8 4 5.4 8.4 5.4c1.5 0 2.8.7 3.6 1.8.8-1.1 2.1-1.8 3.6-1.8 4.4 0 6.3 5.4 3 8.5L12 20.2Z" />,
    more: (
      <>
        <path d="M6.5 12h.01" />
        <path d="M12 12h.01" />
        <path d="M17.5 12h.01" />
      </>
    ),
    next: (
      <>
        <path d="m7 6 8 6-8 6V6Z" />
        <path d="M17 6v12" />
      </>
    ),
    pause: (
      <>
        <path d="M8.5 6.5v11" />
        <path d="M15.5 6.5v11" />
      </>
    ),
    play: <path d="m8.5 6.5 9 5.5-9 5.5v-11Z" />,
    previous: (
      <>
        <path d="M7 6v12" />
        <path d="m17 6-8 6 8 6V6Z" />
      </>
    ),
    queue: (
      <>
        <path d="M5 7h10" />
        <path d="M5 12h14" />
        <path d="M5 17h8" />
      </>
    ),
    shuffle: (
      <>
        <path d="M16.5 6.5H19v2.5" />
        <path d="m5 18 5.2-5.2" />
        <path d="m13.8 8.2 2.7-1.7H19" />
        <path d="m5 6 14 12" />
      </>
    ),
    volume: (
      <>
        <path d="M5 10v4h3l4 3.2V6.8L8 10H5Z" />
        <path d="M16 9.2a4.2 4.2 0 0 1 0 5.6" />
        <path d="M18.4 7a7.5 7.5 0 0 1 0 10" />
      </>
    )
  };

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="player-svg">
      {paths[name]}
    </svg>
  );
}

function CoverArt({ song, className }: { song: Song | null; className: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const coverUrl = song?.coverUrl && song.coverUrl !== failedUrl ? song.coverUrl : null;

  return (
    <div className={className}>
      {coverUrl ? (
        <img src={coverUrl} alt={`${song?.title ?? "歌曲"} 封面`} loading="lazy" onError={() => setFailedUrl(coverUrl)} />
      ) : (
        <MusicGlyph />
      )}
    </div>
  );
}

function renderCommentContent(content: string) {
  return content.split(/(\[[^\[\]]{1,16}\])/g).map((part, index) => {
    const emoji = neteaseEmojiMap[part];
    if (!emoji) {
      return part;
    }

    return (
      <span key={`${part}-${index}`} className="netease-comment-emoji" title={part} aria-label={part.slice(1, -1)}>
        {emoji}
      </span>
    );
  });
}

export default function App() {
  const initialPlayerState = loadPlayerState();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lyricPanelRef = useRef<HTMLDivElement | null>(null);
  const resultBodyRef = useRef<HTMLDivElement | null>(null);
  const commentsScrollRef = useRef<HTMLDivElement | null>(null);
  const modalLyricPanelRef = useRef<HTMLDivElement | null>(null);
  const activeLyricRef = useRef<HTMLButtonElement | null>(null);
  const activeModalLyricRef = useRef<HTMLButtonElement | null>(null);
  const lyricManualScrollUntilRef = useRef(0);
  const pendingCommentScrollTopRef = useRef<number | null>(null);
  const lastAutoLyricIndexRef = useRef(-1);
  const lastModalAutoLyricIndexRef = useRef(-1);
  const restorePlaybackSecondsRef = useRef(initialPlayerState.playbackSeconds);
  const playbackSecondsRef = useRef(initialPlayerState.playbackSeconds);
  const searchRequestIdRef = useRef(0);
  const listRequestIdRef = useRef(0);
  const cookieHealthRef = useRef<{ cookie: string; checkedAt: number; result: NeteaseCookieCheckResult | null }>({
    cookie: "",
    checkedAt: 0,
    result: null
  });
  const playerStateSyncTimerRef = useRef<number | null>(null);
  const playerStateHydratedRef = useRef(false);
  const playlistSortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const qrCheckFailureCountRef = useRef(0);
  const qrAutoRefreshPendingRef = useRef(false);
  const qrAutoRefreshCountRef = useRef(0);
  const qrCloseTimerRef = useRef<number | null>(null);
  const transferRunJobIdRef = useRef("");
  const neteaseAuditJobIdRef = useRef("");
  const playlistCompareJobIdRef = useRef("");
  const userProfileCacheRef = useRef<Record<string, { profile: UserProfile; cachedAt: number }>>({});
  const playerThemeCacheRef = useRef<Record<string, PlayerTheme>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Song[]>([]);
  const [searchHistory, setSearchHistory] = useState<string[]>(loadSearchHistory);
  const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [adminConfig, setAdminConfig] = useState<AdminConfigView>(defaultAdminConfig);
  const [transferSourceProvider, setTransferSourceProvider] = useState<TransferSourceProvider>("netease");
  const [transferTargetProvider, setTransferTargetProvider] = useState<TransferTargetProvider>("qq");
  const [transferPlaylistId, setTransferPlaylistId] = useState("");
  const [transferPlaylistName, setTransferPlaylistName] = useState("歌单互转任务");
  const [transferTextInput, setTransferTextInput] = useState("");
  const [transferCheckAvailability, setTransferCheckAvailability] = useState(false);
  const [transferJob, setTransferJob] = useState<PlaylistTransferJob | null>(null);
  const [transferExportFormat, setTransferExportFormat] = useState<TransferExportFormat>("markdown");
  const [transferExportContent, setTransferExportContent] = useState("");
  const [transferImportName, setTransferImportName] = useState("转换后的歌单");
  const [transferImportResult, setTransferImportResult] = useState<NeteaseTransferImportResult | null>(null);
  const [transferRunJob, setTransferRunJob] = useState<PlaylistTransferRunJob | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferExporting, setTransferExporting] = useState(false);
  const [transferImporting, setTransferImporting] = useState(false);
  const [neteaseAuditPlaylistId, setNeteaseAuditPlaylistId] = useState("");
  const [neteaseAuditMaxTracks, setNeteaseAuditMaxTracks] = useState(300);
  const [neteaseAuditCandidateLimit, setNeteaseAuditCandidateLimit] = useState(5);
  const [neteaseAuditCheckAvailability, setNeteaseAuditCheckAvailability] = useState(false);
  const [neteaseImportAudit, setNeteaseImportAudit] = useState<NeteaseImportAudit | null>(null);
  const [neteaseImportAuditJob, setNeteaseImportAuditJob] = useState<NeteaseImportAuditJob | null>(null);
  const [neteaseAuditLoading, setNeteaseAuditLoading] = useState(false);
  const [neteaseAuditExportFormat, setNeteaseAuditExportFormat] = useState<TransferExportFormat>("text");
  const [neteaseAuditExportContent, setNeteaseAuditExportContent] = useState("");
  const [neteaseAuditExporting, setNeteaseAuditExporting] = useState(false);
  const [neteaseAuditPlayablePlaylistName, setNeteaseAuditPlayablePlaylistName] = useState("");
  const [neteaseAuditPlayableImporting, setNeteaseAuditPlayableImporting] = useState(false);
  const [neteaseAuditPlayableImportResult, setNeteaseAuditPlayableImportResult] = useState<NeteaseTransferImportResult | null>(null);
  const [compareLeftProvider, setCompareLeftProvider] = useState<"netease" | "qq">("netease");
  const [compareRightProvider, setCompareRightProvider] = useState<"netease" | "qq">("netease");
  const [compareLeftPlaylistId, setCompareLeftPlaylistId] = useState("");
  const [compareRightPlaylistId, setCompareRightPlaylistId] = useState("");
  const [playlistCompareResult, setPlaylistCompareResult] = useState<PlaylistCompareResult | null>(null);
  const [playlistCompareJob, setPlaylistCompareJob] = useState<PlaylistCompareJob | null>(null);
  const [playlistCompareLoading, setPlaylistCompareLoading] = useState(false);
  const [playlistCompareExporting, setPlaylistCompareExporting] = useState(false);
  const [playlistCompareExportFormat, setPlaylistCompareExportFormat] = useState<TransferExportFormat>("text");
  const [playlistCompareExportStatuses, setPlaylistCompareExportStatuses] = useState<PlaylistCompareStatus[]>(["same_title_different_artist", "similar_title", "left_only", "right_only"]);
  const [playlistCompareExportContent, setPlaylistCompareExportContent] = useState("");
  const [adminConfigTokenInput, setAdminConfigTokenInput] = useState("");
  const [session, setSession] = useState<AuthSession>({ loggedIn: false, profile: null });
  const [searching, setSearching] = useState(false);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [loadingPlaylistSongs, setLoadingPlaylistSongs] = useState(false);
  const [loadingArtist, setLoadingArtist] = useState(false);
  const [loadingCloudSongs, setLoadingCloudSongs] = useState(false);
  const [loadingDailySongs, setLoadingDailySongs] = useState(false);
  const [loadingDiscoverSongs, setLoadingDiscoverSongs] = useState(false);
  const [removingPlaylistSongs, setRemovingPlaylistSongs] = useState(false);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(null);
  const [activePlaylist, setActivePlaylist] = useState<UserPlaylist | null>(null);
  const [activeArtist, setActiveArtist] = useState<ArtistProfile | null>(null);
  const [activeAlbum, setActiveAlbum] = useState<AlbumProfile | null>(null);
  const [playlistSongsPage, setPlaylistSongsPage] = useState(1);
  const [playlistSongsLimit, setPlaylistSongsLimit] = useState(PLAYLIST_SONGS_PAGE_SIZE);
  const [playlistSongsHasMore, setPlaylistSongsHasMore] = useState(false);
  const [playlistSongsTotal, setPlaylistSongsTotal] = useState(0);
  const [playlistSearchInput, setPlaylistSearchInput] = useState("");
  const [playlistSearchKeyword, setPlaylistSearchKeyword] = useState("");
  const [playlistSortMode, setPlaylistSortMode] = useState<PlaylistSortMode>("default");
  const [cloudMeta, setCloudMeta] = useState({ count: 0, size: 0, maxSize: 0 });
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingAdminConfig, setSavingAdminConfig] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [directDownloadingSongId, setDirectDownloadingSongId] = useState<string | null>(null);
  const [savingTaskFileId, setSavingTaskFileId] = useState<string | null>(null);
  const [batchSelectionMode, setBatchSelectionMode] = useState(false);
  const [selectedSongIds, setSelectedSongIds] = useState<string[]>([]);
  const [qualitySelections, setQualitySelections] = useState<Record<string, DownloadQualityLevel>>({});
  const [qualitySelectionTouched, setQualitySelectionTouched] = useState<Record<string, true>>({});
  const [openQualityMenuId, setOpenQualityMenuId] = useState<string | null>(null);
  const [openPlaylistSortMenu, setOpenPlaylistSortMenu] = useState(false);
  const [playlistSortMenuStyle, setPlaylistSortMenuStyle] = useState<FloatingMenuStyle | null>(null);
  const [openSettingsQualityMenu, setOpenSettingsQualityMenu] = useState<"playback" | "download" | null>(null);
  const [mainTab, setMainTab] = useState<MainTab>("search");
  const [navKey, setNavKey] = useState<NavKey>("discover");
  const [viewHistory, setViewHistory] = useState<ViewState[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Song | null>(initialPlayerState.currentTrack);
  const [playerTheme, setPlayerTheme] = useState<PlayerTheme>(defaultPlayerTheme);
  const [playQueue, setPlayQueue] = useState<Song[]>(initialPlayerState.playQueue);
  const [playHistory, setPlayHistory] = useState<Song[]>(loadPlayHistory);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("queue");
  const [isPlayerExpanded, setIsPlayerExpanded] = useState(false);
  const [resultSource, setResultSource] = useState<ResultSource>("search");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [qrLoginOpen, setQrLoginOpen] = useState(false);
  const [neteaseLoginMode, setNeteaseLoginMode] = useState<NeteaseLoginMode>("qr");
  const [qrLoginKey, setQrLoginKey] = useState("");
  const [qrLoginImage, setQrLoginImage] = useState("");
  const [qrLoginMessage, setQrLoginMessage] = useState("打开网易云音乐 App 扫码登录。");
  const [qrLoginExpiresIn, setQrLoginExpiresIn] = useState(0);
  const [startingQrLogin, setStartingQrLogin] = useState(false);
  const [sendingCaptcha, setSendingCaptcha] = useState(false);
  const [loggingCellphoneIn, setLoggingCellphoneIn] = useState(false);
  const [cellphoneLoginForm, setCellphoneLoginForm] = useState({
    countryCode: "86",
    phone: "",
    captcha: ""
  });
  const [cookieLoginInput, setCookieLoginInput] = useState("");
  const [importingCookie, setImportingCookie] = useState(false);
  const [copyingCookieGuide, setCopyingCookieGuide] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSeconds, setPlaybackSeconds] = useState(initialPlayerState.playbackSeconds);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [bufferedSeconds, setBufferedSeconds] = useState(0);
  const [playbackMode, setPlaybackMode] = useState<"sequential" | "shuffle">(initialPlayerState.playbackMode === "shuffle" ? "shuffle" : "sequential");
  const [lyrics, setLyrics] = useState<LyricLine[]>([]);
  const [loadingLyrics, setLoadingLyrics] = useState(false);
  const [lyricsError, setLyricsError] = useState("");
  const [commentTrack, setCommentTrack] = useState<Song | null>(initialPlayerState.currentTrack);
  const [songComments, setSongComments] = useState<SongCommentsPage | null>(null);
  const [commentPage, setCommentPage] = useState(1);
  const [commentRefreshKey, setCommentRefreshKey] = useState(0);
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsError, setCommentsError] = useState("");
  const [commentRepliesById, setCommentRepliesById] = useState<Record<string, SongCommentRepliesPage>>({});
  const [expandedCommentIds, setExpandedCommentIds] = useState<string[]>([]);
  const [loadingCommentReplyIds, setLoadingCommentReplyIds] = useState<string[]>([]);
  const [commentLikeActionIds, setCommentLikeActionIds] = useState<string[]>([]);
  const [replyingCommentId, setReplyingCommentId] = useState<string | null>(null);
  const [commentReplyDrafts, setCommentReplyDrafts] = useState<Record<string, string>>({});
  const [postingCommentId, setPostingCommentId] = useState<string | null>(null);
  const [commentActionError, setCommentActionError] = useState("");
  const [userProfileTarget, setUserProfileTarget] = useState<UserProfileTarget | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loadingUserProfile, setLoadingUserProfile] = useState(false);
  const [userProfileError, setUserProfileError] = useState("");
  const [userProfileView, setUserProfileView] = useState<UserProfileView>("profile");
  const [userSocialKind, setUserSocialKind] = useState<UserSocialListKind | null>(null);
  const [userSocialPage, setUserSocialPage] = useState<UserSocialPage | null>(null);
  const [loadingUserSocial, setLoadingUserSocial] = useState(false);
  const [userSocialError, setUserSocialError] = useState("");
  const [userSocialActionIds, setUserSocialActionIds] = useState<string[]>([]);
  const [userEventsPage, setUserEventsPage] = useState<UserEventsPage | null>(null);
  const [loadingUserEvents, setLoadingUserEvents] = useState(false);
  const [userEventsError, setUserEventsError] = useState("");
  const [volume, setVolume] = useState(initialPlayerState.volume);
  const [playerError, setPlayerError] = useState("");
  const [likedSongIds, setLikedSongIds] = useState<string[]>([]);
  const [togglingLike, setTogglingLike] = useState(false);
  const [playlistPickerSong, setPlaylistPickerSong] = useState<Song | null>(null);
  const [playlistPickerSongs, setPlaylistPickerSongs] = useState<Song[]>([]);
  const [playlistPickerSourcePlaylistId, setPlaylistPickerSourcePlaylistId] = useState<string | null>(null);
  const [songContextMenu, setSongContextMenu] = useState<SongContextMenuState | null>(null);
  const [playlistPickerLoading, setPlaylistPickerLoading] = useState(false);
  const [playlistPickerError, setPlaylistPickerError] = useState("");
  const [addingToPlaylistId, setAddingToPlaylistId] = useState<string | null>(null);
  const [loginForm, setLoginForm] = useState({
    accountName: "我的本地账号",
    vipEnabled: true,
    note: "演示账号资料"
  });
  const [message, setMessage] = useState("正在加载发现音乐。");
  const [downloadIssue, setDownloadIssue] = useState<DownloadIssueDialog | null>(null);
  const [playerStateReady, setPlayerStateReady] = useState(false);
  const accountProfile = session.profile;
  const accountDisplayName = accountProfile?.displayName ?? settings.accountName;
  const accountAvatarUrl = accountProfile?.avatarUrl;
  const accountVipEnabled = accountProfile?.vipEnabled ?? settings.vipEnabled;
  const accountProviderLabel = accountProfile?.provider === "netease" ? "网易云已同步" : session.loggedIn ? "本地登录中" : "未登录";
  const accountBadgeLabel = accountVipEnabled ? "黑胶 VIP" : "标准";
  const accountStatusLabel = session.loggedIn || accountProfile?.provider === "netease" ? accountBadgeLabel : "未登录";
  const accountIsLoggedIn = session.loggedIn || accountProfile?.provider === "netease";
  const hasNeteaseDownloadAuth = accountIsLoggedIn;
  const playbackLocked = !accountIsLoggedIn;
  const hasPlaybackQueue = playQueue.length > 0 || results.length > 0;

  function getSelectedLevel(song: Song) {
    return qualitySelections[song.id] ?? getPreferredPlaybackQuality(song);
  }

  function getSelectedLabel(song: Song) {
    const selectedLevel = getSelectedLevel(song);
    return song.availableQualities.find((quality) => quality.level === selectedLevel)?.label ?? "128K";
  }

  function getPreferredPlaybackQuality(song: Song) {
    return getPreferredQualityForLevel(song, settings.defaultPlaybackQuality);
  }

  function getPreferredDownloadQuality(song: Song) {
    return getPreferredQualityForLevel(song, settings.defaultDownloadQuality);
  }

  function getDownloadLevel(song: Song) {
    return qualitySelectionTouched[song.id] ? getSelectedLevel(song) : getPreferredDownloadQuality(song);
  }

  function getDownloadLevelLabel(song: Song, level: DownloadQualityLevel) {
    return song.availableQualities.find((quality) => quality.level === level)?.label ?? (
      level === "exhigh"
        ? "320K"
        : level === "lossless"
          ? "FLAC"
          : level === "hires"
            ? "Hi-Res"
            : "128K"
    );
  }

  function getPreferredQualityForLevel(song: Song, level: DownloadQualityLevel) {
    return song.availableQualities.find((quality) => quality.level === level)?.level ?? song.availableQualities.at(-1)?.level ?? "standard";
  }

  function createQualitySelectionMap(songs: Song[], level = settings.defaultPlaybackQuality) {
    return Object.fromEntries(songs.map((song) => [song.id, getPreferredQualityForLevel(song, level)]));
  }

  function applyQualityDefaults(songs: Song[], level = settings.defaultPlaybackQuality) {
    setQualitySelections(createQualitySelectionMap(songs, level));
    setQualitySelectionTouched({});
    setSelectedSongIds([]);
  }

  function addToPlayHistory(song: Song) {
    setPlayHistory((current) => {
      const nextHistory = [song, ...current.filter((item) => item.id !== song.id)].slice(0, 30);
      window.localStorage.setItem(PLAY_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
      void savePlayHistory(nextHistory);
      return nextHistory;
    });
  }

  function navigateTo(nextNavKey: NavKey, nextMainTab: MainTab = "search") {
    if (nextNavKey === navKey && nextMainTab === mainTab) {
      return;
    }

    const resultScrollTop = resultBodyRef.current?.scrollTop ?? 0;
    const currentView = {
      mainTab,
      navKey,
      snapshot: {
        results,
        playQueue,
        resultSource,
        activePlaylist,
        activeArtist,
        activeAlbum,
        selectedPlaylistId,
        playlistSongsPage,
        playlistSongsLimit,
        playlistSongsHasMore,
        playlistSongsTotal,
        playlistSearchInput,
        playlistSearchKeyword,
        cloudMeta,
        qualitySelections,
        qualitySelectionTouched,
        resultScrollTop
      }
    };
    setViewHistory((current) => [currentView, ...current.filter((item) => item.mainTab !== currentView.mainTab || item.navKey !== currentView.navKey)].slice(0, 20));
    setMainTab(nextMainTab);
    setNavKey(nextNavKey);
    setBatchSelectionMode(false);
    setSelectedSongIds([]);
    window.requestAnimationFrame(() => {
      if (resultBodyRef.current) {
        resultBodyRef.current.scrollTop = 0;
      }
    });
  }

  function goBackView() {
    const previousView = viewHistory[0];
    if (!previousView) {
      return;
    }

    setViewHistory((current) => current.slice(1));
    setMainTab(previousView.mainTab);
    setNavKey(previousView.navKey);
    setResults(previousView.snapshot.results);
    setPlayQueue(previousView.snapshot.playQueue);
    setResultSource(previousView.snapshot.resultSource);
    setActivePlaylist(previousView.snapshot.activePlaylist);
    setActiveArtist(previousView.snapshot.activeArtist);
    setActiveAlbum(previousView.snapshot.activeAlbum);
    setSelectedPlaylistId(previousView.snapshot.selectedPlaylistId);
    setPlaylistSongsPage(previousView.snapshot.playlistSongsPage);
    setPlaylistSongsLimit(previousView.snapshot.playlistSongsLimit);
    setPlaylistSongsHasMore(previousView.snapshot.playlistSongsHasMore);
    setPlaylistSongsTotal(previousView.snapshot.playlistSongsTotal);
    setPlaylistSearchInput(previousView.snapshot.playlistSearchInput);
    setPlaylistSearchKeyword(previousView.snapshot.playlistSearchKeyword);
    setCloudMeta(previousView.snapshot.cloudMeta);
    setQualitySelections(previousView.snapshot.qualitySelections);
    setQualitySelectionTouched(previousView.snapshot.qualitySelectionTouched);
    window.requestAnimationFrame(() => {
      if (resultBodyRef.current) {
        resultBodyRef.current.scrollTop = previousView.snapshot.resultScrollTop;
      }
    });
  }

  function openSearchPage() {
    setQuery("");
    setResults([]);
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setResultSource("search");
    navigateTo("search");
    setMessage("输入关键词开始搜索。");
  }

  function openPlaylistsPage() {
    setResults([]);
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setSelectedPlaylistId(null);
    setResultSource("search");
    setPlaylistSearchInput("");
    setPlaylistSearchKeyword("");
    setPlaylistSongsPage(1);
    setPlaylistSongsHasMore(false);
    setPlaylistSongsTotal(0);
    setSelectedSongIds([]);
    navigateTo("playlists");

    if (playlists.length === 0 && !loadingPlaylists && settings.neteaseCookie.trim()) {
      void loadUserPlaylists();
    }
  }

  function addSearchHistory(keyword: string) {
    setSearchHistory((current) => {
      const nextHistory = [keyword, ...current.filter((item) => item !== keyword)].slice(0, 10);
      window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
      void saveSearchHistory(nextHistory);
      return nextHistory;
    });
  }

  function removeSearchHistory(keyword: string) {
    setSearchHistory((current) => {
      const nextHistory = current.filter((item) => item !== keyword);
      window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(nextHistory));
      void removeSearchHistoryRemote(keyword).catch(() => {
        void saveSearchHistory(nextHistory);
      });
      return nextHistory;
    });
  }

  function getSongArtists(song: Song): SongArtist[] {
    if (Array.isArray(song.artists) && song.artists.length > 0) {
      return song.artists
        .map((artist) => ({
          id: artist.id?.trim() || undefined,
          name: artist.name.trim()
        }))
        .filter((artist) => artist.name);
    }

    return song.artist
      .split("/")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name, index) => ({
        id: index === 0 ? song.primaryArtistId?.trim() || undefined : undefined,
        name
      }));
  }

  async function runSearch(nextQuery: string) {
    const trimmed = nextQuery.trim();
    if (!trimmed) {
      setResults([]);
      return;
    }

    navigateTo("search");
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setResultSource("search");
    setResults([]);
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setSearching(true);
    setMessage(`正在搜索 “${trimmed}”`);

    try {
      const data = await searchSongs(trimmed);
      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      addSearchHistory(trimmed);
      setResults(data);
      setPlayQueue(data);
      setResultSource("search");
      applyQualityDefaults(data);
      setCurrentTrack((current) => current ?? data[0] ?? null);
      setMessage(`共找到 ${data.length} 首歌曲`);
    } catch (error) {
      if (requestId !== searchRequestIdRef.current) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "搜索失败");
    } finally {
      if (requestId === searchRequestIdRef.current) {
        setSearching(false);
      }
    }
  }

  async function loadDiscoverSongs(options: { keepExisting?: boolean } = {}) {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    const shouldKeepCurrentResults =
      options.keepExisting || (mainTab === "search" && navKey === "discover" && resultSource === "discover");
    navigateTo("discover");
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setResultSource("discover");
    if (!shouldKeepCurrentResults) {
      setResults([]);
    }
    setLoadingDiscoverSongs(true);
    setMessage("正在加载发现音乐");

    try {
      const songs = await getDiscoverSongs();
      if (requestId !== listRequestIdRef.current) {
        return;
      }

      setResults(songs);
      setPlayQueue(songs);
      setResultSource("discover");
      applyQualityDefaults(songs);
      saveCachedDiscoverSongs(songs);
      setMessage(`发现音乐 · 共 ${songs.length} 首推荐新歌`);
    } catch (error) {
      if (requestId !== listRequestIdRef.current) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "获取发现音乐失败");
    } finally {
      setLoadingDiscoverSongs(false);
    }
  }

  async function refreshTasks() {
    try {
      setTasks(await getTasks());
    } catch {
      // Keep current queue if refresh fails.
    }
  }

  async function loadUserPlaylists() {
    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      setPlaylists([]);
      return;
    }

    setLoadingPlaylists(true);
    setMessage("正在读取网易云歌单");

    try {
      const data = await getPlaylists();
      setPlaylists(data);
      setMessage(`共读取 ${data.length} 个歌单`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "获取歌单失败");
    } finally {
      setLoadingPlaylists(false);
    }
  }

  async function loadPlaylistSongs(playlist: UserPlaylist, page = 1, keywordOverride = playlistSearchKeyword, sortOverride = playlistSortMode) {
    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    const normalizedKeyword = keywordOverride.trim();
    setLoadingPlaylistSongs(true);
    setActivePlaylist(playlist);
    setActiveArtist(null);
    setActiveAlbum(null);
    setSelectedPlaylistId(playlist.id);
    setMessage(
      normalizedKeyword
        ? `正在筛选歌单：${playlist.name} · “${normalizedKeyword}” · 第 ${page} 页`
        : `正在读取歌单：${playlist.name} · 第 ${page} 页`
    );

    try {
      const pageData = await getPlaylistSongs(playlist.id, page, PLAYLIST_SONGS_PAGE_SIZE, normalizedKeyword, sortOverride);
      setResults(pageData.songs);
      setPlayQueue(pageData.songs);
      setResultSource("playlist");
      applyQualityDefaults(pageData.songs);
      setPlaylistSongsPage(pageData.page);
      setPlaylistSongsLimit(pageData.limit);
      setPlaylistSongsHasMore(pageData.hasMore);
      setPlaylistSongsTotal(pageData.total);
      setPlaylistSearchKeyword(pageData.keyword ?? normalizedKeyword);
      setPlaylistSearchInput(pageData.keyword ?? normalizedKeyword);
      navigateTo("playlists");
      const totalPages = Math.max(1, Math.ceil((pageData.total || playlist.trackCount) / pageData.limit));
      setMessage(
        pageData.keyword
          ? `${playlist.name} · 筛选 “${pageData.keyword}” · 第 ${pageData.page} / ${totalPages} 页 · 当前 ${pageData.songs.length} 首 / 匹配 ${pageData.total} 首`
          : `${playlist.name} · 第 ${pageData.page} / ${Math.max(1, Math.ceil(playlist.trackCount / pageData.limit))} 页 · 当前 ${pageData.songs.length} 首 / 共 ${playlist.trackCount} 首`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "获取歌单歌曲失败");
    } finally {
      setLoadingPlaylistSongs(false);
    }
  }

  function openTransferPage() {
    navigateTo("transfer");
    if (playlists.length === 0 && !loadingPlaylists && settings.neteaseCookie.trim()) {
      void loadUserPlaylists();
    }
  }

  async function pollPlaylistTransferRunJob(jobId: string) {
    while (transferRunJobIdRef.current === jobId) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (transferRunJobIdRef.current !== jobId) {
        return;
      }

      try {
        const job = await getPlaylistTransferRunJob(jobId);
        if (transferRunJobIdRef.current !== jobId) {
          return;
        }

        setTransferRunJob(job);
        if (job.status === "completed" && job.result) {
          setTransferJob(job.result);
          setTransferImportName(`${job.result.playlistName} 转换结果`);
          setTransferImportResult(null);
          setTransferLoading(false);
          setMessage(`歌单互转完成：${job.result.summary.matched} 首匹配，${job.result.summary.manualReview} 首待确认，${job.result.summary.notFound} 首未找到。`);
          return;
        }

        if (job.status === "failed") {
          setTransferLoading(false);
          setMessage(job.error ?? "创建歌单互转任务失败");
          return;
        }
      } catch (error) {
        setTransferLoading(false);
        setMessage(error instanceof Error ? error.message : "获取歌单互转进度失败");
        return;
      }
    }
  }

  async function handleCreateTransferJob() {
    const sourceProvider = transferSourceProvider;
    const targetProvider = transferTargetProvider;
    const selectedPlaylist = playlists.find((playlist) => playlist.id === transferPlaylistId);
    const playlistId = sourceProvider === "netease" ? selectedPlaylist?.id : transferPlaylistId.trim();
    const playlistName =
      sourceProvider === "netease"
        ? selectedPlaylist?.name || transferPlaylistName.trim()
        : transferPlaylistName.trim() || (sourceProvider === "qq" ? `QQ 歌单 ${playlistId}` : "文字歌单");

    if ((sourceProvider === "netease" || sourceProvider === "qq") && !playlistId) {
      setMessage(sourceProvider === "netease" ? "请先选择一个网易云歌单。" : "请输入 QQ 音乐公开歌单 ID。");
      return;
    }

    if ((sourceProvider === "text" || sourceProvider === "csv") && !transferTextInput.trim()) {
      setMessage("请先粘贴文字歌单或 CSV 内容。");
      return;
    }

    setTransferLoading(true);
    setTransferJob(null);
    setTransferRunJob(null);
    setTransferExportContent("");
    setMessage("正在创建歌单互转任务");

    try {
      const job = await startPlaylistTransferRunJob({
        sourceProvider,
        targetProvider,
        playlistId,
        playlistName,
        text: transferTextInput,
        checkAvailability: transferCheckAvailability
      });
      transferRunJobIdRef.current = job.id;
      setTransferRunJob(job);
      setTransferImportResult(null);
      setMessage(`已提交歌单互转任务：${playlistName}`);
      void pollPlaylistTransferRunJob(job.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建歌单互转任务失败");
      setTransferLoading(false);
    }
  }

  async function handleExportTransferJob() {
    if (!transferJob) {
      return;
    }

    setTransferExporting(true);
    setMessage("正在导出歌单互转报告");

    try {
      const exported = await exportPlaylistTransferJob(transferJob.id, transferExportFormat);
      setTransferExportContent(exported.content);
      setMessage(`已生成导出内容：${exported.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出歌单互转报告失败");
    } finally {
      setTransferExporting(false);
    }
  }

  async function handleImportTransferToNetease() {
    if (!transferJob) {
      return;
    }

    setTransferImporting(true);
    setMessage("正在创建网易云目标歌单");

    try {
      const result = await importPlaylistTransferToNetease(transferJob.id, transferImportName.trim() || `${transferJob.playlistName} 转换结果`);
      setTransferImportResult(result);
      setMessage(`已创建网易云歌单，导入 ${result.addedCount} 首，跳过 ${result.skippedCount} 首。`);
      void loadUserPlaylists();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入网易云歌单失败");
    } finally {
      setTransferImporting(false);
    }
  }

  function downloadExportedContent(exported: TransferExportResult) {
    const blob = new Blob([exported.content], { type: exported.contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exported.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function pollNeteaseImportAuditJob(jobId: string) {
    while (neteaseAuditJobIdRef.current === jobId) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (neteaseAuditJobIdRef.current !== jobId) {
        return;
      }

      try {
        const job = await getNeteaseImportAuditJob(jobId);
        if (neteaseAuditJobIdRef.current !== jobId) {
          return;
        }

        setNeteaseImportAuditJob(job);
        if (job.status === "completed" && job.result) {
          setNeteaseImportAudit(job.result);
          setNeteaseAuditPlayablePlaylistName(`${job.result.playlistName} - 正常歌曲`);
          setNeteaseAuditLoading(false);
          setMessage(`清理完成：正常 ${job.result.summary.playable} 首；识别 ${job.result.summary.suspect} 首不可用，可整理 ${job.result.summary.replaceable} 首，暂无替代 ${job.result.summary.unusable} 首。`);
          return;
        }

        if (job.status === "failed") {
          setNeteaseAuditLoading(false);
          setMessage(job.error ?? "网易云导入歌单清理失败");
          return;
        }

        if (job.status === "cancelled") {
          setNeteaseAuditLoading(false);
          setMessage("网易云导入歌单清理已取消。");
          return;
        }
      } catch (error) {
        setNeteaseAuditLoading(false);
        setMessage(error instanceof Error ? error.message : "获取网易云导入歌单清理进度失败");
        return;
      }
    }
  }

  async function handleCreateNeteaseImportAudit() {
    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    const selectedPlaylist = playlists.find((playlist) => playlist.id === neteaseAuditPlaylistId);
    if (!selectedPlaylist) {
      setMessage("请先选择要清理的网易云歌单。");
      return;
    }

    setNeteaseAuditLoading(true);
    setNeteaseImportAudit(null);
    setNeteaseImportAuditJob(null);
    setNeteaseAuditExportContent("");
    setNeteaseAuditPlayablePlaylistName(`${selectedPlaylist.name} - 正常歌曲`);
    setNeteaseAuditPlayableImportResult(null);
    setMessage(`已提交扫描任务：${selectedPlaylist.name}`);

    try {
      const job = await startNeteaseImportAuditJob({
        playlistId: selectedPlaylist.id,
        playlistName: selectedPlaylist.name,
        maxTracks: neteaseAuditMaxTracks,
        candidateLimit: neteaseAuditCandidateLimit,
        checkAvailability: neteaseAuditCheckAvailability
      });
      neteaseAuditJobIdRef.current = job.id;
      setNeteaseImportAuditJob(job);
      void pollNeteaseImportAuditJob(job.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "网易云导入歌单清理失败");
      setNeteaseAuditLoading(false);
    }
  }

  async function handleCancelNeteaseImportAudit() {
    if (!neteaseImportAuditJob) {
      return;
    }

    try {
      const job = await cancelNeteaseImportAuditJob(neteaseImportAuditJob.id);
      setNeteaseImportAuditJob(job);
      setMessage("已请求取消网易云导入歌单清理任务。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "取消网易云导入歌单清理失败");
    }
  }

  async function handleExportNeteaseImportAudit() {
    if (!neteaseImportAuditJob || neteaseImportAuditJob.status !== "completed") {
      return;
    }

    setNeteaseAuditExporting(true);
    setMessage("正在生成网易云导入歌单清理结果文件");

    try {
      const exported = await exportNeteaseImportAuditJob(neteaseImportAuditJob.id, neteaseAuditExportFormat);
      setNeteaseAuditExportContent(exported.content);
      downloadExportedContent(exported);
      setMessage(`已生成并下载：${exported.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出网易云导入歌单清理结果失败");
    } finally {
      setNeteaseAuditExporting(false);
    }
  }

  async function handleCreateNeteaseAuditPlayablePlaylist() {
    if (!neteaseImportAuditJob || neteaseImportAuditJob.status !== "completed" || !neteaseImportAudit) {
      return;
    }

    setNeteaseAuditPlayableImporting(true);
    setMessage("正在创建正常歌曲新歌单");

    try {
      const result = await createNeteaseImportAuditPlayablePlaylist(
        neteaseImportAuditJob.id,
        neteaseAuditPlayablePlaylistName.trim() || `${neteaseImportAudit.playlistName} - 正常歌曲`
      );
      setNeteaseAuditPlayableImportResult(result);
      setMessage(`已创建正常歌曲新歌单，导入 ${result.addedCount} 首，跳过 ${result.skippedCount} 首。`);
      void loadUserPlaylists();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建正常歌曲新歌单失败");
    } finally {
      setNeteaseAuditPlayableImporting(false);
    }
  }

  function togglePlaylistCompareExportStatus(status: PlaylistCompareStatus) {
    setPlaylistCompareExportStatuses((current) => {
      if (current.includes(status)) {
        return current.filter((item) => item !== status);
      }

      return [...current, status];
    });
  }

  async function pollPlaylistCompareJob(jobId: string) {
    while (playlistCompareJobIdRef.current === jobId) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (playlistCompareJobIdRef.current !== jobId) {
        return;
      }

      try {
        const job = await getPlaylistCompareJob(jobId);
        if (playlistCompareJobIdRef.current !== jobId) {
          return;
        }

        setPlaylistCompareJob(job);
        if (job.status === "completed" && job.result) {
          setPlaylistCompareResult(job.result);
          setPlaylistCompareLoading(false);
          setMessage(
            `对比完成：完全一样 ${job.result.summary.exact} 首，歌名同但歌手不同 ${job.result.summary.sameTitleDifferentArtist} 首，歌名相似 ${job.result.summary.similarTitle} 首。`
          );
          return;
        }

        if (job.status === "failed") {
          setPlaylistCompareLoading(false);
          setMessage(job.error ?? "歌单对比失败");
          return;
        }
      } catch (error) {
        setPlaylistCompareLoading(false);
        setMessage(error instanceof Error ? error.message : "获取歌单对比进度失败");
        return;
      }
    }
  }

  async function handleCreatePlaylistCompare() {
    if (compareLeftProvider === "netease" || compareRightProvider === "netease") {
      const cookieOk = await ensureNeteaseCookieHealthy();
      if (!cookieOk) {
        return;
      }
    }

    const leftPlaylist = playlists.find((playlist) => playlist.id === compareLeftPlaylistId);
    const rightPlaylist = playlists.find((playlist) => playlist.id === compareRightPlaylistId);
    const leftPlaylistId = compareLeftProvider === "netease" ? leftPlaylist?.id ?? "" : compareLeftPlaylistId.trim();
    const rightPlaylistId = compareRightProvider === "netease" ? rightPlaylist?.id ?? "" : compareRightPlaylistId.trim();
    const leftPlaylistName = compareLeftProvider === "netease" ? leftPlaylist?.name : `QQ 歌单 ${leftPlaylistId}`;
    const rightPlaylistName = compareRightProvider === "netease" ? rightPlaylist?.name : `QQ 歌单 ${rightPlaylistId}`;

    if (!leftPlaylistId || !rightPlaylistId) {
      setMessage("请先填写或选择左右两个歌单。");
      return;
    }

    setPlaylistCompareLoading(true);
    setPlaylistCompareResult(null);
    setPlaylistCompareJob(null);
    setPlaylistCompareExportContent("");
    setMessage("正在对比两个歌单");

    try {
      const job = await startPlaylistCompareJob({
        leftProvider: compareLeftProvider,
        leftPlaylistId,
        leftPlaylistName,
        rightProvider: compareRightProvider,
        rightPlaylistId,
        rightPlaylistName
      });
      playlistCompareJobIdRef.current = job.id;
      setPlaylistCompareJob(job);
      setMessage(`已提交歌单对比任务：${leftPlaylistName} / ${rightPlaylistName}`);
      void pollPlaylistCompareJob(job.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "歌单对比失败");
      setPlaylistCompareLoading(false);
    }
  }

  async function handleExportPlaylistCompare() {
    if (!playlistCompareResult) {
      return;
    }

    if (playlistCompareExportStatuses.length === 0) {
      setMessage("请至少选择一个要导出的分类。");
      return;
    }

    setPlaylistCompareExporting(true);
    setMessage("正在导出歌单对比结果");

    try {
      const exported = await exportPlaylistCompare({
        result: playlistCompareResult,
        format: playlistCompareExportFormat,
        statuses: playlistCompareExportStatuses
      });
      setPlaylistCompareExportContent(exported.content);
      setMessage(`已生成导出内容：${exported.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出歌单对比结果失败");
    } finally {
      setPlaylistCompareExporting(false);
    }
  }

  async function loadArtistPage(artistId: string, fallbackName?: string) {
    const trimmedArtistId = artistId.trim();
    if (!trimmedArtistId) {
      setMessage("当前歌曲没有可跳转的歌手信息。");
      return;
    }

    setLoadingArtist(true);
    setActiveArtist(null);
    setActivePlaylist(null);
    setActiveAlbum(null);
    setSelectedPlaylistId(null);
    setResults([]);
    setPlayQueue([]);
    setResultSource("artist");
    navigateTo("artist");
    setMessage(`正在读取歌手：${fallbackName ?? "歌手详情"}`);

    try {
      const artist = await getArtistProfile(trimmedArtistId);
      setActiveArtist(artist);
      setResults(artist.topSongs);
      setPlayQueue(artist.topSongs);
      setResultSource("artist");
      applyQualityDefaults(artist.topSongs);
      navigateTo("artist");
      setMessage(`${artist.name} · 热门歌曲 ${artist.topSongs.length} 首`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "获取歌手信息失败");
    } finally {
      setLoadingArtist(false);
    }
  }

  async function handleOpenArtist(song: Song, artistTarget?: SongArtist) {
    try {
      const targetName = artistTarget?.name?.trim() || getSongArtists(song)[0]?.name || song.artist;
      const targetId = artistTarget?.id?.trim() || song.primaryArtistId?.trim();
      setMessage(`正在读取歌手：${targetName}`);
      if (targetId) {
        await loadArtistPage(targetId, targetName);
        return;
      }

      const resolvedArtist = await resolveArtistByName(targetName);
      await loadArtistPage(resolvedArtist.id, resolvedArtist.name);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "获取歌手信息失败");
    }
  }

  async function loadAlbumPage(albumId: string, fallbackName?: string) {
    const trimmedAlbumId = albumId.trim();
    if (!trimmedAlbumId) {
      setMessage("当前歌曲没有可跳转的专辑信息。");
      return;
    }

    setActiveAlbum(null);
    setActiveArtist(null);
    setActivePlaylist(null);
    setSelectedPlaylistId(null);
    setResults([]);
    setPlayQueue([]);
    setResultSource("album");
    navigateTo("album");
    setMessage(`正在读取专辑：${fallbackName ?? "专辑详情"}`);

    try {
      const album = await getAlbumProfile(trimmedAlbumId);
      setActiveAlbum(album);
      setResults(album.songs);
      setPlayQueue(album.songs);
      setResultSource("album");
      applyQualityDefaults(album.songs);
      navigateTo("album");
      setMessage(`${album.name} · 共 ${album.songs.length} 首歌曲`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "获取专辑信息失败");
    }
  }

  async function handleOpenAlbum(song: Song) {
    if (!song.albumId?.trim()) {
      setMessage("当前歌曲没有可跳转的专辑信息。");
      return;
    }

    await loadAlbumPage(song.albumId, song.album);
  }

  async function loadCloudSongs() {
    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    const shouldKeepCurrentResults = mainTab === "search" && navKey === "cloud" && resultSource === "cloud";
    navigateTo("cloud");
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setResultSource("cloud");
    if (!shouldKeepCurrentResults) {
      setResults([]);
    }
    setLoadingCloudSongs(true);
    setMessage("正在读取网易云音乐云盘");

    try {
      const data = await getCloudSongs();
      if (requestId !== listRequestIdRef.current) {
        return;
      }

      setResults(data.songs);
      setPlayQueue(data.songs);
      setResultSource("cloud");
      setCloudMeta({ count: data.count, size: data.size, maxSize: data.maxSize });
      applyQualityDefaults(data.songs);
      setMessage(`云盘音乐 · 共 ${data.count} 首歌`);
    } catch (error) {
      if (requestId !== listRequestIdRef.current) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "获取云盘音乐失败");
    } finally {
      setLoadingCloudSongs(false);
    }
  }

  async function loadDailySongs() {
    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    const shouldKeepCurrentResults = mainTab === "search" && navKey === "daily" && resultSource === "daily";
    navigateTo("daily");
    setActivePlaylist(null);
    setActiveArtist(null);
    setActiveAlbum(null);
    setResultSource("daily");
    if (!shouldKeepCurrentResults) {
      setResults([]);
    }
    setLoadingDailySongs(true);
    setMessage("正在读取网易云每日推荐");

    try {
      const songs = await getDailyRecommendSongs();
      if (requestId !== listRequestIdRef.current) {
        return;
      }

      setResults(songs);
      setPlayQueue(songs);
      setResultSource("daily");
      applyQualityDefaults(songs);
      setMessage(`每日推荐 · 共 ${songs.length} 首歌`);
    } catch (error) {
      if (requestId !== listRequestIdRef.current) {
        return;
      }
      setMessage(error instanceof Error ? error.message : "获取每日推荐失败");
    } finally {
      setLoadingDailySongs(false);
    }
  }

  async function refreshSettings() {
    try {
      const nextSettings = await getSettings();
      setSettings(nextSettings);
      return nextSettings;
    } catch {
      // Keep current settings if fetch fails.
      return null;
    }
  }

  async function refreshAdminConfig() {
    try {
      const nextConfig = await getAdminConfigRemote();
      setAdminConfig(nextConfig);
      setAdminConfigTokenInput("");
      return nextConfig;
    } catch {
      return null;
    }
  }

  async function refreshSession() {
    try {
      setSession(await getSession());
    } catch {
      // Keep current session if fetch fails.
    }
  }

  async function ensureNeteaseCookieHealthy(options: { force?: boolean; silent?: boolean; cookieOverride?: string } = {}) {
    const cookie = (options.cookieOverride ?? settings.neteaseCookie).trim();

    if (!cookie) {
      if (!options.silent) {
        setMessage("当前操作需要有效的网易云 Cookie，请先登录或重新扫码。");
      }
      return false;
    }

    const cachedHealth = cookieHealthRef.current;
    const isFreshCache =
      !options.force &&
      cachedHealth.cookie === cookie &&
      cachedHealth.result !== null &&
      Date.now() - cachedHealth.checkedAt < 60 * 1000;

    if (isFreshCache) {
      if (!cachedHealth.result?.ok && !options.silent) {
        setMessage(cachedHealth.result?.message || "网易云 Cookie 已失效，请重新登录。");
      }
      return Boolean(cachedHealth.result?.ok);
    }

    try {
      const result = await checkNeteaseCookie(cookie);
      cookieHealthRef.current = {
        cookie,
        checkedAt: Date.now(),
        result
      };

      if (!result.ok && !options.silent) {
        setMessage(result.message || "网易云 Cookie 已失效，请重新登录。");
      }

      return result.ok;
    } catch (error) {
      if (!options.silent) {
        setMessage(error instanceof Error ? error.message : "Cookie 检测失败");
      }
      return false;
    }
  }

  function syncAudioForSong(song: Song, autoplay: boolean, options: { startAtSeconds?: number; level?: DownloadQualityLevel } = {}) {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const nextUrl = getStreamUrl(song.id, options.level ?? getSelectedLevel(song), parseDurationSeconds(song.duration));
    const currentUrl = audio.dataset.streamUrl ?? "";
    const shouldReload = currentUrl !== nextUrl;

    setCurrentTrack(song);
    addToPlayHistory(song);
    setPlayerError("");

    let playAfterMetadata = false;

    if (shouldReload) {
      const startAtSeconds = Math.max(0, options.startAtSeconds ?? 0);

      if (startAtSeconds > 0) {
        playAfterMetadata = autoplay;
        const handleRestoreSeek = () => {
          const boundedTime = Math.min(startAtSeconds, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : startAtSeconds);
          audio.currentTime = boundedTime;
          playbackSecondsRef.current = boundedTime;
          setPlaybackSeconds(boundedTime);

          if (playAfterMetadata) {
            void audio.play().catch(() => {
              setIsPlaying(false);
              setPlayerError("当前歌曲暂时无法预览，可能需要更完整的 Cookie 或该音源不支持在线播放。");
            });
          }
        };

        audio.addEventListener("loadedmetadata", handleRestoreSeek, { once: true });
      }

      audio.pause();
      audio.src = nextUrl;
      audio.dataset.streamUrl = nextUrl;
      audio.load();
      playbackSecondsRef.current = startAtSeconds;
      setPlaybackSeconds(startAtSeconds);
      setPlaybackDuration(parseDurationSeconds(song.duration));
      setBufferedSeconds(0);
    }

    if (!autoplay || playAfterMetadata) {
      return;
    }

    void audio.play().catch(() => {
      setIsPlaying(false);
      setPlayerError("当前歌曲暂时无法预览，可能需要更完整的 Cookie 或该音源不支持在线播放。");
    });
  }

  function requirePlaybackAuth() {
    if (accountIsLoggedIn) {
      return true;
    }

    setIsPlaying(false);
    audioRef.current?.pause();
    setPlayerError("播放需要先登录网易云账号。请先扫码登录或导入 MUSIC_U Cookie。");
    setMessage("播放功能已锁定：请先登录网易云账号。");
    return false;
  }

  function handlePreview(song: Song) {
    if (!requirePlaybackAuth()) {
      return;
    }

    syncAudioForSong(song, true);
  }

  function openSongComments(song: Song) {
    setCommentTrack(song);
    setCommentPage(1);
    setCommentsError("");
    setCommentActionError("");
    setCommentRepliesById({});
    setExpandedCommentIds([]);
    setReplyingCommentId(null);
    setCommentReplyDrafts({});
    setRightPanelTab("comments");
    setMessage(`正在查看评论：${song.title}`);
  }

  function handleRefreshSongComments() {
    pendingCommentScrollTopRef.current = commentsScrollRef.current?.scrollTop ?? 0;
    setCommentRefreshKey((key) => key + 1);
  }

  function setCommentIdBusy(setter: (updater: (current: string[]) => string[]) => void, commentId: string, busy: boolean) {
    setter((current) => (
      busy
        ? Array.from(new Set([commentId, ...current]))
        : current.filter((id) => id !== commentId)
    ));
  }

  function updateCommentEverywhere(commentId: string, updater: (comment: SongComment) => SongComment) {
    const updateList = (items: SongComment[]) => items.map((item) => (item.id === commentId ? updater(item) : item));

    setSongComments((current) => current
      ? {
          ...current,
          hotComments: updateList(current.hotComments),
          comments: updateList(current.comments)
        }
      : current);

    setCommentRepliesById((current) => {
      let changed = false;
      const next: Record<string, SongCommentRepliesPage> = {};
      Object.entries(current).forEach(([id, page]) => {
        const replies = updateList(page.replies);
        if (replies !== page.replies) {
          changed = true;
        }
        next[id] = { ...page, replies };
      });
      return changed ? next : current;
    });
  }

  async function loadCommentReplies(comment: SongComment, append = false) {
    if (!commentTrack || loadingCommentReplyIds.includes(comment.id)) {
      return;
    }

    const existingPage = commentRepliesById[comment.id];
    const cursor = append ? existingPage?.nextTime ?? -1 : -1;
    setCommentActionError("");
    setCommentIdBusy(setLoadingCommentReplyIds, comment.id, true);

    try {
      const page = await getSongCommentReplies(commentTrack.id, comment.id, cursor, COMMENT_REPLY_PAGE_SIZE);
      setCommentRepliesById((current) => {
        const existingReplies = append ? current[comment.id]?.replies ?? [] : [];
        const existingIds = new Set(existingReplies.map((reply) => reply.id));
        const mergedReplies = append
          ? [...existingReplies, ...page.replies.filter((reply) => !existingIds.has(reply.id))]
          : page.replies;
        return {
          ...current,
          [comment.id]: {
            ...page,
            replies: mergedReplies
          }
        };
      });
      updateCommentEverywhere(comment.id, (item) => ({
        ...item,
        replyCount: Math.max(item.replyCount, page.total)
      }));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "获取评论回复失败";
      setCommentActionError(messageText);
      setMessage(messageText);
    } finally {
      setCommentIdBusy(setLoadingCommentReplyIds, comment.id, false);
    }
  }

  function handleToggleCommentReplies(comment: SongComment) {
    const expanded = expandedCommentIds.includes(comment.id);
    if (expanded) {
      setExpandedCommentIds((current) => current.filter((id) => id !== comment.id));
      return;
    }

    setExpandedCommentIds((current) => Array.from(new Set([...current, comment.id])));
    if (!commentRepliesById[comment.id]) {
      void loadCommentReplies(comment);
    }
  }

  async function handleToggleCommentLike(comment: SongComment) {
    if (!accountIsLoggedIn) {
      setMessage("登录网易云后才能点赞评论。");
      return;
    }
    if (!commentTrack || commentLikeActionIds.includes(comment.id)) {
      return;
    }

    const nextLiked = !comment.liked;
    const delta = nextLiked ? 1 : -1;
    setCommentActionError("");
    setCommentIdBusy(setCommentLikeActionIds, comment.id, true);
    updateCommentEverywhere(comment.id, (item) => ({
      ...item,
      liked: nextLiked,
      likedCount: Math.max(0, item.likedCount + delta)
    }));

    try {
      await setSongCommentLiked(commentTrack.id, comment.id, nextLiked);
      setMessage(nextLiked ? "已点赞评论。" : "已取消点赞。");
    } catch (error) {
      updateCommentEverywhere(comment.id, (item) => ({
        ...item,
        liked: !nextLiked,
        likedCount: Math.max(0, item.likedCount - delta)
      }));
      const messageText = error instanceof Error ? error.message : (nextLiked ? "点赞评论失败" : "取消点赞失败");
      setCommentActionError(messageText);
      setMessage(messageText);
    } finally {
      setCommentIdBusy(setCommentLikeActionIds, comment.id, false);
    }
  }

  async function handleSubmitCommentReply(comment: SongComment) {
    if (!accountIsLoggedIn) {
      setMessage("登录网易云后才能回复评论。");
      return;
    }
    if (!commentTrack || postingCommentId) {
      return;
    }

    const content = commentReplyDrafts[comment.id]?.trim() ?? "";
    if (!content) {
      setCommentActionError("回复内容不能为空。");
      return;
    }

    setCommentActionError("");
    setPostingCommentId(comment.id);

    try {
      const newReply = await replyToSongComment(commentTrack.id, comment.id, content);
      setCommentReplyDrafts((current) => {
        const next = { ...current };
        delete next[comment.id];
        return next;
      });
      setReplyingCommentId(null);
      updateCommentEverywhere(comment.id, (item) => ({
        ...item,
        replyCount: item.replyCount + 1
      }));
      if (newReply) {
        setExpandedCommentIds((current) => Array.from(new Set([...current, comment.id])));
        setCommentRepliesById((current) => {
          const existingPage = current[comment.id];
          const existingReplies = existingPage?.replies ?? [];
          return {
            ...current,
            [comment.id]: {
              songId: commentTrack.id,
              parentCommentId: comment.id,
              replies: [newReply, ...existingReplies.filter((reply) => reply.id !== newReply.id)],
              total: Math.max(existingPage?.total ?? 0, existingReplies.length + 1),
              hasMore: Boolean(existingPage?.hasMore),
              nextTime: existingPage?.nextTime
            }
          };
        });
      }
      setMessage("回复已发送。");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "回复评论失败";
      setCommentActionError(messageText);
      setMessage(messageText);
    } finally {
      setPostingCommentId(null);
    }
  }

  function openUserProfile(target: UserProfileTarget) {
    if (!target.id.trim()) {
      setMessage("这个用户暂时没有可用的网易云 ID。");
      return;
    }

    const safeUserId = target.id.trim();
    const cachedProfile = userProfileCacheRef.current[safeUserId];
    const isFreshCachedProfile = cachedProfile && Date.now() - cachedProfile.cachedAt < USER_PROFILE_CACHE_TTL_MS;

    setAccountMenuOpen(false);
    setUserProfileTarget({ ...target, id: safeUserId });
    setUserProfile(cachedProfile ? cachedProfile.profile : null);
    setLoadingUserProfile(!isFreshCachedProfile);
    setUserProfileError("");
    setUserProfileView("profile");
    setUserSocialKind(null);
    setUserSocialPage(null);
    setLoadingUserSocial(false);
    setUserSocialError("");
    setUserSocialActionIds([]);
    setUserEventsPage(null);
    setLoadingUserEvents(false);
    setUserEventsError("");
  }

  function closeUserProfile() {
    setUserProfileTarget(null);
    setUserProfile(null);
    setLoadingUserProfile(false);
    setUserProfileError("");
    setUserProfileView("profile");
    setUserSocialKind(null);
    setUserSocialPage(null);
    setLoadingUserSocial(false);
    setUserSocialError("");
    setUserSocialActionIds([]);
    setUserEventsPage(null);
    setLoadingUserEvents(false);
    setUserEventsError("");
  }

  function backToUserProfileHome() {
    setUserProfileView("profile");
    setUserSocialKind(null);
    setUserSocialError("");
    setUserEventsError("");
  }

  function openMyUserProfile() {
    const profile = session.profile;
    if (!profile?.id || profile.provider !== "netease") {
      setMessage("当前不是网易云登录态，暂时没有可查看的网易云个人资料。");
      return;
    }

    openUserProfile({
      id: profile.id,
      fallbackName: profile.displayName,
      fallbackAvatarUrl: profile.avatarUrl
    });
  }

  function openProfilePlaylist(playlist: UserProfile["playlists"][number]) {
    const profileOwnerId = userProfileDisplay?.id ?? userProfileTarget?.id ?? "";
    const isCurrentAccountProfile = Boolean(accountProfile?.provider === "netease" && accountProfile.id === profileOwnerId);
    const mappedPlaylist: UserPlaylist = {
      id: playlist.id,
      name: playlist.name,
      coverUrl: playlist.coverUrl,
      trackCount: playlist.trackCount,
      creatorName: userProfileName,
      playCount: playlist.playCount,
      owned: isCurrentAccountProfile && playlist.owned
    };

    closeUserProfile();
    void loadPlaylistSongs(mappedPlaylist, 1, "");
  }

  function openUserEventResource(event: UserEventItem) {
    const resource = event.resource;
    if (!resource?.id) {
      return;
    }

    if (resource.type === "playlist") {
      closeUserProfile();
      void loadPlaylistSongs(
        {
          id: resource.id,
          name: resource.title,
          coverUrl: resource.coverUrl,
          trackCount: 0,
          creatorName: event.nickname,
          playCount: 0,
          owned: false
        },
        1,
        ""
      );
      return;
    }

    if (resource.type === "album") {
      closeUserProfile();
      void loadAlbumPage(resource.id, resource.title);
      return;
    }

    setMessage(`${formatUserEventResourceType(resource)}资源已展示，暂时不直接跳转。`);
  }

  async function loadUserSocial(kind: UserSocialListKind, page = 1, append = false) {
    const targetUserId = userProfileDisplay?.id ?? userProfileTarget?.id ?? "";
    if (!targetUserId) {
      setUserSocialError("缺少用户 ID，无法读取好友列表。");
      return;
    }

    setUserProfileView(kind);
    setUserSocialPage((current) => (current?.kind === kind ? current : null));
    setUserEventsError("");
    setLoadingUserSocial(true);
    setUserSocialError("");

    try {
      const nextPage = await getUserSocialList(targetUserId, kind, page, USER_SOCIAL_PAGE_SIZE);
      setUserSocialPage((current) =>
        append && current && current.kind === kind
          ? {
              ...nextPage,
              users: [...current.users, ...nextPage.users]
            }
          : nextPage
      );
      setUserSocialKind(kind);
    } catch (error) {
      setUserSocialError(error instanceof Error ? error.message : "获取好友列表失败");
    } finally {
      setLoadingUserSocial(false);
    }
  }

  function openUserSocial(kind: UserSocialListKind) {
    void loadUserSocial(kind, 1, false);
  }

  async function loadUserEvents(append = false) {
    const targetUserId = userProfileDisplay?.id ?? userProfileTarget?.id ?? "";
    if (!targetUserId) {
      setUserEventsError("缺少用户 ID，无法读取动态。");
      return;
    }

    const lasttime = append ? userEventsPage?.lasttime ?? -1 : -1;
    setUserProfileView("events");
    setUserSocialKind(null);
    setUserSocialError("");
    setLoadingUserEvents(true);
    setUserEventsError("");

    try {
      const nextPage = await getUserEvents(targetUserId, lasttime, USER_EVENTS_PAGE_SIZE);
      setUserEventsPage((current) =>
        append && current && current.userId === nextPage.userId
          ? {
              ...nextPage,
              events: [...current.events, ...nextPage.events]
            }
          : nextPage
      );
    } catch (error) {
      setUserEventsError(error instanceof Error ? error.message : "获取用户动态失败");
    } finally {
      setLoadingUserEvents(false);
    }
  }

  function openUserEvents() {
    void loadUserEvents(false);
  }

  async function toggleSocialUserFollow(user: UserSocialUser) {
    if (!accountIsLoggedIn) {
      setMessage("需要先登录网易云账号，才能关注或取消关注用户。");
      return;
    }

    const nextFollowed = !user.followed;
    setUserSocialActionIds((current) => [...current, user.id]);

    try {
      const result = await setUserFollowed(user.id, nextFollowed);
      setUserSocialPage((current) =>
        current
          ? {
              ...current,
              users: current.users.map((item) =>
                item.id === result.userId
                  ? {
                      ...item,
                      followed: result.followed,
                      mutual: result.followed && item.mutual
                    }
                  : item
              )
            }
          : current
      );
      setMessage(result.followed ? `已关注 ${user.nickname}` : `已取消关注 ${user.nickname}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "关注操作失败");
    } finally {
      setUserSocialActionIds((current) => current.filter((id) => id !== user.id));
    }
  }

  function handleSelectSong(song: Song) {
    setMessage(accountIsLoggedIn ? `已选中：${song.title}。双击歌曲或点击试听开始播放。` : `已选中：${song.title}。登录网易云账号后可播放。`);
  }

  function handleOpenSongContextMenu(event: MouseEvent<HTMLElement>, song: Song) {
    event.preventDefault();
    event.stopPropagation();
    handleSelectSong(song);

    const menuWidth = 236;
    const menuHeight = resultSource === "playlist" && activePlaylist?.owned ? 330 : 286;
    const x = Math.min(event.clientX, Math.max(12, window.innerWidth - menuWidth - 12));
    const y = Math.min(event.clientY, Math.max(12, window.innerHeight - menuHeight - 12));

    setSongContextMenu({ song, x, y });
  }

  function closeSongContextMenu() {
    setSongContextMenu(null);
  }

  function getSongShareUrl(song: Song) {
    return `https://music.163.com/#/song?id=${encodeURIComponent(song.id)}`;
  }

  async function handleCopySongLink(song: Song) {
    try {
      await navigator.clipboard.writeText(getSongShareUrl(song));
      setMessage(`已复制链接：${song.title}`);
    } catch {
      setMessage("复制链接失败，请检查浏览器剪贴板权限。");
    }
  }

  function runSongContextAction(action: () => void | Promise<void>) {
    closeSongContextMenu();
    void action();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    await runSearch(query);
  }

  function isDowngradedQualityError(messageText: string) {
    return messageText.includes("低于你选择") || messageText.includes("实际文件是");
  }

  async function runDirectDownload(song: Song, level: DownloadQualityLevel, options: { showIssueDialog?: boolean } = {}) {
    if (directDownloadingSongId || batchDownloading) {
      return;
    }

    const showIssueDialog = options.showIssueDialog ?? true;
    const selectedLabel = getDownloadLevelLabel(song, level);
    setDirectDownloadingSongId(song.id);

    try {
      setDownloadIssue(null);
      setMessage(`正在从网易云直连下载：${song.title} · ${selectedLabel}`);
      await startDirectSongDownload(song, level, (progress) => {
        setMessage(`正在从网易云直连下载：${song.title} · ${progress}%`);
      });
      setMessage(`已保存到本机下载：${song.title}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "启动下载失败";

      if (isDirectDownloadBlockedError(error)) {
        const useServerFallback = window.confirm(`${errorMessage}\n\n可以改用备用下载，但会消耗服务器带宽。要现在用备用下载吗？`);

        if (useServerFallback) {
          startServerSongDownload(song, level);
          setMessage(`已启动备用下载：${song.title}`);
        } else {
          setMessage("直连下载被浏览器拦截，未使用服务器备用下载。");
        }
      } else {
        if (showIssueDialog) {
          setDownloadIssue({
            song,
            message: errorMessage,
            attemptedLevel: level,
            attemptedLabel: selectedLabel
          });
        }
        setMessage(errorMessage);
      }
    } finally {
      setDirectDownloadingSongId(null);
    }
  }

  async function handleDownload(song: Song) {
    if (!accountIsLoggedIn) {
      setMessage("下载需要先登录账号，已为你打开登录窗口。");
      await handleStartQrLogin();
      return;
    }

    await runDirectDownload(song, getSelectedLevel(song));
  }

  async function handleDownloadStandardFromIssue() {
    const issue = downloadIssue;
    if (!issue) {
      return;
    }

    setDownloadIssue(null);
    await runDirectDownload(issue.song, "standard", { showIssueDialog: false });
  }

  async function handleSaveTaskFile(task: DownloadTask) {
    if (savingTaskFileId) {
      return;
    }

    setSavingTaskFileId(task.id);
    setMessage(`正在保存到本机：${task.title}`);

    try {
      await downloadTaskFile(task);
      setMessage(`已开始保存到本机：${task.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存文件失败");
    } finally {
      setSavingTaskFileId(null);
    }
  }

  async function handleBatchDownload(songs: Song[], scopeLabel: string) {
    if (batchDownloading || songs.length === 0) {
      if (songs.length === 0) {
        setMessage("当前没有可批量下载的歌曲。");
      }
      return;
    }

    if (!accountIsLoggedIn) {
      setMessage("批量下载需要先登录账号，已为你打开登录窗口。");
      await handleStartQrLogin();
      return;
    }

    setBatchDownloading(true);
    setMessage(`正在启动${scopeLabel}直连下载...`);

    let successCount = 0;
    let failedCount = 0;
    let firstFailureMessage = "";

    try {
      for (const song of songs) {
        try {
          setMessage(`正在直连下载 ${successCount + failedCount + 1}/${songs.length}：${song.title}`);
          await startDirectSongDownload(song, getDownloadLevel(song), (progress) => {
            setMessage(`正在直连下载 ${successCount + failedCount + 1}/${songs.length}：${song.title} · ${progress}%`);
          });
          successCount += 1;
        } catch (error) {
          failedCount += 1;
          if (!firstFailureMessage) {
            firstFailureMessage = isDirectDownloadBlockedError(error)
              ? "浏览器拦截网易云 CDN 跨域直连。批量下载已停止，请单首下载并选择备用下载。"
              : error instanceof Error ? error.message : "启动下载失败";
          }

          if (isDirectDownloadBlockedError(error)) {
            break;
          }
        }
      }

      if (successCount > 0 && failedCount === 0) {
        setMessage(`已向浏览器提交 ${scopeLabel}的 ${successCount} 首直连下载。`);
      } else if (successCount > 0) {
        setMessage(`已提交 ${successCount} 首，失败 ${failedCount} 首。${firstFailureMessage}`);
      } else {
        setMessage(firstFailureMessage || "批量启动下载失败");
      }
    } finally {
      setBatchDownloading(false);
    }
  }

  function handleToggleSongSelection(songId: string) {
    setSelectedSongIds((current) => (current.includes(songId) ? current.filter((id) => id !== songId) : [...current, songId]));
  }

  function handleToggleVisibleSongsSelection() {
    setSelectedSongIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !visibleSongs.some((song) => song.id === id));
      }

      const nextIds = new Set(current);
      visibleSongs.forEach((song) => nextIds.add(song.id));
      return [...nextIds];
    });
  }

  function enterBatchSelectionMode() {
    setBatchSelectionMode(true);
  }

  function exitBatchSelectionMode() {
    setBatchSelectionMode(false);
    setSelectedSongIds([]);
  }

  async function handleSaveAdminConfig(event: FormEvent) {
    event.preventDefault();
    setSavingAdminConfig(true);

    const payload: AdminConfigUpdate = {
      trustedUserWhitelistText: adminConfig.trustedUserWhitelistText,
      systemDefaultToken: adminConfigTokenInput,
      systemFallbackEnabled: adminConfig.systemFallbackEnabled
    };

    try {
      const saved = await saveAdminConfigRemote(payload);
      setAdminConfig(saved);
      setAdminConfigTokenInput("");
      setMessage("高级控制配置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存高级控制配置失败");
    } finally {
      setSavingAdminConfig(false);
    }
  }

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    setSavingSettings(true);

    try {
      const saved = await saveSettings(settings);
      setSettings(saved);
      setMessage("设置已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存设置失败");
    } finally {
      setSavingSettings(false);
    }
  }

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoggingIn(true);

    try {
      const nextSession = await loginAccount(loginForm);
      setSession(nextSession);
      if (nextSession.profile) {
        setSettings((current) => ({
          ...current,
          accountName: nextSession.profile.displayName,
          vipEnabled: nextSession.profile.vipEnabled
        }));
      }
      setMessage("本地会话已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      setLoggingIn(false);
    }
  }

  async function handleLogout() {
    try {
      setSession(await logoutAccount());
      setAccountMenuOpen(false);
      setMessage("已退出当前账号");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出失败");
    }
  }

  async function handleClearCookie() {
    const nextSettings = {
      ...settings,
      neteaseCookie: ""
    };

    try {
      setSettings(await saveSettings(nextSettings));
      setSession(await logoutAccount());
      setPlaylists([]);
      setAccountMenuOpen(false);
      setMessage("已清除网易云 Cookie，可在设置页重新填写。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清除 Cookie 失败");
    }
  }

  async function startQrLoginFlow(options: { autoRefresh?: boolean } = {}) {
    setStartingQrLogin(true);
    setQrLoginOpen(true);
    setNeteaseLoginMode(window.innerWidth <= 768 ? "cellphone" : "qr");
    setQrLoginKey("");
    setQrLoginImage("");
    setQrLoginMessage(
      window.innerWidth <= 768
        ? CELLPHONE_LOGIN_DEFAULT_MESSAGE
        : options.autoRefresh
          ? "二维码已刷新，正在重新生成..."
          : "正在生成网易云登录二维码..."
    );
    qrCheckFailureCountRef.current = 0;
    qrAutoRefreshPendingRef.current = false;
    setAccountMenuOpen(false);

    try {
      const data = await startNeteaseQrLogin();
      qrAutoRefreshCountRef.current = options.autoRefresh ? qrAutoRefreshCountRef.current + 1 : 0;
      setQrLoginKey(data.key);
      setQrLoginImage(data.qrImage);
      setQrLoginExpiresIn(300);
      setQrLoginMessage("打开网易云音乐 App，扫码后在手机上确认登录。");
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "二维码登录初始化失败";
      setQrLoginMessage(options.autoRefresh ? `自动刷新失败：${failureMessage}` : failureMessage);
    } finally {
      setStartingQrLogin(false);
    }
  }

  async function handleStartQrLogin() {
    await startQrLoginFlow();
  }

  async function handleNeteaseLoginSuccess(nextSession?: AuthSession | null, successMessage = "网易云登录成功，Cookie 已自动写入设置。") {
    if (nextSession) {
      setSession(nextSession);
    } else {
      await refreshSession();
    }

    await refreshSettings();
    cookieHealthRef.current = {
      cookie: "",
      checkedAt: 0,
      result: null
    };
    setMessage(successMessage);
  }

  function normalizeNeteaseCookieInput(input: string) {
    let trimmed = input.trim();
    if (!trimmed) {
      return "";
    }

    const cookiePair = trimmed
      .split(";")
      .map((item) => item.trim())
      .find((item) => /^MUSIC_U\s*[=:]/i.test(item));
    if (cookiePair) {
      trimmed = cookiePair;
    }

    const musicUValue = trimmed.match(/^"?MUSIC_U"?\s*[:=]\s*"?([^";\s]+)"?$/i)?.[1];
    if (musicUValue) {
      return `MUSIC_U=${musicUValue}`;
    }

    const bareValue = trimmed.replace(/^"+|"+$/g, "");
    return bareValue.includes("=") ? bareValue : `MUSIC_U=${bareValue}`;
  }

  async function handleCookieLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (importingCookie) {
      return;
    }

    const cookie = normalizeNeteaseCookieInput(cookieLoginInput);
    if (!cookie) {
      setQrLoginMessage("请输入 MUSIC_U Cookie。");
      return;
    }

    try {
      setImportingCookie(true);
      const checkResult = await checkNeteaseCookie(cookie);
      if (!checkResult.ok) {
        setQrLoginMessage(checkResult.message);
        return;
      }

      await saveSettings({
        ...settings,
        providerMode: "netease",
        neteaseCookie: cookie
      });
      await handleNeteaseLoginSuccess(null, `网页登录 Cookie 已导入：${checkResult.accountName ?? "网易云账号"}`);
      setCookieLoginInput("");
      closeQrLogin();
    } catch (error) {
      setQrLoginMessage(error instanceof Error ? error.message : "Cookie 导入失败");
    } finally {
      setImportingCookie(false);
    }
  }

  async function handleCopyCookieGuide() {
    try {
      setCopyingCookieGuide(true);
      await navigator.clipboard.writeText(COOKIE_LOGIN_GUIDE);
      setQrLoginMessage("已复制获取 Cookie 的操作提示。");
    } catch {
      setQrLoginMessage(COOKIE_LOGIN_GUIDE);
    } finally {
      window.setTimeout(() => setCopyingCookieGuide(false), 900);
    }
  }

  async function handleSendCaptcha() {
    if (sendingCaptcha) {
      return;
    }

    try {
      setSendingCaptcha(true);
      const result = await sendNeteaseCaptcha(cellphoneLoginForm.phone, cellphoneLoginForm.countryCode);
      setQrLoginMessage(result.message);
    } catch (error) {
      setQrLoginMessage(error instanceof Error ? error.message : "验证码发送失败");
    } finally {
      setSendingCaptcha(false);
    }
  }

  async function handleCellphoneLoginSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loggingCellphoneIn) {
      return;
    }

    try {
      setLoggingCellphoneIn(true);
      const result = await loginWithNeteaseCellphone(
        cellphoneLoginForm.phone,
        cellphoneLoginForm.captcha,
        cellphoneLoginForm.countryCode
      );
      setQrLoginMessage(result.message);

      if (result.code === 200) {
        await handleNeteaseLoginSuccess(result.session, "网易云验证码登录成功，Cookie 已自动写入设置。");
        closeQrLogin();
      }
    } catch (error) {
      setQrLoginMessage(error instanceof Error ? error.message : "手机号登录失败");
    } finally {
      setLoggingCellphoneIn(false);
    }
  }

  function closeQrLogin() {
    if (qrCloseTimerRef.current) {
      window.clearTimeout(qrCloseTimerRef.current);
      qrCloseTimerRef.current = null;
    }

    qrCheckFailureCountRef.current = 0;
    qrAutoRefreshPendingRef.current = false;
    qrAutoRefreshCountRef.current = 0;
    setQrLoginOpen(false);
    setQrLoginKey("");
    setQrLoginImage("");
    setQrLoginMessage(QR_LOGIN_DEFAULT_MESSAGE);
    setQrLoginExpiresIn(0);
    setNeteaseLoginMode("qr");
    setCookieLoginInput("");
  }

  function handleSwitchNeteaseLoginMode(mode: NeteaseLoginMode) {
    setNeteaseLoginMode(mode);
    setQrLoginMessage(
      mode === "qr"
        ? qrLoginKey && qrLoginImage
          ? "打开网易云音乐 App，扫码后在手机上确认登录。"
          : QR_LOGIN_DEFAULT_MESSAGE
        : mode === "cellphone"
          ? CELLPHONE_LOGIN_DEFAULT_MESSAGE
          : COOKIE_LOGIN_DEFAULT_MESSAGE
    );
  }

  function handleTogglePlayback() {
    if (!requirePlaybackAuth()) {
      return;
    }

    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (!currentTrack) {
      const fallbackSong = results[0];
      if (fallbackSong) {
        syncAudioForSong(fallbackSong, true);
      }
      return;
    }

      const nextUrl = getStreamUrl(currentTrack.id, getSelectedLevel(currentTrack), parseDurationSeconds(currentTrack.duration));
    const hasSource = audio.dataset.streamUrl === nextUrl;

    if (!hasSource) {
      syncAudioForSong(currentTrack, true);
      return;
    }

    if (audio.paused) {
      void audio.play().catch(() => {
        setIsPlaying(false);
        setPlayerError("播放启动失败，请重新点一次播放。");
      });
      return;
    }

    audio.pause();
  }

  function handleReplay() {
    if (!requirePlaybackAuth()) {
      return;
    }

    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }

    if (!audio.dataset.streamUrl) {
      syncAudioForSong(currentTrack, true);
      return;
    }

    audio.currentTime = 0;
    playbackSecondsRef.current = 0;
    setPlaybackSeconds(0);
    void audio.play().catch(() => {
      setIsPlaying(false);
      setPlayerError("重播失败，请重新尝试。");
    });
  }

  async function handleToggleCurrentTrackLike() {
    if (!currentTrack || togglingLike) {
      return;
    }

    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    const alreadyLiked = likedSongIds.includes(currentTrack.id);
    setTogglingLike(true);

    try {
      const liked = await setSongLiked(currentTrack.id, !alreadyLiked);
      setLikedSongIds((current) =>
        liked ? Array.from(new Set([currentTrack.id, ...current])) : current.filter((id) => id !== currentTrack.id)
      );
      setMessage(liked ? `已喜欢：${currentTrack.title}` : `已取消喜欢：${currentTrack.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : alreadyLiked ? "取消喜欢失败" : "加入喜欢失败");
    } finally {
      setTogglingLike(false);
    }
  }

  async function handleOpenPlaylistPickerForSongs(songs: Song[]) {
    const safeSongs = songs.filter((song, index, list) => song.id && list.findIndex((item) => item.id === song.id) === index);
    if (safeSongs.length === 0) {
      setMessage("当前没有可收藏的歌曲。");
      return;
    }

    if (!accountIsLoggedIn) {
      setMessage("收藏到歌单需要先登录网易云账号，已为你打开登录窗口。");
      await handleStartQrLogin();
      return;
    }

    const cookieOk = await ensureNeteaseCookieHealthy();
    if (!cookieOk) {
      return;
    }

    setPlaylistPickerSong(safeSongs[0]);
    setPlaylistPickerSongs(safeSongs);
    setPlaylistPickerSourcePlaylistId(resultSource === "playlist" ? activePlaylist?.id ?? null : null);
    setPlaylistPickerError("");

    if (playlists.length > 0) {
      return;
    }

    setPlaylistPickerLoading(true);

    try {
      const data = await getPlaylists();
      setPlaylists(data);
      if (!data.some((playlist) => playlist.owned)) {
        setPlaylistPickerError("当前账号没有可编辑的自建歌单。");
      }
    } catch (error) {
      setPlaylistPickerError(error instanceof Error ? error.message : "读取歌单失败");
    } finally {
      setPlaylistPickerLoading(false);
    }
  }

  async function handleOpenPlaylistPicker(song: Song) {
    await handleOpenPlaylistPickerForSongs([song]);
  }

  async function handleAddSongToPlaylist(playlist: UserPlaylist) {
    const songsToAdd = playlistPickerSongs.length > 0 ? playlistPickerSongs : playlistPickerSong ? [playlistPickerSong] : [];
    if (songsToAdd.length === 0 || addingToPlaylistId) {
      return;
    }

    setAddingToPlaylistId(playlist.id);
    setPlaylistPickerError("");

    try {
      let playlistName = playlist.name;
      let addedCount = 0;
      let failedCount = 0;
      let firstFailureMessage = "";

      for (const song of songsToAdd) {
        try {
          const result = await addSongToPlaylist(playlist.id, song.id);
          playlistName = result.playlistName;
          addedCount += Math.max(1, result.addedCount);
        } catch (error) {
          failedCount += 1;
          if (!firstFailureMessage) {
            firstFailureMessage = error instanceof Error ? error.message : "添加到歌单失败";
          }
        }
      }

      if (addedCount === 0) {
        setPlaylistPickerError(firstFailureMessage || "添加到歌单失败");
        return;
      }

      setPlaylists((current) =>
        current.map((item) =>
          item.id === playlist.id
            ? { ...item, trackCount: item.trackCount + addedCount }
            : item
        )
      );
      setActivePlaylist((current) =>
        current?.id === playlist.id
          ? { ...current, trackCount: current.trackCount + addedCount }
          : current
      );
      setMessage(songsToAdd.length === 1
        ? `已收藏到「${playlistName}」：${songsToAdd[0].title}`
        : `已收藏到「${playlistName}」：成功 ${addedCount} 首${failedCount > 0 ? `，失败 ${failedCount} 首` : ""}`);
      if (songsToAdd.length > 1) {
        setSelectedSongIds([]);
      }
      setPlaylistPickerSong(null);
      setPlaylistPickerSongs([]);
      setPlaylistPickerSourcePlaylistId(null);
    } catch (error) {
      setPlaylistPickerError(error instanceof Error ? error.message : "添加到歌单失败");
    } finally {
      setAddingToPlaylistId(null);
    }
  }

  function getActivePlaybackQueue() {
    return playQueue.length > 0 ? playQueue : results;
  }

  function getNextSongFromQueue(queue: Song[], options: { excludeSongId?: string; mode?: "sequential" | "shuffle" } = {}) {
    if (queue.length === 0) {
      return null;
    }

    if (options.mode === "shuffle") {
      const candidates = options.excludeSongId ? queue.filter((song) => song.id !== options.excludeSongId) : queue;
      const nextPool = candidates.length > 0 ? candidates : queue;
      return nextPool[Math.floor(Math.random() * nextPool.length)] ?? null;
    }

    const currentIndex = queue.findIndex((song) => song.id === options.excludeSongId);
    return currentIndex >= 0 && currentIndex < queue.length - 1 ? queue[currentIndex + 1] : queue[0];
  }

  function handleTogglePlaybackMode() {
    setPlaybackMode((current) => {
      const nextMode = current === "shuffle" ? "sequential" : "shuffle";
      setMessage(nextMode === "shuffle" ? "已切换到随机播放" : "已切换到顺序播放");
      return nextMode;
    });
  }

  function handleNextTrack() {
    if (!requirePlaybackAuth()) {
      return;
    }

    const queue = getActivePlaybackQueue();
    if (queue.length === 0) {
      return;
    }

    const nextSong = getNextSongFromQueue(queue, {
      excludeSongId: currentTrack?.id,
      mode: playbackMode
    });
    if (nextSong) {
      syncAudioForSong(nextSong, true);
    }
  }

  function handleQueueSongNext(song: Song) {
    setPlayQueue((current) => {
      const baseQueue = current.length > 0 ? current : visibleSongs;
      const dedupedQueue = baseQueue.filter((item) => item.id !== song.id);
      const currentIndex = dedupedQueue.findIndex((item) => item.id === currentTrack?.id);

      if (currentIndex < 0) {
        return [song, ...dedupedQueue].slice(0, 100);
      }

      return [
        ...dedupedQueue.slice(0, currentIndex + 1),
        song,
        ...dedupedQueue.slice(currentIndex + 1)
      ].slice(0, 100);
    });
    setMessage(`已加入下一首播放：${song.title}`);
  }

  function handleRemoveFromQueue(songId: string) {
    setPlayQueue((current) => {
      const nextQueue = current.filter((song) => song.id !== songId);
      if (currentTrack?.id === songId) {
        const nextSong = getNextSongFromQueue(nextQueue, {
          mode: playbackMode
        });
        if (nextSong) {
          if (accountIsLoggedIn) {
            window.setTimeout(() => syncAudioForSong(nextSong, true), 0);
          } else {
            setCurrentTrack(nextSong);
            playbackSecondsRef.current = 0;
            setPlaybackSeconds(0);
            setPlaybackDuration(parseDurationSeconds(nextSong.duration));
          }
        } else {
          audioRef.current?.pause();
          setCurrentTrack(null);
          playbackSecondsRef.current = 0;
          setPlaybackSeconds(0);
          setPlaybackDuration(0);
        }
      }

      return nextQueue;
    });
  }

  function handlePlaylistPageChange(nextPage: number) {
    if (!activePlaylist || loadingPlaylistSongs) {
      return;
    }

    const totalSongs = playlistSearchKeyword ? playlistSongsTotal : activePlaylist.trackCount;
    const totalPages = Math.max(1, Math.ceil(totalSongs / playlistSongsLimit));
    const safePage = Math.min(totalPages, Math.max(1, nextPage));

    if (safePage === playlistSongsPage) {
      return;
    }

    void loadPlaylistSongs(activePlaylist, safePage, playlistSearchKeyword, playlistSortMode);
  }

  function handlePlaylistSearchSubmit(event: FormEvent) {
    event.preventDefault();
    if (!activePlaylist || loadingPlaylistSongs) {
      return;
    }

    void loadPlaylistSongs(activePlaylist, 1, playlistSearchInput, playlistSortMode);
  }

  function handleClearPlaylistSearch() {
    if (!activePlaylist || loadingPlaylistSongs) {
      return;
    }

    setPlaylistSearchInput("");
    setPlaylistSearchKeyword("");
    void loadPlaylistSongs(activePlaylist, 1, "", playlistSortMode);
  }

  function updatePlaylistSortMenuStyle(trigger = playlistSortTriggerRef.current) {
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, 168);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const availableBelow = viewportHeight - rect.bottom - FLOATING_MENU_MARGIN;
    const availableAbove = rect.top - FLOATING_MENU_MARGIN;
    const shouldOpenUp = availableBelow < PLAYLIST_SORT_MENU_ESTIMATED_HEIGHT && availableAbove > availableBelow;
    const availableSpace = shouldOpenUp ? availableAbove : availableBelow;
    const maxHeight = Math.max(136, Math.min(PLAYLIST_SORT_MENU_ESTIMATED_HEIGHT, availableSpace - 8));
    const top = shouldOpenUp
      ? Math.max(FLOATING_MENU_MARGIN, rect.top - maxHeight - 8)
      : Math.min(rect.bottom + 8, viewportHeight - maxHeight - FLOATING_MENU_MARGIN);
    const left = Math.min(
      Math.max(FLOATING_MENU_MARGIN, rect.left),
      Math.max(FLOATING_MENU_MARGIN, viewportWidth - width - FLOATING_MENU_MARGIN)
    );

    setPlaylistSortMenuStyle({ top, left, width, maxHeight });
  }

  function togglePlaylistSortMenu(trigger: HTMLButtonElement) {
    setOpenQualityMenuId(null);

    if (openPlaylistSortMenu) {
      setOpenPlaylistSortMenu(false);
      return;
    }

    updatePlaylistSortMenuStyle(trigger);
    setOpenPlaylistSortMenu(true);
  }

  function handlePlaylistSortChange(nextSortMode: PlaylistSortMode) {
    setPlaylistSortMode(nextSortMode);
    setOpenPlaylistSortMenu(false);

    if (!activePlaylist || loadingPlaylistSongs) {
      return;
    }

    void loadPlaylistSongs(activePlaylist, 1, playlistSearchKeyword, nextSortMode);
  }

  async function handleRemovePlaylistSongs(songIds: string[]) {
    if (!activePlaylist || !activePlaylist.owned || removingPlaylistSongs || songIds.length === 0) {
      return;
    }

    const safeSongIds = [...new Set(songIds)];
    const confirmed = window.confirm(`确定从「${activePlaylist.name}」移除 ${safeSongIds.length} 首歌吗？不会删除歌曲本身。`);
    if (!confirmed) {
      return;
    }

    setRemovingPlaylistSongs(true);
    setMessage(`正在从「${activePlaylist.name}」移除 ${safeSongIds.length} 首歌...`);

    try {
      const result = await removeSongsFromPlaylist(activePlaylist.id, safeSongIds);
      const removedCount = Math.max(0, result.removedCount);
      const updatedPlaylist = {
        ...activePlaylist,
        trackCount: Math.max(0, activePlaylist.trackCount - removedCount)
      };
      const removedIdSet = new Set(result.songIds);
      const nextTotal = playlistSearchKeyword
        ? Math.max(0, playlistSongsTotal - removedCount)
        : updatedPlaylist.trackCount;
      const nextPage = Math.min(playlistSongsPage, Math.max(1, Math.ceil(nextTotal / playlistSongsLimit)));

      setPlaylists((current) =>
        current.map((playlist) =>
          playlist.id === activePlaylist.id
            ? { ...playlist, trackCount: updatedPlaylist.trackCount }
            : playlist
        )
      );
      setActivePlaylist(updatedPlaylist);
      setSelectedSongIds((current) => current.filter((songId) => !removedIdSet.has(songId)));
      setResults((current) => current.filter((song) => !removedIdSet.has(song.id)));
      setPlayQueue((current) => current.filter((song) => !removedIdSet.has(song.id)));
      setPlaylistSongsTotal(nextTotal);

      await loadPlaylistSongs(updatedPlaylist, nextPage, playlistSearchKeyword, playlistSortMode);
      setMessage(`已从「${result.playlistName}」移除 ${removedCount} 首歌`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "从歌单移除失败");
    } finally {
      setRemovingPlaylistSongs(false);
    }
  }

  async function handleRemoveSelectedPlaylistSongs() {
    await handleRemovePlaylistSongs(selectedVisibleSongs.map((song) => song.id));
  }

  function markLyricsManualScroll() {
    lyricManualScrollUntilRef.current = Date.now() + 3500;
  }

  function scrollLyricIntoPanel(panel: HTMLDivElement | null, lyricButton: HTMLButtonElement | null, behavior: ScrollBehavior = "smooth") {
    if (!panel || !lyricButton) {
      return;
    }

    requestAnimationFrame(() => {
      const panelRect = panel.getBoundingClientRect();
      const lyricRect = lyricButton.getBoundingClientRect();
      const lyricCenterOffset = lyricRect.top - panelRect.top + lyricRect.height / 2;
      const targetTop = panel.scrollTop + lyricCenterOffset - panel.clientHeight / 2;
      panel.scrollTo({ top: Math.max(0, targetTop), behavior });
    });
  }

  function handleSeekToLyric(time: number) {
    if (!requirePlaybackAuth()) {
      return;
    }

    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }

    const shouldContinuePlaying = isPlaying || !audio.paused;
    const nextUrl = getStreamUrl(currentTrack.id, getSelectedLevel(currentTrack), parseDurationSeconds(currentTrack.duration));

    const seek = () => {
      audio.currentTime = time;
      playbackSecondsRef.current = time;
      setPlaybackSeconds(time);
      lyricManualScrollUntilRef.current = 0;
      scrollLyricIntoPanel(lyricPanelRef.current, activeLyricRef.current);
      scrollLyricIntoPanel(modalLyricPanelRef.current, activeModalLyricRef.current);

      if (shouldContinuePlaying) {
        void audio.play().catch(() => {
          setIsPlaying(false);
          setPlayerError("跳转歌词位置后播放失败，请重新点播放。");
        });
      }
    };

    if (audio.dataset.streamUrl !== nextUrl) {
      audio.addEventListener("loadedmetadata", seek, { once: true });
      syncAudioForSong(currentTrack, false);
      return;
    }

    seek();
  }

  useEffect(() => {
    const cachedDiscoverSongs = loadCachedDiscoverSongs();

    if (cachedDiscoverSongs.length > 0) {
      setResults(cachedDiscoverSongs);
      setPlayQueue(cachedDiscoverSongs);
      setResultSource("discover");
      applyQualityDefaults(cachedDiscoverSongs);
      setMessage(`已先加载缓存推荐 · ${cachedDiscoverSongs.length} 首，正在后台刷新`);
    }

    void loadDiscoverSongs({ keepExisting: cachedDiscoverSongs.length > 0 });
  }, []);

  useEffect(() => {
    function handleWindowClick() {
      setOpenQualityMenuId(null);
      setOpenPlaylistSortMenu(false);
      setAccountMenuOpen(false);
      closeSongContextMenu();
    }

    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, []);

  useEffect(() => {
    if (!openPlaylistSortMenu) {
      setPlaylistSortMenuStyle(null);
      return;
    }

    function handleFloatingSortMenuUpdate() {
      updatePlaylistSortMenuStyle();
    }

    function handleFloatingSortMenuKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenPlaylistSortMenu(false);
      }
    }

    window.addEventListener("resize", handleFloatingSortMenuUpdate);
    window.addEventListener("scroll", handleFloatingSortMenuUpdate, true);
    window.addEventListener("keydown", handleFloatingSortMenuKeydown);

    return () => {
      window.removeEventListener("resize", handleFloatingSortMenuUpdate);
      window.removeEventListener("scroll", handleFloatingSortMenuUpdate, true);
      window.removeEventListener("keydown", handleFloatingSortMenuKeydown);
    };
  }, [openPlaylistSortMenu]);

  useEffect(() => {
    if (!songContextMenu) {
      return;
    }

    function handleDismissContextMenu(event: KeyboardEvent | Event) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") {
        return;
      }

      closeSongContextMenu();
    }

    window.addEventListener("keydown", handleDismissContextMenu);
    window.addEventListener("scroll", handleDismissContextMenu, true);

    return () => {
      window.removeEventListener("keydown", handleDismissContextMenu);
      window.removeEventListener("scroll", handleDismissContextMenu, true);
    };
  }, [songContextMenu]);

  useEffect(() => {
    void refreshSettings().then((nextSettings) => {
      const cookie = nextSettings?.neteaseCookie.trim();
      if (cookie) {
        void ensureNeteaseCookieHealthy({ silent: true, force: true, cookieOverride: cookie });
      }
    });
    void refreshAdminConfig();
    void refreshSession();
    void refreshTasks();
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 1200);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncHistoriesFromDatabase = async () => {
      try {
        const [remoteSearchHistory, remotePlayHistory] = await Promise.all([
          getSearchHistory(),
          getPlayHistory()
        ]);

        if (cancelled) {
          return;
        }

        if (remoteSearchHistory.length > 0) {
          setSearchHistory(remoteSearchHistory);
          window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(remoteSearchHistory));
        } else {
          const localSearchHistory = loadSearchHistory();
          if (localSearchHistory.length > 0) {
            setSearchHistory(localSearchHistory);
            void saveSearchHistory(localSearchHistory);
          }
        }

        if (remotePlayHistory.length > 0) {
          setPlayHistory(remotePlayHistory);
          window.localStorage.setItem(PLAY_HISTORY_STORAGE_KEY, JSON.stringify(remotePlayHistory));
        } else {
          const localPlayHistory = loadPlayHistory();
          if (localPlayHistory.length > 0) {
            setPlayHistory(localPlayHistory);
            void savePlayHistory(localPlayHistory);
          }
        }
      } catch {
        // Keep local fallback data if database sync fails.
      }
    };

    void syncHistoriesFromDatabase();

    return () => {
      cancelled = true;
    };
  }, [session.profile?.id, session.profile?.provider]);

  useEffect(() => {
    let cancelled = false;

    const syncCurrentTrackLiked = async () => {
      if (!currentTrack?.id || !settings.neteaseCookie.trim()) {
        if (!cancelled) {
          setLikedSongIds((current) => current.filter((id) => id !== currentTrack?.id));
        }
        return;
      }

      try {
        const liked = await getSongLiked(currentTrack.id);
        if (cancelled) {
          return;
        }

        setLikedSongIds((current) =>
          liked ? Array.from(new Set([currentTrack.id, ...current])) : current.filter((id) => id !== currentTrack.id)
        );
      } catch {
        // Keep current like state if remote check fails.
      }
    };

    void syncCurrentTrackLiked();

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id, settings.neteaseCookie]);

  useEffect(() => {
    if (!currentTrack?.coverUrl) {
      setPlayerTheme(defaultPlayerTheme);
      return;
    }

    const themeCacheKey = currentTrack.coverUrl;
    const cachedTheme = playerThemeCacheRef.current[themeCacheKey];
    if (cachedTheme) {
      setPlayerTheme(cachedTheme);
      return;
    }

    let cancelled = false;
    const coverImage = new Image();
    coverImage.crossOrigin = "anonymous";
    coverImage.decoding = "async";

    coverImage.onload = () => {
      if (cancelled) {
        return;
      }

      try {
        const nextTheme = buildPlayerThemeFromColor(pickAtmosphereColor(coverImage));
        playerThemeCacheRef.current[themeCacheKey] = nextTheme;
        setPlayerTheme(nextTheme);
      } catch {
        const fallbackTheme = buildFallbackPlayerTheme(`${currentTrack.title}-${currentTrack.artist}-${currentTrack.coverUrl}`);
        playerThemeCacheRef.current[themeCacheKey] = fallbackTheme;
        setPlayerTheme(fallbackTheme);
      }
    };

    coverImage.onerror = () => {
      if (cancelled) {
        return;
      }

      const fallbackTheme = buildFallbackPlayerTheme(`${currentTrack.title}-${currentTrack.artist}-${currentTrack.coverUrl}`);
      playerThemeCacheRef.current[themeCacheKey] = fallbackTheme;
      setPlayerTheme(fallbackTheme);
    };

    coverImage.src = currentTrack.coverUrl;

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.coverUrl, currentTrack?.artist, currentTrack?.title]);

  useEffect(() => {
    let cancelled = false;
    playerStateHydratedRef.current = false;
    setPlayerStateReady(false);

    const syncPlayerStateFromDatabase = async () => {
      try {
        const remotePlayerState = await getPlayerStateRemote();
        if (cancelled) {
          return;
        }

        if (hasPersistedPlayerState(remotePlayerState)) {
          restorePlaybackSecondsRef.current = remotePlayerState.playbackSeconds;
          playbackSecondsRef.current = remotePlayerState.playbackSeconds;
          setCurrentTrack(remotePlayerState.currentTrack);
          setPlayQueue(remotePlayerState.playQueue);
          setPlaybackSeconds(remotePlayerState.playbackSeconds);
          setVolume(remotePlayerState.volume);
          setPlaybackMode(remotePlayerState.playbackMode === "shuffle" ? "shuffle" : "sequential");
          savePlayerStateLocal(remotePlayerState);
        } else {
          const localPlayerState = loadPlayerState();
          if (hasPersistedPlayerState(localPlayerState)) {
            restorePlaybackSecondsRef.current = localPlayerState.playbackSeconds;
            void savePlayerStateRemote(localPlayerState);
          }
        }
      } catch {
        // Keep local fallback player state when database sync fails.
      } finally {
        if (!cancelled) {
          playerStateHydratedRef.current = true;
          setPlayerStateReady(true);
        }
      }
    };

    void syncPlayerStateFromDatabase();

    return () => {
      cancelled = true;
      playerStateHydratedRef.current = false;
      setPlayerStateReady(false);
    };
  }, [session.profile?.id, session.profile?.provider]);

  useEffect(() => {
    if (navKey === "playlists" && playlists.length === 0 && !loadingPlaylists) {
      void loadUserPlaylists();
    }
  }, [navKey]);

  useEffect(() => {
    if (!qrLoginOpen || !qrLoginKey || neteaseLoginMode !== "qr") {
      return;
    }

    let cancelled = false;
    let checking = false;

    const checkLogin = async () => {
      if (checking || cancelled) {
        return;
      }

      checking = true;
      try {
        const result = await checkNeteaseQrLogin(qrLoginKey);
        if (cancelled) {
          return;
        }

        qrCheckFailureCountRef.current = 0;
        setQrLoginMessage(result.message);

        if (result.code === 803) {
          await handleNeteaseLoginSuccess(result.session, "网易云扫码登录成功，Cookie 已自动写入设置。");
          qrCloseTimerRef.current = window.setTimeout(() => {
            if (!cancelled) {
              closeQrLogin();
            }
          }, 650);
          return;
        }

        if (result.code === 800 && !qrAutoRefreshPendingRef.current) {
          qrAutoRefreshPendingRef.current = true;
          void startQrLoginFlow({ autoRefresh: true });
        }
      } catch (error) {
        if (!cancelled) {
          qrCheckFailureCountRef.current += 1;
          const failureMessage = error instanceof Error ? error.message : "二维码状态检查失败";

          if (qrCheckFailureCountRef.current >= 3 && !qrAutoRefreshPendingRef.current) {
            qrAutoRefreshPendingRef.current = true;
            setQrLoginMessage(`状态检查连续失败，正在重新生成二维码…`);
            void startQrLoginFlow({ autoRefresh: true });
          } else {
            setQrLoginMessage(`状态检查异常，正在重试… ${failureMessage}`);
          }
        }
      } finally {
        checking = false;
      }
    };

    void checkLogin();
    const timer = window.setInterval(() => void checkLogin(), 2000);

    return () => {
      cancelled = true;
      if (qrCloseTimerRef.current) {
        window.clearTimeout(qrCloseTimerRef.current);
        qrCloseTimerRef.current = null;
      }
      window.clearInterval(timer);
    };
  }, [qrLoginOpen, qrLoginKey, neteaseLoginMode]);

  useEffect(() => {
    if (!qrLoginOpen || !qrLoginKey || qrLoginExpiresIn <= 0 || neteaseLoginMode !== "qr") {
      return;
    }

    const timer = window.setInterval(() => {
      setQrLoginExpiresIn((current) => {
        const nextValue = Math.max(0, current - 1);
        if (nextValue === 0) {
          if (!qrAutoRefreshPendingRef.current && qrAutoRefreshCountRef.current < 2) {
            qrAutoRefreshPendingRef.current = true;
            setQrLoginMessage("二维码已过期，正在自动刷新…");
            void startQrLoginFlow({ autoRefresh: true });
          } else {
            setQrLoginMessage("二维码已过期，请重新生成。");
            setQrLoginKey("");
          }
        }

        return nextValue;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [qrLoginOpen, qrLoginKey, qrLoginExpiresIn, neteaseLoginMode]);

  useEffect(() => {
    if (!currentTrack) {
      setLyrics([]);
      setLyricsError("");
      lastAutoLyricIndexRef.current = -1;
      lastModalAutoLyricIndexRef.current = -1;
      return;
    }

    lastAutoLyricIndexRef.current = -1;
    lastModalAutoLyricIndexRef.current = -1;
    let cancelled = false;
    setLoadingLyrics(true);
    setLyricsError("");

    getLyrics(currentTrack.id)
      .then((data) => {
        if (!cancelled) {
          setLyrics(data.lines);
          setLyricsError(data.lines.length > 0 ? "" : "这首歌暂时没有返回可用歌词。");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLyrics([]);
          setLyricsError(error instanceof Error ? error.message : "获取歌词失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingLyrics(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!currentTrack) {
      return;
    }

    setCommentTrack((track) => (track?.id === currentTrack.id ? track : currentTrack));
    setCommentPage(1);
    setCommentActionError("");
    setCommentRepliesById({});
    setExpandedCommentIds([]);
    setReplyingCommentId(null);
    setCommentReplyDrafts({});
  }, [currentTrack?.id]);

  useEffect(() => {
    if (rightPanelTab !== "comments" || !commentTrack) {
      return;
    }

    let cancelled = false;
    setLoadingComments(true);
    setCommentsError("");

    getSongComments(commentTrack.id, commentPage, COMMENT_PAGE_SIZE)
      .then((data) => {
        if (!cancelled) {
          setSongComments(data);
          const scrollTop = pendingCommentScrollTopRef.current;
          if (scrollTop !== null) {
            window.requestAnimationFrame(() => {
              if (!cancelled && commentsScrollRef.current) {
                commentsScrollRef.current.scrollTop = scrollTop;
              }
              pendingCommentScrollTopRef.current = null;
            });
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCommentsError(error instanceof Error ? error.message : "获取评论失败");
          pendingCommentScrollTopRef.current = null;
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingComments(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rightPanelTab, commentTrack?.id, commentPage, commentRefreshKey]);

  useEffect(() => {
    if (!userProfileTarget) {
      return;
    }

    const cachedProfile = userProfileCacheRef.current[userProfileTarget.id];
    if (cachedProfile && Date.now() - cachedProfile.cachedAt < USER_PROFILE_CACHE_TTL_MS) {
      setLoadingUserProfile(false);
      return;
    }

    let cancelled = false;
    setLoadingUserProfile(true);
    setUserProfileError("");

    getUserProfile(userProfileTarget.id)
      .then((data) => {
        if (!cancelled) {
          userProfileCacheRef.current[userProfileTarget.id] = {
            profile: data,
            cachedAt: Date.now()
          };
          setUserProfile(data);
        }
      })
      .catch((error) => {
        if (!cancelled && !userProfileCacheRef.current[userProfileTarget.id]) {
          setUserProfileError(error instanceof Error ? error.message : "获取用户信息失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUserProfile(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userProfileTarget?.id]);

  const activeLyricIndex = useMemo(() => {
    if (lyrics.length === 0) {
      return -1;
    }

    let activeIndex = 0;
    for (let index = 0; index < lyrics.length; index += 1) {
      if (lyrics[index].time <= playbackSeconds + 0.15) {
        activeIndex = index;
      } else {
        break;
      }
    }

    return activeIndex;
  }, [lyrics, playbackSeconds]);

  useEffect(() => {
    if (
      rightPanelTab === "lyrics" &&
      activeLyricIndex >= 0 &&
      activeLyricIndex !== lastAutoLyricIndexRef.current &&
      Date.now() > lyricManualScrollUntilRef.current
    ) {
      lastAutoLyricIndexRef.current = activeLyricIndex;
      scrollLyricIntoPanel(lyricPanelRef.current, activeLyricRef.current);
    }
  }, [rightPanelTab, activeLyricIndex, playbackSeconds, lyrics]);

  useEffect(() => {
    if (
      isPlayerExpanded &&
      activeLyricIndex >= 0 &&
      activeLyricIndex !== lastModalAutoLyricIndexRef.current &&
      Date.now() > lyricManualScrollUntilRef.current
    ) {
      lastModalAutoLyricIndexRef.current = activeLyricIndex;
      scrollLyricIntoPanel(modalLyricPanelRef.current, activeModalLyricRef.current);
    }
  }, [isPlayerExpanded, activeLyricIndex, playbackSeconds, lyrics]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsPlayerExpanded(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      if (playerStateSyncTimerRef.current) {
        window.clearTimeout(playerStateSyncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    playbackSecondsRef.current = playbackSeconds;
  }, [playbackSeconds]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    audio.volume = volume / 100;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    const updateBufferedSeconds = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : parseDurationSeconds(currentTrack?.duration ?? "00:00");
      if (!duration || audio.buffered.length === 0) {
        setBufferedSeconds(0);
        return;
      }

      const currentTime = audio.currentTime || playbackSecondsRef.current || 0;
      let nextBufferedSeconds = 0;

      for (let index = 0; index < audio.buffered.length; index += 1) {
        const rangeStart = audio.buffered.start(index);
        const rangeEnd = audio.buffered.end(index);

        if (rangeStart <= currentTime + 0.5 && rangeEnd >= currentTime) {
          nextBufferedSeconds = Math.max(nextBufferedSeconds, rangeEnd);
        } else if (rangeEnd < currentTime) {
          nextBufferedSeconds = Math.max(nextBufferedSeconds, rangeEnd);
        }
      }

      setBufferedSeconds(Math.min(duration, Math.max(0, nextBufferedSeconds)));
    };

    const handleTimeUpdate = () => {
      const nextSeconds = audio.currentTime || 0;
      playbackSecondsRef.current = nextSeconds;
      setPlaybackSeconds(nextSeconds);
      updateBufferedSeconds();
    };

    const handleLoadedMetadata = () => {
      setPlaybackDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      updateBufferedSeconds();
    };

    const handleDurationChange = () => {
      setPlaybackDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      updateBufferedSeconds();
    };

    const handleProgress = () => {
      updateBufferedSeconds();
    };

    const handleEmptied = () => {
      setBufferedSeconds(0);
    };

    const handlePlay = () => {
      setIsPlaying(true);
      setPlayerError("");
      updateBufferedSeconds();
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      const queue = getActivePlaybackQueue();
      const nextSong = getNextSongFromQueue(queue, {
        excludeSongId: currentTrack?.id,
        mode: playbackMode
      });

      if (nextSong) {
        if (accountIsLoggedIn) {
          window.setTimeout(() => syncAudioForSong(nextSong, true), 0);
        }
      }
    };

    const handleError = () => {
      setIsPlaying(false);
      setBufferedSeconds(0);
      setPlayerError("当前歌曲没有成功返回可播放音频，请检查 Cookie 或换一个音质再试。");
    };

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("durationchange", handleDurationChange);
    audio.addEventListener("progress", handleProgress);
    audio.addEventListener("canplay", handleProgress);
    audio.addEventListener("emptied", handleEmptied);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("progress", handleProgress);
      audio.removeEventListener("canplay", handleProgress);
      audio.removeEventListener("emptied", handleEmptied);
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [currentTrack?.id, playbackMode, playQueue, results]);

  useEffect(() => {
    const nextPlayerState: PersistedPlayerState = {
      currentTrack,
      playQueue,
      playbackSeconds,
      volume,
      playbackMode
    };

    savePlayerStateLocal(nextPlayerState);
  }, [currentTrack, playQueue, playbackSeconds, volume, playbackMode]);

  useEffect(() => {
    if (!playerStateReady || !playerStateHydratedRef.current) {
      return;
    }

    const syncedState: PersistedPlayerState = {
      currentTrack,
      playQueue,
      playbackSeconds: Math.floor(Math.max(0, playbackSeconds) / 5) * 5,
      volume,
      playbackMode
    };

    if (playerStateSyncTimerRef.current) {
      window.clearTimeout(playerStateSyncTimerRef.current);
    }

    playerStateSyncTimerRef.current = window.setTimeout(() => {
      void savePlayerStateRemote(syncedState);
      playerStateSyncTimerRef.current = null;
    }, 320);

    return () => {
      if (playerStateSyncTimerRef.current) {
        window.clearTimeout(playerStateSyncTimerRef.current);
        playerStateSyncTimerRef.current = null;
      }
    };
  }, [playerStateReady, currentTrack, playQueue, volume, playbackMode, Math.floor(Math.max(0, playbackSeconds) / 5)]);

  useEffect(() => {
    if (!playerStateReady || !playerStateHydratedRef.current || isPlaying) {
      return;
    }

    const exactState: PersistedPlayerState = {
      currentTrack,
      playQueue,
      playbackSeconds,
      volume,
      playbackMode
    };

    void savePlayerStateRemote(exactState);
  }, [playerStateReady, isPlaying, currentTrack, playQueue, playbackSeconds, volume, playbackMode]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      return;
    }

    if (playbackLocked) {
      audio.pause();
      audio.removeAttribute("src");
      delete audio.dataset.streamUrl;
      audio.load();
      setBufferedSeconds(0);
      setPlaybackDuration(parseDurationSeconds(currentTrack.duration));
      return;
    }

    const nextUrl = getStreamUrl(currentTrack.id, getSelectedLevel(currentTrack), parseDurationSeconds(currentTrack.duration));
    if (audio.dataset.streamUrl === nextUrl) {
      return;
    }

    audio.pause();
    audio.src = nextUrl;
    audio.dataset.streamUrl = nextUrl;
    audio.load();
    setBufferedSeconds(0);
    setPlaybackDuration(parseDurationSeconds(currentTrack.duration));

    const restoreTime = restorePlaybackSecondsRef.current;
    if (restoreTime > 0) {
      const handleRestoreSeek = () => {
        const boundedTime = Math.min(restoreTime, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : restoreTime);
        audio.currentTime = boundedTime;
        playbackSecondsRef.current = boundedTime;
        setPlaybackSeconds(boundedTime);
        restorePlaybackSecondsRef.current = 0;
      };

      audio.addEventListener("loadedmetadata", handleRestoreSeek, { once: true });
    }
  }, [currentTrack?.id, playbackLocked]);

  const activeCount = useMemo(
    () => tasks.filter((task) => task.status === "queued" || task.status === "downloading" || task.status === "preparing").length,
    [tasks]
  );
  const completedCount = useMemo(() => tasks.filter((task) => task.status === "done").length, [tasks]);
  const failedCount = useMemo(() => tasks.filter((task) => task.status === "failed").length, [tasks]);
  const visibleSongs = useMemo(() => {
    const sourceSongs = resultSource === "playlist" || resultSource === "cloud" || resultSource === "daily" || resultSource === "discover" || resultSource === "artist" || resultSource === "album"
      ? results
      : results.slice(0, 30);

    if (resultSource !== "playlist" || playlistSortMode === "default") {
      return sourceSongs;
    }

    const compareText = (left: string, right: string) => left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
    const sortedSongs = [...sourceSongs];

    sortedSongs.sort((left, right) => {
      switch (playlistSortMode) {
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
  }, [results, navKey, resultSource, playlistSortMode]);
  const selectedVisibleSongs = useMemo(
    () => visibleSongs.filter((song) => selectedSongIds.includes(song.id)),
    [visibleSongs, selectedSongIds]
  );
  const allVisibleSelected = visibleSongs.length > 0 && selectedVisibleSongs.length === visibleSongs.length;
  const createdPlaylists = useMemo(() => playlists.filter((playlist) => playlist.owned), [playlists]);
  const availablePlaylistPickerPlaylists = useMemo(
    () => createdPlaylists.filter((playlist) => playlist.id !== playlistPickerSourcePlaylistId),
    [createdPlaylists, playlistPickerSourcePlaylistId]
  );
  const collectedPlaylists = useMemo(() => playlists.filter((playlist) => !playlist.owned), [playlists]);
  const playlistTotalPages = useMemo(
    () => {
      if (!activePlaylist) {
        return 1;
      }

      const totalSongs = playlistSearchKeyword ? playlistSongsTotal : activePlaylist.trackCount;
      return Math.max(1, Math.ceil(totalSongs / playlistSongsLimit));
    },
    [activePlaylist, playlistSongsLimit, playlistSongsTotal, playlistSearchKeyword]
  );
  const playbackRatio = playbackDuration > 0 ? Math.min(100, (playbackSeconds / playbackDuration) * 100) : 0;
  const bufferedRatio = playbackDuration > 0 ? Math.min(100, (Math.max(bufferedSeconds, playbackSeconds) / playbackDuration) * 100) : 0;
  const playbackRangeStyle = { "--range-fill": `${playbackRatio}%`, "--range-buffer": `${bufferedRatio}%` } as CSSProperties;
  const volumeRangeStyle = { "--range-fill": `${volume}%` } as CSSProperties;
  const playerThemeStyle = useMemo<PlayerThemeStyle>(
    () => ({
      "--player-theme-base": playerTheme.base,
      "--player-theme-panel": playerTheme.panel,
      "--player-theme-soft": playerTheme.soft,
      "--player-theme-glow": playerTheme.glow,
      "--player-theme-accent": playerTheme.accent,
      "--player-cover-image": currentTrack?.coverUrl ? `url("${currentTrack.coverUrl}")` : "none"
    }),
    [currentTrack?.coverUrl, playerTheme]
  );
  const activeMeta = navText[navKey];
  const contentMeta =
    mainTab === "settings"
      ? { title: "设置", subtitle: "偏好配置中心" }
      : navKey === "artist" && activeArtist
        ? { title: "歌手", subtitle: activeArtist.name }
        : navKey === "album" && activeAlbum
          ? { title: "专辑", subtitle: activeAlbum.name }
          : navKey === "playlists" && resultSource === "playlist" && activePlaylist
            ? { title: activePlaylist.owned ? "我的歌单" : "歌单", subtitle: activePlaylist.name }
        : activeMeta;
  const currentQualityLabel = currentTrack ? getSelectedLabel(currentTrack) : "128K";
  const isDiscoverListView = mainTab === "search" && navKey === "discover" && resultSource === "discover";
  const isPlaylistSongsView = mainTab === "search" && navKey === "playlists" && resultSource === "playlist" && Boolean(activePlaylist);
  const canGoBackFromCurrentView = viewHistory.length > 0 || isPlaylistSongsView;
  const showAdminFallbackControls = false;
  const listHeaderMeta =
    isDiscoverListView
      ? { count: `推荐新歌 · ${results.length} 首`, note: "来自网易云推荐新歌", action: loadingDiscoverSongs ? "加载中" : "刷新推荐", disabled: loadingDiscoverSongs, onClick: loadDiscoverSongs }
      : null;
  const resultListLoading =
    navKey === "discover"
      ? loadingDiscoverSongs
      : navKey === "cloud"
        ? loadingCloudSongs
        : navKey === "daily"
          ? loadingDailySongs
          : navKey === "playlists" && resultSource === "playlist"
            ? loadingPlaylistSongs
            : loadingArtist;
  const resultLoadingMessage =
    navKey === "discover"
      ? "正在加载发现音乐..."
      : navKey === "cloud"
        ? "正在读取云盘音乐..."
        : navKey === "daily"
          ? "正在读取每日推荐..."
          : navKey === "playlists" && resultSource === "playlist"
            ? "正在读取歌单歌曲..."
            : "正在读取歌手热门歌曲...";
  const resultEmptyMessage =
    navKey === "discover"
      ? "暂时没有推荐歌曲，请稍后刷新。"
      : navKey === "cloud"
        ? "云盘里暂时没有读取到歌曲，或 Cookie 权限不足。"
        : navKey === "daily"
          ? "暂时没有读取到每日推荐，请确认 Cookie 登录态有效。"
          : navKey === "playlists" && resultSource === "playlist"
            ? "当前歌单没有读取到歌曲。"
            : "暂时没有读取到该歌手的热门歌曲。";
  const hasReadableLyrics = Boolean(currentTrack && !loadingLyrics && !lyricsError && lyrics.length > 0);
  const shouldShowLyricsAtmosphere = Boolean(currentTrack?.coverUrl && (loadingLyrics || hasReadableLyrics));
  const activeSongComments = songComments?.songId === commentTrack?.id ? songComments : null;
  const commentTotalLabel = activeSongComments?.total ? (activeSongComments.total > 999 ? "999+" : String(activeSongComments.total)) : "";
  const commentContextLabel =
    commentTrack && currentTrack?.id !== commentTrack.id
      ? `${commentTrack.title} · ${commentTrack.artist}`
      : "当前播放歌曲";
  const userProfileDisplay = userProfile ?? null;
  const userProfileName = userProfileDisplay?.nickname ?? userProfileTarget?.fallbackName ?? "网易云用户";
  const userProfileAvatarUrl = userProfileDisplay?.avatarUrl ?? userProfileTarget?.fallbackAvatarUrl;
  const userProfileOwnedPlaylists = userProfileDisplay?.playlists.filter((playlist) => playlist.owned) ?? [];
  const userProfileCollectedPlaylists = userProfileDisplay?.playlists.filter((playlist) => !playlist.owned) ?? [];
  const userProfilePlaylistGroups = [
    { key: "owned", title: "创建的歌单", playlists: userProfileOwnedPlaylists },
    { key: "collected", title: "收藏的歌单", playlists: userProfileCollectedPlaylists }
  ].filter((group) => group.playlists.length > 0);
  const isUserProfileHome = userProfileView === "profile";
  const userProfileSubTitle = userProfileView === "events" ? "动态" : userProfileView === "followeds" ? "粉丝" : "关注";
  const userProfileSubCount =
    userProfileView === "events"
      ? `${formatCompactCount(userEventsPage?.events.length ?? userProfileDisplay?.eventCount ?? 0)} 条`
      : userProfileView === "followeds"
        ? `${formatCompactCount(userSocialPage?.total ?? userProfileDisplay?.followeds ?? 0)} 人`
        : `${formatCompactCount(userSocialPage?.total ?? userProfileDisplay?.follows ?? 0)} 人`;

  const renderCommentRow = (comment: SongComment, keyPrefix = "", options: { isReply?: boolean } = {}) => {
    const isReply = Boolean(options.isReply);
    const likeBusy = commentLikeActionIds.includes(comment.id);
    const repliesBusy = loadingCommentReplyIds.includes(comment.id);
    const isReplying = replyingCommentId === comment.id;
    const postingReply = postingCommentId === comment.id;
    const repliesPage = commentRepliesById[comment.id];
    const isExpanded = expandedCommentIds.includes(comment.id);
    const replyDraft = commentReplyDrafts[comment.id] ?? "";
    const visibleReplyCount = Math.max(comment.replyCount, repliesPage?.total ?? 0);

    return (
      <article key={`${keyPrefix}${comment.id}`} className={isReply ? "comment-row comment-row-reply" : "comment-row"}>
        <button
          type="button"
          className="comment-author"
          onClick={() => openUserProfile({ id: comment.userId, fallbackName: comment.nickname, fallbackAvatarUrl: comment.avatarUrl })}
          title={`查看 ${comment.nickname} 的资料`}
        >
          {comment.avatarUrl ? <img src={comment.avatarUrl} alt="" className="comment-avatar" loading="lazy" /> : <span className="comment-avatar placeholder">{comment.nickname.slice(0, 1)}</span>}
        </button>
        <div className="comment-copy">
          <div className="comment-meta">
            <button
              type="button"
              className="comment-name-button"
              onClick={() => openUserProfile({ id: comment.userId, fallbackName: comment.nickname, fallbackAvatarUrl: comment.avatarUrl })}
            >
              {comment.nickname}
            </button>
            <span>{comment.timeText}</span>
          </div>
          <p className="comment-content">{renderCommentContent(comment.content)}</p>
          {comment.replyContent ? <p className="comment-reply">{renderCommentContent(comment.replyContent)}</p> : null}
          <div className="comment-actions">
            <button
              type="button"
              className={comment.liked ? "comment-action active" : "comment-action"}
              disabled={likeBusy || !accountIsLoggedIn}
              onClick={() => void handleToggleCommentLike(comment)}
              title={accountIsLoggedIn ? (comment.liked ? "取消点赞" : "点赞评论") : "登录后点赞评论"}
            >
              <span>{likeBusy ? "..." : comment.liked ? "已赞" : "赞"}</span>
              {comment.likedCount > 0 ? <strong>{comment.likedCount}</strong> : null}
            </button>
            <button
              type="button"
              className={isReplying ? "comment-action active" : "comment-action"}
              disabled={!accountIsLoggedIn}
              onClick={() => {
                setCommentActionError("");
                setReplyingCommentId(isReplying ? null : comment.id);
              }}
              title={accountIsLoggedIn ? "回复评论" : "登录后回复评论"}
            >
              回复
            </button>
            {!isReply && visibleReplyCount > 0 ? (
              <button type="button" className="comment-action comment-thread-toggle" disabled={repliesBusy} onClick={() => handleToggleCommentReplies(comment)}>
                {repliesBusy ? "读取中..." : isExpanded ? "收起回复" : `查看 ${visibleReplyCount} 条回复`}
              </button>
            ) : null}
          </div>

          {isReplying ? (
            <form
              className="comment-reply-form"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                void handleSubmitCommentReply(comment);
              }}
            >
              <textarea
                value={replyDraft}
                onChange={(event) => setCommentReplyDrafts((current) => ({ ...current, [comment.id]: event.target.value }))}
                placeholder={`回复 ${comment.nickname}`}
                maxLength={140}
              />
              <div className="comment-reply-footer">
                <span>{replyDraft.trim().length}/140</span>
                <div>
                  <button type="button" disabled={postingReply} onClick={() => setReplyingCommentId(null)}>
                    取消
                  </button>
                  <button type="submit" disabled={postingReply || !replyDraft.trim()}>
                    {postingReply ? "发送中..." : "发送"}
                  </button>
                </div>
              </div>
            </form>
          ) : null}

          {!isReply && isExpanded ? (
            <div className="comment-thread">
              {!repliesPage && repliesBusy ? <div className="comment-thread-empty">正在读取回复...</div> : null}
              {repliesPage && repliesPage.replies.length === 0 ? <div className="comment-thread-empty">暂时没有读取到楼中楼回复。</div> : null}
              {repliesPage?.replies.map((reply) => renderCommentRow(reply, `reply-${comment.id}-`, { isReply: true }))}
              {repliesPage?.hasMore ? (
                <button type="button" className="comment-thread-more" disabled={repliesBusy} onClick={() => void loadCommentReplies(comment, true)}>
                  {repliesBusy ? "读取中..." : "继续加载回复"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  };

  const renderUserEventCard = (event: UserEventItem) => {
    const resourceLabel = formatUserEventResourceType(event.resource);

    return (
      <article key={event.id} className="user-event-card">
        <header className="user-event-head">
          <button
            type="button"
            className="user-event-author"
            onClick={() => openUserProfile({ id: event.userId, fallbackName: event.nickname, fallbackAvatarUrl: event.avatarUrl })}
          >
            <span className="user-event-avatar">
              {event.avatarUrl ? <img src={event.avatarUrl} alt="" loading="lazy" /> : event.nickname.slice(0, 1)}
            </span>
            <span>
              <strong>{event.nickname}</strong>
              <small>{event.timeText} · {formatUserEventType(event.type)}</small>
            </span>
          </button>
        </header>

        <p className="user-event-text">{renderCommentContent(event.text)}</p>

        {event.pics.length > 0 ? (
          <div className={event.pics.length === 1 ? "user-event-pics single" : "user-event-pics"}>
            {event.pics.slice(0, 9).map((picUrl, index) => (
              <img key={`${event.id}-pic-${index}`} src={picUrl} alt="" loading="lazy" />
            ))}
          </div>
        ) : null}

        {event.resource ? (
          <button
            type="button"
            className="user-event-resource"
            onClick={() => openUserEventResource(event)}
            title={event.resource.type === "playlist" || event.resource.type === "album" ? `打开${resourceLabel}：${event.resource.title}` : event.resource.title}
          >
            <span className="user-event-resource-cover">
              {event.resource.coverUrl ? <img src={event.resource.coverUrl} alt="" loading="lazy" /> : <MusicGlyph />}
            </span>
            <span className="user-event-resource-copy">
              <em>{resourceLabel}</em>
              <strong>{event.resource.title}</strong>
              {event.resource.subtitle ? <small>{event.resource.subtitle}</small> : null}
            </span>
          </button>
        ) : null}

        <footer className="user-event-stats">
          <span>赞 {formatCompactCount(event.likedCount)}</span>
          <span>评论 {formatCompactCount(event.commentCount)}</span>
          <span>分享 {formatCompactCount(event.shareCount)}</span>
        </footer>
      </article>
    );
  };

  const renderArtistMeta = (song: Song) => {
    const artists = getSongArtists(song);

    return artists.length > 0 ? (
      <div className="artist-link-group">
        {artists.map((artist, index) => (
          <button
            key={`${song.id}-${artist.id ?? artist.name}-${index}`}
            type="button"
            className="artist-link-button"
            onClick={(event) => {
              event.stopPropagation();
              void handleOpenArtist(song, artist);
            }}
          >
            {artist.name}
          </button>
        ))}
      </div>
    ) : (
      <button
        type="button"
        className="artist-link-button"
        onClick={(event) => {
          event.stopPropagation();
          void handleOpenArtist(song);
        }}
      >
        {song.artist}
      </button>
    );
  };

  const renderAlbumMeta = (song: Song) => (
    <button
      type="button"
      className="album-link-button"
      onClick={(event) => {
        event.stopPropagation();
        void handleOpenAlbum(song);
      }}
    >
      {song.album}
    </button>
  );

  function handleSelectQuality(song: Song, level: DownloadQualityLevel) {
    const isCurrentTrack = currentTrack?.id === song.id;
    const audio = audioRef.current;
    const resumeSeconds = isCurrentTrack
      ? Math.max(0, audio?.currentTime || playbackSecondsRef.current || playbackSeconds || 0)
      : 0;
    const shouldResumePlayback = isCurrentTrack && Boolean(audio && !audio.paused);

    setQualitySelections((current) => ({
      ...current,
      [song.id]: level
    }));
    setQualitySelectionTouched((current) => ({
      ...current,
      [song.id]: true
    }));
    setOpenQualityMenuId(null);

    if (accountIsLoggedIn && isCurrentTrack) {
      window.setTimeout(() => {
        syncAudioForSong(song, shouldResumePlayback, { level, startAtSeconds: resumeSeconds });
      }, 0);
    }
  }

  function renderQualitySelect(
    song: Song,
    options: { menuKey?: string; className?: string; triggerClassName?: string; ariaLabel?: string } = {}
  ) {
    const menuKey = options.menuKey ?? song.id;
    const isOpen = openQualityMenuId === menuKey;

    return (
      <div className={["quality-select", options.className].filter(Boolean).join(" ")} onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={["quality-trigger", options.triggerClassName].filter(Boolean).join(" ")}
          aria-expanded={isOpen}
          aria-label={options.ariaLabel ?? `选择 ${song.title} 的音质`}
          onClick={(event) => {
            event.stopPropagation();
            setOpenQualityMenuId((current) => (current === menuKey ? null : menuKey));
          }}
        >
          <span>{getSelectedLabel(song)}</span>
          <span className={isOpen ? "quality-caret open" : "quality-caret"}>
            <ChevronIcon />
          </span>
        </button>

        {isOpen ? (
          <div className="quality-menu" onClick={(event) => event.stopPropagation()}>
            {song.availableQualities.map((quality) => {
              const isActive = quality.level === getSelectedLevel(song);

              return (
                <button
                  key={quality.level}
                  type="button"
                  className={isActive ? "quality-option active" : "quality-option"}
                  onClick={() => handleSelectQuality(song, quality.level)}
                >
                  {quality.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  const renderPlaylistCard = (playlist: UserPlaylist) => {
    const isLoadingThisPlaylist = loadingPlaylistSongs && selectedPlaylistId === playlist.id;
    const isActivePlaylist = selectedPlaylistId === playlist.id;

    return (
      <button
        key={playlist.id}
        type="button"
        className={isActivePlaylist ? "playlist-card active" : "playlist-card"}
        disabled={isLoadingThisPlaylist}
        onClick={() => void loadPlaylistSongs(playlist, 1, "")}
        title={`打开歌单：${playlist.name}`}
      >
        <CoverArt
          song={{
            id: playlist.id,
            title: playlist.name,
            artist: playlist.creatorName,
            album: "歌单",
            coverUrl: playlist.coverUrl,
            duration: "00:00",
            quality: "歌单",
            availableQualities: [{ level: "standard", label: "128K" }],
            source: "netease"
          }}
          className="playlist-cover"
        />
        <div className="playlist-copy">
          <strong>{playlist.name}</strong>
          <span>{playlist.owned ? "我创建" : playlist.creatorName}</span>
          <p>{playlist.trackCount} 首 · 播放 {playlist.playCount.toLocaleString()}</p>
        </div>
        <span className="playlist-card-action">{isLoadingThisPlaylist ? "载入中" : isActivePlaylist ? "当前" : "进入"}</span>
      </button>
    );
  };

  function seekPlayback(nextTime: number) {
    const audio = audioRef.current;
    playbackSecondsRef.current = nextTime;
    setPlaybackSeconds(nextTime);
    if (audio) {
      audio.currentTime = nextTime;
    }
  }

  function renderPlayerBar(mode: "dock" | "modal") {
    const isModalBar = mode === "modal";
    const playerBarClass = `player-bar ${isModalBar ? "player-bar-modal player-modal-controls" : "player-bar-dock player-dock"}`;
    const trackCover = <CoverArt song={currentTrack} className="dock-cover player-bar-cover" />;

    return (
      <footer className={playerBarClass}>
        <div className="dock-track player-bar-track">
          {isModalBar ? (
            <div className="dock-cover-button player-bar-cover-frame" aria-hidden="true">
              {trackCover}
            </div>
          ) : (
            <button type="button" className="dock-cover-button player-bar-cover-frame" aria-label="打开全屏播放器" onClick={() => setIsPlayerExpanded(true)}>
              {trackCover}
            </button>
          )}
          <div className="dock-copy player-bar-copy">
            <strong>{currentTrack?.title ?? "等待选择歌曲"}</strong>
            <p>{currentTrack ? `${currentTrack.artist} · ${currentTrack.album}` : "先点一首歌，再试听或直接播放。"}</p>
          </div>
          <div className="player-bar-actions">
            <button
              type="button"
              className={currentTrack && likedSongIds.includes(currentTrack.id) ? "dock-like active" : "dock-like"}
              aria-label={currentTrack && likedSongIds.includes(currentTrack.id) ? "取消喜欢当前歌曲" : "喜欢当前歌曲"}
              title={currentTrack && likedSongIds.includes(currentTrack.id) ? "取消喜欢" : "喜欢"}
              disabled={!currentTrack || togglingLike}
              onClick={() => void handleToggleCurrentTrackLike()}
            >
              <PlayerIcon name="heart" />
            </button>
            <button
              type="button"
              className={!accountIsLoggedIn ? "dock-like dock-playlist-add locked-download-button" : "dock-like dock-playlist-add"}
              aria-label={currentTrack ? `收藏 ${currentTrack.title} 到歌单` : "收藏当前歌曲到歌单"}
              title={!accountIsLoggedIn ? "登录后收藏到歌单" : "收藏到歌单"}
              disabled={!currentTrack || Boolean(addingToPlaylistId)}
              onClick={() => currentTrack ? void handleOpenPlaylistPicker(currentTrack) : undefined}
            >
              <PlaylistAddIcon />
              {!accountIsLoggedIn ? <span className="download-lock-badge"><LockIcon /></span> : null}
            </button>
          </div>
        </div>

        <div className="dock-controls player-bar-controls">
          <div className="control-buttons">
            <button type="button" className={playbackMode === "shuffle" ? "dock-icon mode-active" : "dock-icon"} aria-label={playbackMode === "shuffle" ? "关闭随机播放" : "开启随机播放"} title={playbackMode === "shuffle" ? "随机播放已开启" : "开启随机播放"} onClick={handleTogglePlaybackMode}><PlayerIcon name="shuffle" /></button>
            <button type="button" className={playbackLocked ? "dock-icon locked-playback-button" : "dock-icon"} aria-label={playbackLocked ? "登录后上一首" : "上一首"} title={playbackLocked ? "登录后播放" : "上一首"} disabled={playbackLocked || !currentTrack} onClick={handleReplay}><PlayerIcon name="previous" /></button>
            <button type="button" className={playbackLocked ? "dock-icon primary locked-playback-button" : "dock-icon primary"} onClick={handleTogglePlayback} disabled={playbackLocked || (!currentTrack && !hasPlaybackQueue)} aria-label={playbackLocked ? "登录后播放" : isPlaying ? "暂停" : "播放"} title={playbackLocked ? "登录后播放" : isPlaying ? "暂停" : "播放"}>{playbackLocked ? <LockIcon /> : <PlayerIcon name={isPlaying ? "pause" : "play"} />}</button>
            <button type="button" className={playbackLocked ? "dock-icon locked-playback-button" : "dock-icon"} aria-label={playbackLocked ? "登录后下一首" : "下一首"} title={playbackLocked ? "登录后播放" : "下一首"} disabled={playbackLocked || !hasPlaybackQueue} onClick={handleNextTrack}><PlayerIcon name="next" /></button>
          </div>

          <div className="dock-progress player-bar-progress">
            <span>{formatPlaybackTime(playbackSeconds)}</span>
            <input
              className="range-progress"
              style={playbackRangeStyle}
              type="range"
              min="0"
              max={Math.max(playbackDuration, 1)}
              step="1"
              title={`已缓冲到 ${formatPlaybackTime(bufferedSeconds)}`}
              value={Math.min(playbackSeconds, Math.max(playbackDuration, 1))}
              onChange={(event) => seekPlayback(Number(event.target.value))}
            />
            <span>{formatPlaybackTime(playbackDuration || parseDurationSeconds(currentTrack?.duration ?? "00:00"))}</span>
          </div>
        </div>

        <div className="dock-volume player-bar-tools">
          <button
            type="button"
            className={!hasNeteaseDownloadAuth ? "dock-queue-button player-download-button locked-download-button" : "dock-queue-button player-download-button"}
            onClick={() => currentTrack ? void handleDownload(currentTrack) : undefined}
            aria-label={!hasNeteaseDownloadAuth ? "登录后下载当前歌曲" : currentTrack ? `下载 ${currentTrack.title}` : "下载当前歌曲"}
            title={!hasNeteaseDownloadAuth ? "登录后下载" : directDownloadingSongId === currentTrack?.id ? "正在下载" : "下载当前歌曲"}
            disabled={!currentTrack || Boolean(directDownloadingSongId || batchDownloading)}
          >
            <DownloadIcon />
            {!hasNeteaseDownloadAuth ? <span className="download-lock-badge"><LockIcon /></span> : null}
          </button>
          <button type="button" className="dock-queue-button" onClick={() => setIsPlayerExpanded(true)} aria-label="打开全屏播放器"><PlayerIcon name="queue" /></button>
          {currentTrack ? (
            renderQualitySelect(currentTrack, {
              menuKey: `${mode}:${currentTrack.id}`,
              className: "dock-quality-select",
              triggerClassName: "dock-quality-trigger",
              ariaLabel: `选择当前播放音质，当前 ${currentQualityLabel}`
            })
          ) : (
            <div className="quality-select dock-quality-select">
              <button type="button" className="quality-trigger dock-quality-trigger" disabled aria-label="未选择歌曲，无法选择音质">
                <span>--</span>
                <span className="quality-caret">
                  <ChevronIcon />
                </span>
              </button>
            </div>
          )}
          <PlayerIcon name="volume" />
          <input className="range-progress" style={volumeRangeStyle} type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
          <strong>{volume}</strong>
        </div>
      </footer>
    );
  }

  const getTransferStatusLabel = (status: PlaylistTransferJob["tracks"][number]["status"]) => {
    switch (status) {
      case "matched":
        return "已匹配";
      case "manual_review":
        return "待确认";
      case "not_found":
        return "未找到";
      case "copyright_unavailable":
        return "版权不可用";
      case "vip_only":
        return "会员限制";
      case "trial_only":
        return "仅试听";
      case "duplicate":
        return "重复";
      case "metadata_conflict":
        return "信息冲突";
      case "skipped":
        return "已跳过";
    }
  };

  const getNeteaseAuditStatusLabel = (status: NeteaseImportAuditStatus) => {
    switch (status) {
      case "replaceable":
        return "可替代";
      case "needs_review":
        return "待确认";
      case "unusable":
        return "暂无替代";
    }
  };

  const getTransferRunJobStatusLabel = (job: PlaylistTransferRunJob) => {
    switch (job.progress.phase) {
      case "queued":
        return "排队中";
      case "loading":
        return "读取来源歌单";
      case "matching":
        return "匹配中";
      case "saving":
        return "保存结果";
      case "completed":
        return "已完成";
      case "failed":
        return "失败";
    }
  };

  const getNeteaseAuditJobStatusLabel = (job: NeteaseImportAuditJob) => {
    if (job.status === "cancelling") {
      return "取消中";
    }

    switch (job.progress.phase) {
      case "queued":
        return "排队中";
      case "loading":
        return "读取歌单";
      case "scanning":
        return "扫描中";
      case "completed":
        return "已完成";
      case "failed":
        return "失败";
      case "cancelled":
        return "已取消";
    }
  };

  const getPlaylistCompareJobStatusLabel = (job: PlaylistCompareJob) => {
    switch (job.progress.phase) {
      case "queued":
        return "排队中";
      case "loading":
        return "读取左右歌单";
      case "comparing":
        return "对比中";
      case "completed":
        return "已完成";
      case "failed":
        return "失败";
    }
  };

  const transferRunProgress = transferRunJob?.progress;
  const transferRunProgressTotal = Math.max(1, transferRunProgress?.total ?? 0);
  const transferRunProgressPercent = transferRunProgress
    ? Math.min(100, Math.round((transferRunProgress.processed / transferRunProgressTotal) * 100))
    : 0;
  const neteaseAuditProgress = neteaseImportAuditJob?.progress;
  const neteaseAuditProgressTotal = Math.max(1, neteaseAuditProgress?.total ?? neteaseAuditMaxTracks);
  const neteaseAuditProgressPercent = neteaseAuditProgress
    ? Math.min(100, Math.round((neteaseAuditProgress.scanned / neteaseAuditProgressTotal) * 100))
    : 0;
  const canCancelNeteaseAudit = neteaseImportAuditJob
    ? neteaseImportAuditJob.status === "queued" || neteaseImportAuditJob.status === "loading" || neteaseImportAuditJob.status === "running"
    : false;
  const canExportNeteaseAudit = neteaseImportAuditJob?.status === "completed" && Boolean(neteaseImportAudit);
  const canCreateNeteaseAuditPlayablePlaylist = canExportNeteaseAudit && (neteaseImportAudit?.summary.playable ?? 0) > 0;
  const playlistCompareProgress = playlistCompareJob?.progress;
  const playlistCompareProgressTotal = Math.max(1, playlistCompareProgress?.total ?? 0);
  const playlistCompareProgressPercent = playlistCompareProgress
    ? Math.min(100, Math.round((playlistCompareProgress.processed / playlistCompareProgressTotal) * 100))
    : 0;

  const getPlaylistCompareStatusLabel = (status: PlaylistCompareStatus) => {
    switch (status) {
      case "exact":
        return "完全一样";
      case "same_title_different_artist":
        return "歌名同歌手不同";
      case "similar_title":
        return "歌名相似";
      case "left_only":
        return "仅左侧";
      case "right_only":
        return "仅右侧";
    }
  };

  return (
    <div className="app-shell" style={playerThemeStyle}>
      <audio ref={audioRef} preload="none" />

      <main className="app-layout">
        <aside className="sidebar">
            <div className="brand-block">
              <div className="brand-mark" aria-hidden="true">
                <VaultGlyph />
              </div>
              <div className="brand-copy">
                <strong>TrackVault</strong>
              </div>
            </div>

          <div className="identity-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="identity-card"
              onClick={() => {
                if (accountIsLoggedIn) {
                  setAccountMenuOpen((current) => !current);
                  return;
                }

                void handleStartQrLogin();
              }}
            >
              {accountAvatarUrl ? (
                <img className="identity-avatar" src={accountAvatarUrl} alt={accountDisplayName} />
              ) : (
                <div className="identity-avatar">{accountDisplayName.slice(0, 1)}</div>
              )}
              <div className="identity-copy">
                <strong>{accountDisplayName}</strong>
                <span className={accountVipEnabled ? "identity-status active" : "identity-status"}>
                  {accountStatusLabel}
                </span>
              </div>
            </button>

            {accountIsLoggedIn && accountMenuOpen ? (
              <div className="identity-popover" role="menu" aria-label="账号操作">
                <p className="identity-popover-note">VIP 到期: 2026-07-28</p>
                <button type="button" role="menuitem" onClick={openMyUserProfile}>
                  <span aria-hidden="true">i</span>
                  个人信息
                </button>
                <button type="button" role="menuitem" onClick={() => void handleStartQrLogin()}>
                  <span aria-hidden="true">⌁</span>
                  切换账号
                </button>
                <button type="button" role="menuitem" className="danger" onClick={() => void handleClearCookie()}>
                  <span aria-hidden="true">↩</span>
                  退出登录
                </button>
              </div>
            ) : null}
          </div>

          <div className="sidebar-group">
            <span className="group-label">导航</span>
            <nav className="nav-list">
              <button type="button" className={mainTab === "search" && navKey === "discover" ? "nav-button active" : "nav-button"} onClick={() => void loadDiscoverSongs()}>
                发现音乐
              </button>
              <button type="button" className={mainTab === "search" && navKey === "search" ? "nav-button active" : "nav-button"} onClick={openSearchPage}>
                搜索
              </button>
              <button type="button" className={mainTab === "search" && navKey === "daily" ? "nav-button active" : "nav-button"} onClick={() => void loadDailySongs()}>
                每日推荐
              </button>
              <button type="button" className={mainTab === "search" && navKey === "playlists" ? "nav-button active" : "nav-button"} onClick={openPlaylistsPage}>
                我的歌单
              </button>
              <button type="button" className={mainTab === "search" && navKey === "transfer" ? "nav-button active" : "nav-button"} onClick={openTransferPage}>
                歌单互转
              </button>
              <button type="button" className={mainTab === "search" && navKey === "cloud" ? "nav-button active" : "nav-button"} onClick={() => void loadCloudSongs()}>
                云盘音乐
              </button>
              <button type="button" className={mainTab === "search" && navKey === "downloads" ? "nav-button active" : "nav-button"} onClick={() => navigateTo("downloads")}>
                下载管理
              </button>
              <button type="button" className={mainTab === "search" && navKey === "history" ? "nav-button active" : "nav-button"} onClick={() => navigateTo("history")}>
                播放历史
              </button>
              <button type="button" className={mainTab === "settings" ? "nav-button active" : "nav-button"} onClick={() => navigateTo(navKey, "settings")}>
                设置
              </button>
            </nav>
          </div>
        </aside>

        <section className="content-panel">
          <header className="content-header">
            <div className={canGoBackFromCurrentView ? "content-titlebar has-back" : "content-titlebar"}>
              {canGoBackFromCurrentView ? (
                <button type="button" className="back-button" onClick={isPlaylistSongsView ? openPlaylistsPage : goBackView} aria-label={isPlaylistSongsView ? "返回我的歌单" : "返回上一个界面"}>
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="M14.8 6.4 9.2 12l5.6 5.6" />
                  </svg>
                </button>
              ) : null}
              <div className="content-titlecopy">
                <p className="eyebrow">{contentMeta.title}</p>
                <h1>{contentMeta.subtitle}</h1>
              </div>
            </div>
            {mainTab === "search" && listHeaderMeta ? (
              <div className="content-actions">
                <div className="content-summary">
                  <strong>{listHeaderMeta.count}</strong>
                  <span>{listHeaderMeta.note}</span>
                </div>
                <button type="button" className="secondary-button" disabled={listHeaderMeta.disabled} onClick={() => void listHeaderMeta.onClick()}>
                  {listHeaderMeta.action}
                </button>
              </div>
            ) : null}
          </header>

          {mainTab === "search" && navKey === "transfer" ? (
            <section className="transfer-workspace">
              <div className="settings-grid">
                <section className="settings-card">
                  <span>来源与目标</span>
                  <p>选择一个来源歌单或粘贴文字歌单，系统会在目标平台搜索匹配并生成缺失/版权报告。</p>
                  <div className="transfer-grid">
                    <label>
                      <span>来源</span>
                      <select value={transferSourceProvider} onChange={(event) => setTransferSourceProvider(event.target.value as TransferSourceProvider)}>
                        <option value="netease">网易云歌单</option>
                        <option value="qq">QQ 音乐公开歌单</option>
                        <option value="text">文字歌单</option>
                        <option value="csv">CSV</option>
                      </select>
                    </label>
                    <label>
                      <span>目标</span>
                      <select value={transferTargetProvider} onChange={(event) => setTransferTargetProvider(event.target.value as TransferTargetProvider)}>
                        <option value="qq">QQ 音乐匹配报告</option>
                        <option value="netease">网易云匹配报告</option>
                        <option value="text">仅导出文字歌单</option>
                      </select>
                    </label>
                  </div>

                  {transferSourceProvider === "netease" ? (
                    <div className="transfer-grid">
                      <label>
                        <span>网易云来源歌单</span>
                        <select value={transferPlaylistId} onChange={(event) => setTransferPlaylistId(event.target.value)}>
                          <option value="">选择歌单</option>
                          {playlists.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>
                              {playlist.name} · {playlist.trackCount} 首
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="secondary-button transfer-inline-button" disabled={loadingPlaylists} onClick={() => void loadUserPlaylists()}>
                        {loadingPlaylists ? "读取中" : "刷新网易云歌单"}
                      </button>
                    </div>
                  ) : null}

                  {transferSourceProvider === "qq" ? (
                    <label>
                      <span>QQ 音乐公开歌单 ID</span>
                      <input value={transferPlaylistId} onChange={(event) => setTransferPlaylistId(event.target.value)} placeholder="例如：7550971547" />
                    </label>
                  ) : null}

                  {transferSourceProvider === "text" || transferSourceProvider === "csv" ? (
                    <label>
                      <span>{transferSourceProvider === "csv" ? "CSV 内容" : "文字歌单"}</span>
                      <textarea
                        value={transferTextInput}
                        onChange={(event) => setTransferTextInput(event.target.value)}
                        placeholder={transferSourceProvider === "csv" ? "title,artist,album" : "1. 歌名 - 歌手 - 专辑"}
                      />
                    </label>
                  ) : null}

                  <label>
                    <span>任务名称</span>
                    <input value={transferPlaylistName} onChange={(event) => setTransferPlaylistName(event.target.value)} placeholder="例如：网易云到 QQ 的收藏迁移" />
                  </label>

                  <label className="transfer-check-row">
                    <input
                      type="checkbox"
                      checked={transferCheckAvailability}
                      disabled={transferTargetProvider !== "netease"}
                      onChange={(event) => setTransferCheckAvailability(event.target.checked)}
                    />
                    <span>匹配到网易云目标时检查音源可用性</span>
                  </label>

                  <div className="form-actions">
                    <button type="button" className="primary-button wide" disabled={transferLoading} onClick={() => void handleCreateTransferJob()}>
                      {transferLoading ? "转换中" : "开始转换"}
                    </button>
                  </div>
                  {transferRunJob ? (
                    <div className="audit-progress-panel">
                      <div className="audit-progress-head">
                        <strong>{getTransferRunJobStatusLabel(transferRunJob)}</strong>
                        <span>{transferRunProgressPercent}%</span>
                      </div>
                      <div className="audit-progress-track" aria-label="歌单互转进度">
                        <span style={{ width: `${transferRunProgressPercent}%` }} />
                      </div>
                      <div className="audit-progress-meta">
                        <span>已处理 {transferRunJob.progress.processed}/{transferRunJob.progress.total}</span>
                        <span>已匹配 {transferRunJob.progress.matched}</span>
                        <span>待确认 {transferRunJob.progress.manualReview}</span>
                        <span>未找到 {transferRunJob.progress.notFound}</span>
                        <span>受限 {transferRunJob.progress.unavailable}</span>
                        <span>重复 {transferRunJob.progress.duplicate}</span>
                      </div>
                      {transferRunJob.progress.currentTitle ? (
                        <p>当前：{transferRunJob.progress.currentTitle}</p>
                      ) : null}
                      {transferRunJob.error ? (
                        <p>{transferRunJob.error}</p>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                <section className="settings-card transfer-report-card">
                  <span>网易云导入歌单清理</span>
                  <p>扫描网易云歌单里“其它版本可播”或无播放音源的导入条目，按歌名搜索可用替代，并整理成可再次导入的文字歌单。</p>
                  <div className="transfer-grid">
                    <label>
                      <span>要清理的网易云歌单</span>
                      <select value={neteaseAuditPlaylistId} onChange={(event) => setNeteaseAuditPlaylistId(event.target.value)}>
                        <option value="">选择歌单</option>
                        {playlists.map((playlist) => (
                          <option key={playlist.id} value={playlist.id}>
                            {playlist.name} · {playlist.trackCount} 首
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="button" className="secondary-button transfer-inline-button" disabled={loadingPlaylists} onClick={() => void loadUserPlaylists()}>
                      {loadingPlaylists ? "读取中" : "刷新网易云歌单"}
                    </button>
                  </div>
                  <div className="transfer-grid">
                    <label>
                      <span>最多扫描</span>
                      <input
                        type="number"
                        min="1"
                        max="1000"
                        value={neteaseAuditMaxTracks}
                        onChange={(event) => setNeteaseAuditMaxTracks(Math.min(1000, Math.max(1, Number(event.target.value) || 300)))}
                      />
                    </label>
                    <label>
                      <span>每首候选数</span>
                      <input
                        type="number"
                        min="1"
                        max="10"
                        value={neteaseAuditCandidateLimit}
                        onChange={(event) => setNeteaseAuditCandidateLimit(Math.min(10, Math.max(1, Number(event.target.value) || 5)))}
                      />
                    </label>
                  </div>
                  <label className="transfer-check-row">
                    <input
                      type="checkbox"
                      checked={neteaseAuditCheckAvailability}
                      onChange={(event) => setNeteaseAuditCheckAvailability(event.target.checked)}
                    />
                    <span>检查候选歌曲是否能获取完整音源</span>
                  </label>
                  <div className="form-actions">
                    <button type="button" className="primary-button wide" disabled={neteaseAuditLoading} onClick={() => void handleCreateNeteaseImportAudit()}>
                      {neteaseAuditLoading ? "扫描中" : "扫描并整理文字歌单"}
                    </button>
                    {canCancelNeteaseAudit ? (
                      <button type="button" className="secondary-button" onClick={() => void handleCancelNeteaseImportAudit()}>
                        取消扫描
                      </button>
                    ) : null}
                  </div>
                  {neteaseImportAuditJob ? (
                    <div className="audit-progress-panel">
                      <div className="audit-progress-head">
                        <strong>{getNeteaseAuditJobStatusLabel(neteaseImportAuditJob)}</strong>
                        <span>{neteaseAuditProgressPercent}%</span>
                      </div>
                      <div className="audit-progress-track" aria-label="网易云导入歌单清理进度">
                        <span style={{ width: `${neteaseAuditProgressPercent}%` }} />
                      </div>
                      <div className="audit-progress-meta">
                        <span>已扫描 {neteaseImportAuditJob.progress.scanned}/{neteaseImportAuditJob.progress.total}</span>
                        <span>识别 {neteaseImportAuditJob.progress.suspect}</span>
                        <span>可替代 {neteaseImportAuditJob.progress.replaceable}</span>
                        <span>待确认 {neteaseImportAuditJob.progress.needsReview}</span>
                        <span>暂无替代 {neteaseImportAuditJob.progress.unusable}</span>
                      </div>
                      {neteaseImportAuditJob.progress.currentTitle ? (
                        <p>当前：{neteaseImportAuditJob.progress.currentTitle}</p>
                      ) : null}
                      {neteaseImportAuditJob.error ? (
                        <p>{neteaseImportAuditJob.error}</p>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                {neteaseImportAudit ? (
                  <section className="settings-card transfer-report-card">
                    <div className="transfer-report-head">
                      <div>
                        <span>{neteaseImportAudit.playlistName}</span>
                        <p>扫描 {neteaseImportAudit.scannedCount} 首 · 识别 {neteaseImportAudit.summary.suspect} 首不可用</p>
                      </div>
                      <div className="transfer-summary-grid netease-audit-summary-grid">
                        <strong>{neteaseImportAudit.summary.playable}<small>正常可播</small></strong>
                        <strong>{neteaseImportAudit.summary.replaceable}<small>可替代</small></strong>
                        <strong>{neteaseImportAudit.summary.needsReview}<small>待确认</small></strong>
                        <strong>{neteaseImportAudit.summary.unusable}<small>暂无替代</small></strong>
                        <strong>{neteaseImportAudit.summary.suspect}<small>不可用</small></strong>
                      </div>
                    </div>

                    <div className="transfer-table">
                      {neteaseImportAudit.items.slice(0, 80).map((item, index) => (
                        <article key={`${item.originalTrackId}-${index}`} className="transfer-row">
                          <div>
                            <strong>{item.sourceTrack.title}</strong>
                            <span>{item.sourceTrack.artists.join(" / ") || "未知歌手"} · {item.unusableReason}</span>
                          </div>
                          <div>
                            <strong>{item.selectedCandidate ? item.selectedCandidate.title : getNeteaseAuditStatusLabel(item.status)}</strong>
                            <span>
                              {item.selectedCandidate
                                ? `${item.selectedCandidate.artists.join(" / ") || "未知歌手"} · ${item.selectedCandidate.confidenceScore} 分`
                                : item.reason ?? "未找到可用候选"}
                            </span>
                          </div>
                          <span className={`transfer-status transfer-status-${item.status}`}>{getNeteaseAuditStatusLabel(item.status)}</span>
                        </article>
                      ))}
                    </div>

                    <div className="transfer-import-panel">
                      <label>
                        <span>正常歌曲新歌单名</span>
                        <input value={neteaseAuditPlayablePlaylistName} onChange={(event) => setNeteaseAuditPlayablePlaylistName(event.target.value)} />
                      </label>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={!canCreateNeteaseAuditPlayablePlaylist || neteaseAuditPlayableImporting}
                        onClick={() => void handleCreateNeteaseAuditPlayablePlaylist()}
                      >
                        {neteaseAuditPlayableImporting ? "创建中" : "创建正常歌曲新歌单"}
                      </button>
                      <p>
                        只导入原歌单里当前正常可播的 {neteaseImportAudit.summary.playable} 首；如果网易云拒绝直接创建，可以复制下面的正常可播文字歌单导入。
                      </p>
                      {neteaseAuditPlayableImportResult ? (
                        <p>
                          已创建 {neteaseAuditPlayableImportResult.addedCount} 首，跳过 {neteaseAuditPlayableImportResult.skippedCount} 首。
                          {neteaseAuditPlayableImportResult.playlistUrl ? (
                            <a href={neteaseAuditPlayableImportResult.playlistUrl} target="_blank" rel="noreferrer">打开新歌单</a>
                          ) : (
                            <>歌单 ID：{neteaseAuditPlayableImportResult.playlistId}</>
                          )}
                        </p>
                      ) : null}
                    </div>

                    <div className="form-actions transfer-export-actions">
                      <select value={neteaseAuditExportFormat} onChange={(event) => setNeteaseAuditExportFormat(event.target.value as TransferExportFormat)}>
                        <option value="text">纯文本</option>
                        <option value="markdown">Markdown</option>
                        <option value="csv">CSV</option>
                        <option value="json">JSON</option>
                      </select>
                      <button type="button" className="secondary-button" disabled={!canExportNeteaseAudit || neteaseAuditExporting} onClick={() => void handleExportNeteaseImportAudit()}>
                        {neteaseAuditExporting ? "导出中" : "下载清理结果"}
                      </button>
                    </div>

                    <div className="netease-audit-output-grid">
                      <label>
                        <span>正常可播文字歌单</span>
                        <textarea className="transfer-export-output" value={neteaseImportAudit.playableTextPlaylist || "当前扫描范围内没有正常可播歌曲。"} readOnly />
                      </label>
                      <label>
                        <span>可重新导入的文字歌单</span>
                        <textarea className="transfer-export-output" value={neteaseImportAudit.textPlaylist || "没有可自动替代的歌曲。"} readOnly />
                      </label>
                      <label>
                        <span>完全不可用或暂无替代</span>
                        <textarea className="transfer-export-output" value={neteaseImportAudit.unusableText || "当前扫描范围内没有暂无替代的歌曲。"} readOnly />
                      </label>
                    </div>
                    {neteaseAuditExportContent ? (
                      <textarea className="transfer-export-output" value={neteaseAuditExportContent} readOnly />
                    ) : null}
                  </section>
                ) : null}

                <section className="settings-card transfer-report-card">
                  <span>两个歌单对比</span>
                  <p>对比网易云歌单或 QQ 音乐公开歌单，区分完全一样、歌名相同但歌手不同、歌名相似，以及只存在于其中一边的歌曲。</p>
                  <div className="transfer-grid">
                    <label>
                      <span>左侧来源</span>
                      <select value={compareLeftProvider} onChange={(event) => setCompareLeftProvider(event.target.value as "netease" | "qq")}>
                        <option value="netease">网易云歌单</option>
                        <option value="qq">QQ 音乐公开歌单</option>
                      </select>
                    </label>
                    <label>
                      <span>右侧来源</span>
                      <select value={compareRightProvider} onChange={(event) => setCompareRightProvider(event.target.value as "netease" | "qq")}>
                        <option value="netease">网易云歌单</option>
                        <option value="qq">QQ 音乐公开歌单</option>
                      </select>
                    </label>
                  </div>
                  <div className="transfer-grid">
                    <label>
                      <span>左侧歌单</span>
                      {compareLeftProvider === "netease" ? (
                        <select value={compareLeftPlaylistId} onChange={(event) => setCompareLeftPlaylistId(event.target.value)}>
                          <option value="">选择歌单</option>
                          {playlists.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>
                              {playlist.name} · {playlist.trackCount} 首
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input value={compareLeftPlaylistId} onChange={(event) => setCompareLeftPlaylistId(event.target.value)} placeholder="QQ 音乐公开歌单 ID" />
                      )}
                    </label>
                    <label>
                      <span>右侧歌单</span>
                      {compareRightProvider === "netease" ? (
                        <select value={compareRightPlaylistId} onChange={(event) => setCompareRightPlaylistId(event.target.value)}>
                          <option value="">选择歌单</option>
                          {playlists.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>
                              {playlist.name} · {playlist.trackCount} 首
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input value={compareRightPlaylistId} onChange={(event) => setCompareRightPlaylistId(event.target.value)} placeholder="QQ 音乐公开歌单 ID" />
                      )}
                    </label>
                  </div>
                  <div className="form-actions">
                    {(compareLeftProvider === "netease" || compareRightProvider === "netease") ? (
                      <button type="button" className="secondary-button" disabled={loadingPlaylists} onClick={() => void loadUserPlaylists()}>
                        {loadingPlaylists ? "读取中" : "刷新网易云歌单"}
                      </button>
                    ) : null}
                    <button type="button" className="primary-button" disabled={playlistCompareLoading} onClick={() => void handleCreatePlaylistCompare()}>
                      {playlistCompareLoading ? "对比中" : "开始对比"}
                    </button>
                  </div>
                  {playlistCompareJob ? (
                    <div className="audit-progress-panel">
                      <div className="audit-progress-head">
                        <strong>{getPlaylistCompareJobStatusLabel(playlistCompareJob)}</strong>
                        <span>{playlistCompareProgressPercent}%</span>
                      </div>
                      <div className="audit-progress-track" aria-label="歌单对比进度">
                        <span style={{ width: `${playlistCompareProgressPercent}%` }} />
                      </div>
                      <div className="audit-progress-meta">
                        <span>已对比 {playlistCompareJob.progress.processed}/{playlistCompareJob.progress.total}</span>
                        <span>完全一样 {playlistCompareJob.progress.exact}</span>
                        <span>同名异歌手 {playlistCompareJob.progress.sameTitleDifferentArtist}</span>
                        <span>歌名相似 {playlistCompareJob.progress.similarTitle}</span>
                        <span>仅左侧 {playlistCompareJob.progress.leftOnly}</span>
                        <span>仅右侧 {playlistCompareJob.progress.rightOnly}</span>
                      </div>
                      {playlistCompareJob.progress.currentTitle ? (
                        <p>当前：{playlistCompareJob.progress.currentTitle}</p>
                      ) : null}
                      {playlistCompareJob.error ? (
                        <p>{playlistCompareJob.error}</p>
                      ) : null}
                    </div>
                  ) : null}
                </section>

                {playlistCompareResult ? (
                  <section className="settings-card transfer-report-card">
                    <div className="transfer-report-head">
                      <div>
                        <span>{playlistCompareResult.left.playlistName} / {playlistCompareResult.right.playlistName}</span>
                        <p>左侧 {playlistCompareResult.left.total} 首 · 右侧 {playlistCompareResult.right.total} 首</p>
                      </div>
                      <div className="transfer-summary-grid">
                        <strong>{playlistCompareResult.summary.exact}<small>完全一样</small></strong>
                        <strong>{playlistCompareResult.summary.sameTitleDifferentArtist}<small>同名异歌手</small></strong>
                        <strong>{playlistCompareResult.summary.similarTitle}<small>歌名相似</small></strong>
                        <strong>{playlistCompareResult.summary.leftOnly}<small>仅左侧</small></strong>
                        <strong>{playlistCompareResult.summary.rightOnly}<small>仅右侧</small></strong>
                      </div>
                    </div>

                    <div className="transfer-table">
                      {playlistCompareResult.items.slice(0, 100).map((item, index) => (
                        <article key={`${item.status}-${index}-${item.leftTrack?.sourceTrackId ?? item.rightTrack?.sourceTrackId ?? index}`} className="transfer-row">
                          <div>
                            <strong>{item.leftTrack?.title ?? getPlaylistCompareStatusLabel(item.status)}</strong>
                            <span>{item.leftTrack?.artists.join(" / ") || "左侧无对应歌曲"}</span>
                          </div>
                          <div>
                            <strong>{item.rightTrack?.title ?? getPlaylistCompareStatusLabel(item.status)}</strong>
                            <span>{item.rightTrack?.artists.join(" / ") || "右侧无对应歌曲"}{item.score > 0 ? ` · ${item.score} 分` : ""}</span>
                          </div>
                          <span className={`transfer-status transfer-status-${item.status}`}>{getPlaylistCompareStatusLabel(item.status)}</span>
                        </article>
                      ))}
                    </div>

                    <div className="compare-export-statuses">
                      {(["exact", "same_title_different_artist", "similar_title", "left_only", "right_only"] as PlaylistCompareStatus[]).map((status) => (
                        <label key={status} className="transfer-check-row">
                          <input
                            type="checkbox"
                            checked={playlistCompareExportStatuses.includes(status)}
                            onChange={() => togglePlaylistCompareExportStatus(status)}
                          />
                          <span>{getPlaylistCompareStatusLabel(status)}</span>
                        </label>
                      ))}
                    </div>

                    <div className="form-actions transfer-export-actions">
                      <select value={playlistCompareExportFormat} onChange={(event) => setPlaylistCompareExportFormat(event.target.value as TransferExportFormat)}>
                        <option value="text">纯文本歌单</option>
                        <option value="markdown">Markdown 报告</option>
                        <option value="csv">CSV</option>
                        <option value="json">JSON</option>
                      </select>
                      <button type="button" className="secondary-button" disabled={playlistCompareExporting} onClick={() => void handleExportPlaylistCompare()}>
                        {playlistCompareExporting ? "导出中" : "导出所选分类"}
                      </button>
                    </div>

                    {playlistCompareExportContent ? (
                      <textarea className="transfer-export-output" value={playlistCompareExportContent} readOnly />
                    ) : null}
                  </section>
                ) : null}

                {transferJob ? (
                  <section className="settings-card transfer-report-card">
                    <div className="transfer-report-head">
                      <div>
                        <span>{transferJob.playlistName}</span>
                        <p>
                          {transferJob.sourceProvider} 到 {transferJob.targetProvider} · 共 {transferJob.summary.total} 首
                        </p>
                      </div>
                      <div className="transfer-summary-grid">
                        <strong>{transferJob.summary.matched}<small>已匹配</small></strong>
                        <strong>{transferJob.summary.manualReview}<small>待确认</small></strong>
                        <strong>{transferJob.summary.notFound}<small>未找到</small></strong>
                        <strong>{transferJob.summary.unavailable}<small>受限</small></strong>
                        <strong>{transferJob.summary.duplicate}<small>重复</small></strong>
                      </div>
                    </div>

                    <div className="transfer-table">
                      {transferJob.tracks.slice(0, 80).map((track, index) => (
                        <article key={`${track.sourceTrack.sourceTrackId ?? index}-${track.sourceTrack.title}`} className="transfer-row">
                          <div>
                            <strong>{track.sourceTrack.title}</strong>
                            <span>{track.sourceTrack.artists.join(" / ") || "未知歌手"}{track.sourceTrack.album ? ` · ${track.sourceTrack.album}` : ""}</span>
                          </div>
                          <div>
                            <strong>{track.selectedCandidate ? track.selectedCandidate.title : getTransferStatusLabel(track.status)}</strong>
                            <span>
                              {track.selectedCandidate
                                ? `${track.selectedCandidate.artists.join(" / ") || "未知歌手"} · ${track.selectedCandidate.confidenceScore} 分`
                                : track.reason ?? "无候选"}
                            </span>
                          </div>
                          <span className={`transfer-status transfer-status-${track.status}`}>{getTransferStatusLabel(track.status)}</span>
                        </article>
                      ))}
                    </div>

                    <div className="form-actions transfer-export-actions">
                      <select value={transferExportFormat} onChange={(event) => setTransferExportFormat(event.target.value as TransferExportFormat)}>
                        <option value="markdown">Markdown</option>
                        <option value="text">纯文本</option>
                        <option value="csv">CSV</option>
                        <option value="json">JSON</option>
                      </select>
                      <button type="button" className="secondary-button" disabled={transferExporting} onClick={() => void handleExportTransferJob()}>
                        {transferExporting ? "导出中" : "生成导出内容"}
                      </button>
                    </div>

                    {transferJob.targetProvider === "netease" && transferJob.summary.matched > 0 ? (
                      <div className="transfer-import-panel">
                        <label>
                          <span>网易云目标歌单名</span>
                          <input value={transferImportName} onChange={(event) => setTransferImportName(event.target.value)} />
                        </label>
                        <button type="button" className="primary-button" disabled={transferImporting} onClick={() => void handleImportTransferToNetease()}>
                          {transferImporting ? "导入中" : "创建网易云歌单"}
                        </button>
                        {transferImportResult ? (
                          <p>已导入 {transferImportResult.addedCount} 首，跳过 {transferImportResult.skippedCount} 首。歌单 ID：{transferImportResult.playlistId}</p>
                        ) : null}
                      </div>
                    ) : null}

                    {transferExportContent ? (
                      <textarea className="transfer-export-output" value={transferExportContent} readOnly />
                    ) : null}
                  </section>
                ) : null}
              </div>
            </section>
          ) : mainTab === "search" && navKey === "playlists" && !isPlaylistSongsView ? (
            <section className="playlist-manager">
              <header className="playlist-manager-head">
                <div>
                  <p className="eyebrow">我的歌单</p>
                  <h2>网易云账号歌单</h2>
                </div>
                <button type="button" className="secondary-button" disabled={loadingPlaylists} onClick={() => void loadUserPlaylists()}>
                  {loadingPlaylists ? "读取中" : "刷新歌单"}
                </button>
              </header>

              <div className="playlist-sections">
                {playlists.length === 0 ? (
                  <div className="empty-box">{loadingPlaylists ? "正在读取歌单..." : "还没有读取到歌单，请先在设置页配置有效 Cookie。"}</div>
                ) : (
                  <>
                    <section className="playlist-section">
                      <header className="playlist-section-head">
                        <div>
                          <h3>我创建的歌单</h3>
                          <p>当前账号作为创建者的歌单</p>
                        </div>
                        <span>{createdPlaylists.length} 个</span>
                      </header>
                      <div className="playlist-grid">
                        {createdPlaylists.length > 0 ? createdPlaylists.map(renderPlaylistCard) : <div className="empty-box">暂时没有创建的歌单。</div>}
                      </div>
                    </section>

                    <section className="playlist-section">
                      <header className="playlist-section-head">
                        <div>
                          <h3>我收藏的歌单</h3>
                          <p>其他用户创建、当前账号收藏的歌单</p>
                        </div>
                        <span>{collectedPlaylists.length} 个</span>
                      </header>
                      <div className="playlist-grid">
                        {collectedPlaylists.length > 0 ? collectedPlaylists.map(renderPlaylistCard) : <div className="empty-box">暂时没有收藏的歌单。</div>}
                      </div>
                    </section>
                  </>
                )}
              </div>
            </section>
          ) : mainTab === "search" && (navKey === "discover" || navKey === "cloud" || navKey === "daily" || navKey === "artist" || navKey === "album" || isPlaylistSongsView) ? (
            <section className={batchSelectionMode ? "results-panel batch-mode" : "results-panel"}>
              {navKey === "artist" && activeArtist ? (
                <div className="artist-hero">
                  <CoverArt
                    song={{
                      id: activeArtist.id,
                      title: activeArtist.name,
                      artist: activeArtist.name,
                      album: "歌手",
                      coverUrl: activeArtist.avatarUrl ?? activeArtist.coverUrl,
                      duration: "00:00",
                      quality: "歌手",
                      availableQualities: [{ level: "standard", label: "128K" }],
                      source: "netease-artist"
                    }}
                    className="artist-cover"
                  />
                  <div className="artist-hero-copy">
                    <strong>{activeArtist.name}</strong>
                    <span>{activeArtist.musicCount} 首单曲 · {activeArtist.albumCount} 张专辑 · {activeArtist.mvCount} 个 MV</span>
                    <p>{activeArtist.description}</p>
                  </div>
                </div>
              ) : null}
              {navKey === "album" && activeAlbum ? (
                <div className="artist-hero">
                  <CoverArt
                    song={{
                      id: activeAlbum.id,
                      title: activeAlbum.name,
                      artist: activeAlbum.artist,
                      album: activeAlbum.name,
                      coverUrl: activeAlbum.coverUrl,
                      duration: "00:00",
                      quality: "专辑",
                      availableQualities: [{ level: "standard", label: "128K" }],
                      source: "netease-album"
                    }}
                    className="artist-cover"
                  />
                  <div className="artist-hero-copy">
                    <strong>{activeAlbum.name}</strong>
                    <span>
                      {activeAlbum.artist} · {activeAlbum.trackCount} 首歌曲
                      {activeAlbum.publishDate ? ` · ${activeAlbum.publishDate}` : ""}
                      {activeAlbum.company ? ` · ${activeAlbum.company}` : ""}
                    </span>
                    <p>{activeAlbum.description}</p>
                  </div>
                </div>
              ) : null}
              {resultSource === "playlist" && activePlaylist ? (
                <div className="form-actions playlist-toolbar">
                  <div className="playlist-toolbar-pagination">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={loadingPlaylistSongs || playlistSongsPage <= 1}
                      onClick={() => handlePlaylistPageChange(playlistSongsPage - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      {activePlaylist.name} · 第 {playlistSongsPage} / {playlistTotalPages} 页 · {playlistSearchKeyword ? `匹配 ${playlistSongsTotal} 首 / 共 ${activePlaylist.trackCount} 首` : `共 ${activePlaylist.trackCount} 首`}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={loadingPlaylistSongs || (!playlistSongsHasMore && playlistSongsPage >= playlistTotalPages)}
                      onClick={() => handlePlaylistPageChange(playlistSongsPage + 1)}
                    >
                      下一页
                    </button>
                  </div>
                  <div className="playlist-toolbar-controls">
                    <label className="playlist-sort-control">
                      <span>排序</span>
                      <div className="playlist-sort-select" onClick={(event) => event.stopPropagation()}>
                        <button
                          ref={playlistSortTriggerRef}
                          type="button"
                          className="playlist-sort-trigger"
                          aria-haspopup="listbox"
                          aria-expanded={openPlaylistSortMenu}
                          onClick={(event) => togglePlaylistSortMenu(event.currentTarget)}
                        >
                          <span>{playlistSortOptions.find((option) => option.value === playlistSortMode)?.label ?? "默认顺序"}</span>
                          <span className={openPlaylistSortMenu ? "quality-caret open" : "quality-caret"}>
                            <ChevronIcon />
                          </span>
                        </button>
                        {openPlaylistSortMenu && playlistSortMenuStyle ? (
                          <div className="playlist-sort-menu" role="listbox" aria-label="歌单歌曲排序" style={playlistSortMenuStyle ?? undefined} onClick={(event) => event.stopPropagation()}>
                            {playlistSortOptions.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                role="option"
                                aria-selected={playlistSortMode === option.value}
                                className={playlistSortMode === option.value ? "playlist-sort-option active" : "playlist-sort-option"}
                                onClick={() => handlePlaylistSortChange(option.value)}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </label>
                    <form className="playlist-filter-form" onSubmit={handlePlaylistSearchSubmit}>
                      <input
                        value={playlistSearchInput}
                        onChange={(event) => setPlaylistSearchInput(event.target.value)}
                        placeholder="筛选当前歌单的歌名 / 歌手 / 专辑"
                      />
                      <button type="submit" className="secondary-button" disabled={loadingPlaylistSongs}>
                        筛选
                      </button>
                      {playlistSearchKeyword ? (
                        <button type="button" className="secondary-button" disabled={loadingPlaylistSongs} onClick={handleClearPlaylistSearch}>
                          清除
                        </button>
                      ) : null}
                    </form>
                  </div>
                </div>
              ) : null}
              {visibleSongs.length > 0 ? (
                <div className="form-actions results-selection-bar">
                  <span>{batchSelectionMode ? `已选 ${selectedVisibleSongs.length} 首` : "批量选择歌曲后可下载、收藏或移除"}</span>
                  <div className="results-selection-actions">
                    {batchSelectionMode ? (
                      <>
                        <button
                          type="button"
                          className={!hasNeteaseDownloadAuth ? "secondary-button compact locked-action-button" : "secondary-button compact"}
                          disabled={batchDownloading || selectedVisibleSongs.length === 0}
                          onClick={() => void handleBatchDownload(selectedVisibleSongs, "已选歌曲")}
                        >
                          {!hasNeteaseDownloadAuth ? <LockIcon /> : null}
                          {batchDownloading ? "启动中" : "直连下载已选"}
                        </button>
                        <button
                          type="button"
                          className={!accountIsLoggedIn ? "secondary-button compact locked-action-button" : "secondary-button compact"}
                          disabled={Boolean(addingToPlaylistId) || selectedVisibleSongs.length === 0}
                          onClick={() => void handleOpenPlaylistPickerForSongs(selectedVisibleSongs)}
                        >
                          {!accountIsLoggedIn ? <LockIcon /> : null}
                          收藏已选
                        </button>
                        {resultSource === "playlist" && activePlaylist?.owned ? (
                          <button
                            type="button"
                            className="secondary-button compact danger-button"
                            disabled={removingPlaylistSongs || loadingPlaylistSongs || selectedVisibleSongs.length === 0}
                            onClick={() => void handleRemoveSelectedPlaylistSongs()}
                          >
                            {removingPlaylistSongs ? "移除中" : "从歌单移除"}
                          </button>
                        ) : null}
                        <button type="button" className="secondary-button compact" onClick={exitBatchSelectionMode}>
                          退出批量
                        </button>
                      </>
                    ) : (
                      <button type="button" className="secondary-button compact" onClick={enterBatchSelectionMode}>
                        批量操作
                      </button>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="results-head">
                {batchSelectionMode ? (
                  <label className="result-check-cell result-check-header">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      aria-label={allVisibleSelected ? "取消全选当前列表" : "全选当前列表"}
                      onChange={handleToggleVisibleSongsSelection}
                    />
                  </label>
                ) : null}
                <span>歌曲</span>
                <span>歌手 / 专辑</span>
                <span>时长</span>
                <span>音质</span>
                <span>操作</span>
              </div>

              <div ref={resultBodyRef} className="results-body">
                {resultListLoading && visibleSongs.length === 0 ? (
                  <div className="empty-box">{resultLoadingMessage}</div>
                ) : null}
                {!resultListLoading && visibleSongs.length === 0 ? (
                  <div className="empty-box">{resultEmptyMessage}</div>
                ) : null}
                {visibleSongs.map((song) => (
                  <article
                    key={song.id}
                    className={currentTrack?.id === song.id ? "result-row active" : "result-row"}
                    onClick={() => handleSelectSong(song)}
                    onDoubleClick={() => handlePreview(song)}
                    onContextMenu={(event) => handleOpenSongContextMenu(event, song)}
                  >
                    {batchSelectionMode ? (
                      <label className="result-check-cell" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedSongIds.includes(song.id)}
                          aria-label={`选择 ${song.title}`}
                          onChange={() => handleToggleSongSelection(song.id)}
                        />
                      </label>
                    ) : null}
                    <div className="result-track">
                      <CoverArt song={song} className="result-cover" />
                      <div className="result-copy">
                        <strong>{song.title}</strong>
                        <span>{song.quality}</span>
                      </div>
                    </div>

                    <div className="result-meta">
                      {renderArtistMeta(song)}
                      {renderAlbumMeta(song)}
                    </div>
                    <span className="result-time">{song.duration}</span>

                    {renderQualitySelect(song)}
                    <div className="row-actions">
                      <button
                        type="button"
                        className={playbackLocked ? "row-icon-button locked-playback-button" : "row-icon-button"}
                        aria-label={playbackLocked ? `登录后试听 ${song.title}` : `试听 ${song.title}`}
                        title={playbackLocked ? "登录后试听" : "试听"}
                        disabled={playbackLocked}
                        onClick={(event) => { event.stopPropagation(); handlePreview(song); }}
                      >
                        <PreviewIcon />
                        {playbackLocked ? <span className="download-lock-badge"><LockIcon /></span> : null}
                      </button>
                      <button
                        type="button"
                        className={!accountIsLoggedIn ? "row-icon-button playlist-add-button locked-download-button" : "row-icon-button playlist-add-button"}
                        aria-label={!accountIsLoggedIn ? `登录后收藏 ${song.title} 到歌单` : `收藏 ${song.title} 到歌单`}
                        title={!accountIsLoggedIn ? "登录后收藏到歌单" : "收藏到歌单"}
                        disabled={Boolean(addingToPlaylistId)}
                        onClick={(event) => { event.stopPropagation(); void handleOpenPlaylistPicker(song); }}
                      >
                        <PlaylistAddIcon />
                        {!accountIsLoggedIn ? <span className="download-lock-badge"><LockIcon /></span> : null}
                      </button>
                      <button
                        type="button"
                        className={!hasNeteaseDownloadAuth ? "row-icon-button accent locked-download-button" : "row-icon-button accent"}
                        aria-label={!hasNeteaseDownloadAuth ? `登录后下载 ${song.title}` : directDownloadingSongId === song.id ? `正在下载 ${song.title}` : `下载 ${song.title}`}
                        title={!hasNeteaseDownloadAuth ? "登录后下载" : directDownloadingSongId === song.id ? "正在下载" : "下载"}
                        disabled={Boolean(directDownloadingSongId || batchDownloading)}
                        onClick={(event) => { event.stopPropagation(); void handleDownload(song); }}
                      >
                        <DownloadIcon />
                        {!hasNeteaseDownloadAuth ? <span className="download-lock-badge"><LockIcon /></span> : null}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : mainTab === "search" && navKey === "history" ? (
            <section className="download-manager history-manager">
              <header className="download-manager-head">
                <div>
                  <p className="eyebrow">播放历史</p>
                  <h2>最近听过的歌曲</h2>
                </div>
                <div className="download-summary">
                  <span>{playHistory.length} 首</span>
                </div>
              </header>

              <div className="history-list">
                {playHistory.length === 0 ? (
                  <div className="empty-box">暂无播放历史。试听或播放一首歌后会出现在这里。</div>
                ) : (
                  playHistory.map((song, index) => (
                    <article key={song.id} className={currentTrack?.id === song.id ? "history-row active" : "history-row"} onClick={() => handlePreview(song)} onContextMenu={(event) => handleOpenSongContextMenu(event, song)}>
                      <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                      <CoverArt song={song} className="result-cover" />
                      <div className="history-copy">
                        <strong>{song.title}</strong>
                        <span>{song.artist} · {song.album}</span>
                      </div>
                      <span className="result-time">{song.duration}</span>
                      <button
                        type="button"
                        className={playbackLocked ? "secondary-button locked-action-button" : "secondary-button"}
                        disabled={playbackLocked}
                        onClick={(event) => { event.stopPropagation(); handlePreview(song); }}
                      >
                        {playbackLocked ? <LockIcon /> : null}
                        {playbackLocked ? "登录后播放" : "播放"}
                      </button>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : mainTab === "search" && navKey === "downloads" ? (
            <section className="download-manager">
              <header className="download-manager-head">
                <div>
                  <p className="eyebrow">下载管理</p>
                  <h2>服务器下载任务</h2>
                </div>
                <div className="download-summary">
                  <span>{completedCount} 已完成</span>
                  <span>{activeCount} 进行中</span>
                  <span>{failedCount} 失败</span>
                </div>
              </header>

              <div className="download-task-list">
                {tasks.length === 0 ? (
                  <div className="empty-box">还没有下载任务，回到发现音乐添加一首歌。</div>
                ) : (
                  tasks.map((task) => (
                    <article key={task.id} className="download-task-row">
                      <div className="download-task-main">
                        <strong>{task.title}</strong>
                        <span>{task.artist} · {task.quality}</span>
                      </div>
                      <span className="download-task-status">{statusLabel(task.status)}</span>
                      <div className="download-task-progress">
                        <div className="progress-track">
                          <div className="progress-fill" style={{ width: `${task.progress}%` }} />
                        </div>
                        <span>{task.progress}%</span>
                      </div>
                      <div className="download-task-meta">
                        {task.status === "done" ? <span>时长 {task.downloadedDuration ?? "--"} · 大小 {formatFileSize(task.fileSizeBytes)}</span> : null}
                        {task.error ? <span className="queue-error">{task.error}</span> : null}
                        <span>{task.outputPath ? `服务器文件：${task.outputPath}` : "等待写入产物"}</span>
                      </div>
                      <div className="download-task-action">
                        {task.status === "done" ? (
                          <button
                            type="button"
                            className="secondary-button compact"
                            disabled={savingTaskFileId === task.id}
                            onClick={() => void handleSaveTaskFile(task)}
                          >
                            <DownloadIcon />
                            {savingTaskFileId === task.id ? "保存中" : "保存到本机"}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : mainTab === "search" ? (
            <>
              <div className="toolbar-card search-hero">
                <form className="search-form search-form-large" onSubmit={handleSubmit}>
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、歌手、专辑" />
                  <button type="submit" disabled={searching}>{searching ? "搜索中" : "搜索"}</button>
                </form>
              </div>

              {resultSource === "search" && results.length > 0 ? (
              <section className={batchSelectionMode ? "results-panel batch-mode" : "results-panel"}>
                {visibleSongs.length > 0 ? (
                  <div className="form-actions results-selection-bar">
                    <span>{batchSelectionMode ? `已选 ${selectedVisibleSongs.length} 首` : "批量选择歌曲后可下载或收藏"}</span>
                    <div className="results-selection-actions">
                      {batchSelectionMode ? (
                        <>
                          <button
                            type="button"
                            className={!hasNeteaseDownloadAuth ? "secondary-button compact locked-action-button" : "secondary-button compact"}
                            disabled={batchDownloading || selectedVisibleSongs.length === 0}
                            onClick={() => void handleBatchDownload(selectedVisibleSongs, "已选歌曲")}
                          >
                            {!hasNeteaseDownloadAuth ? <LockIcon /> : null}
                            {batchDownloading ? "启动中" : "直连下载已选"}
                          </button>
                          <button
                            type="button"
                            className={!accountIsLoggedIn ? "secondary-button compact locked-action-button" : "secondary-button compact"}
                            disabled={Boolean(addingToPlaylistId) || selectedVisibleSongs.length === 0}
                            onClick={() => void handleOpenPlaylistPickerForSongs(selectedVisibleSongs)}
                          >
                            {!accountIsLoggedIn ? <LockIcon /> : null}
                            收藏已选
                          </button>
                          <button type="button" className="secondary-button compact" onClick={exitBatchSelectionMode}>
                            退出批量
                          </button>
                        </>
                      ) : (
                        <button type="button" className="secondary-button compact" onClick={enterBatchSelectionMode}>
                          批量操作
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
                <header className="results-head">
                  {batchSelectionMode ? (
                    <label className="result-check-cell result-check-header">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        aria-label={allVisibleSelected ? "取消全选当前列表" : "全选当前列表"}
                        onChange={handleToggleVisibleSongsSelection}
                      />
                    </label>
                  ) : null}
                  <span>歌曲</span>
                  <span>歌手 / 专辑</span>
                  <span>时长</span>
                  <span>音质</span>
                  <span>操作</span>
                </header>

                <div ref={resultBodyRef} className="results-body">
                  {visibleSongs.map((song) => (
                    <article
                      key={song.id}
                      className={currentTrack?.id === song.id ? "result-row active" : "result-row"}
                      onClick={() => handleSelectSong(song)}
                      onDoubleClick={() => handlePreview(song)}
                      onContextMenu={(event) => handleOpenSongContextMenu(event, song)}
                    >
                      {batchSelectionMode ? (
                        <label className="result-check-cell" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSongIds.includes(song.id)}
                            aria-label={`选择 ${song.title}`}
                            onChange={() => handleToggleSongSelection(song.id)}
                          />
                        </label>
                      ) : null}
                      <div className="result-track">
                        <CoverArt song={song} className="result-cover" />
                        <div className="result-copy">
                          <strong>{song.title}</strong>
                          <span>{song.quality}</span>
                        </div>
                      </div>

                      <div className="result-meta">
                        {renderArtistMeta(song)}
                        {renderAlbumMeta(song)}
                      </div>

                      <span className="result-time">{song.duration}</span>

                      {renderQualitySelect(song)}

                      <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className={playbackLocked ? "row-icon-button locked-playback-button" : "row-icon-button"}
                          aria-label={playbackLocked ? `登录后试听 ${song.title}` : `试听 ${song.title}`}
                          title={playbackLocked ? "登录后试听" : "试听"}
                          disabled={playbackLocked}
                          onClick={() => handlePreview(song)}
                        >
                          <PreviewIcon />
                          {playbackLocked ? <span className="download-lock-badge"><LockIcon /></span> : null}
                        </button>
                        <button
                          type="button"
                          className={!accountIsLoggedIn ? "row-icon-button playlist-add-button locked-download-button" : "row-icon-button playlist-add-button"}
                          aria-label={!accountIsLoggedIn ? `登录后收藏 ${song.title} 到歌单` : `收藏 ${song.title} 到歌单`}
                          title={!accountIsLoggedIn ? "登录后收藏到歌单" : "收藏到歌单"}
                          disabled={Boolean(addingToPlaylistId)}
                          onClick={() => void handleOpenPlaylistPicker(song)}
                        >
                          <PlaylistAddIcon />
                          {!accountIsLoggedIn ? <span className="download-lock-badge"><LockIcon /></span> : null}
                        </button>
                        <button
                          type="button"
                          className={!hasNeteaseDownloadAuth ? "row-icon-button accent locked-download-button" : "row-icon-button accent"}
                          aria-label={!hasNeteaseDownloadAuth ? `登录后下载 ${song.title}` : directDownloadingSongId === song.id ? `正在下载 ${song.title}` : `下载 ${song.title}`}
                          title={!hasNeteaseDownloadAuth ? "登录后下载" : directDownloadingSongId === song.id ? "正在下载" : "下载"}
                          disabled={Boolean(directDownloadingSongId || batchDownloading)}
                          onClick={() => void handleDownload(song)}
                        >
                          <DownloadIcon />
                          {!hasNeteaseDownloadAuth ? <span className="download-lock-badge"><LockIcon /></span> : null}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
              ) : (
                <section className="search-lobby">
                  <div className="search-lobby-card">
                    <p className="eyebrow">推荐搜索</p>
                    <h2>从常听歌手开始</h2>
                    <div className="quick-row">
                      {quickKeywords.map((keyword) => (
                        <button key={keyword} type="button" className="quick-chip" onClick={() => { setQuery(keyword); void runSearch(keyword); }}>
                          {keyword}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="search-lobby-card">
                    <p className="eyebrow">历史搜索</p>
                    <h2>最近查找</h2>
                    {searchHistory.length === 0 ? (
                      <div className="empty-box">还没有搜索记录。输入关键词回车后会保存在这里。</div>
                    ) : (
                      <div className="quick-row">
                        {searchHistory.map((keyword) => (
                          <div key={keyword} className="quick-chip history-chip">
                            <button type="button" className="history-chip-label" onClick={() => { setQuery(keyword); void runSearch(keyword); }}>
                              {keyword}
                            </button>
                            <button
                              type="button"
                              className="history-chip-remove"
                              aria-label={`删除搜索记录 ${keyword}`}
                              title="删除记录"
                              onClick={() => removeSearchHistory(keyword)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </>
          ) : mainTab === "account" ? (
            <section className="form-panel">
              <div className="form-head">
                <p className="eyebrow">账号管理</p>
                <h1>管理本地登录状态和展示资料</h1>
              </div>

              <form className="form-grid" onSubmit={handleLogin}>
                <label>
                  <span>账号名称</span>
                  <input value={loginForm.accountName} onChange={(event) => setLoginForm((current) => ({ ...current, accountName: event.target.value }))} placeholder="输入一个本地账号名" />
                </label>

                <label className="inline-row">
                  <span>VIP 身份</span>
                  <button type="button" className={loginForm.vipEnabled ? "toggle-button active" : "toggle-button"} onClick={() => setLoginForm((current) => ({ ...current, vipEnabled: !current.vipEnabled }))}>
                    {loginForm.vipEnabled ? "VIP" : "普通"}
                  </button>
                </label>

                <label>
                  <span>资料备注</span>
                  <textarea value={loginForm.note} onChange={(event) => setLoginForm((current) => ({ ...current, note: event.target.value }))} placeholder="例如：夜间下载、收藏现场版、华语为主" />
                </label>

                <div className="form-actions">
                  <button type="submit" className="primary-button wide" disabled={loggingIn}>{loggingIn ? "登录中" : "建立登录态"}</button>
                  <button type="button" className="secondary-button wide" onClick={() => void handleLogout()}>退出当前账号</button>
                </div>
              </form>
            </section>
          ) : (
            <section className="form-panel">
              <div className="form-head">
                <p className="eyebrow">下载偏好</p>
                <h1>服务器下载任务与文件保存</h1>
              </div>

              <form className="settings-grid" onSubmit={handleSaveSettings}>
                <label className="settings-card">
                  <span>服务器下载目录</span>
                  <p>保存服务器下载任务产物的目录，浏览器直连下载不会写入这里。</p>
                  <input value={settings.downloadDirectory} onChange={(event) => setSettings((current) => ({ ...current, downloadDirectory: event.target.value }))} placeholder="downloads" />
                </label>

                <div className="settings-card">
                  <span>默认播放音质</span>
                  <p>用于试听、双击播放和底部播放器，默认按 128K 启动，手动改过的歌曲仍以手动选择为准。</p>
                  <div className="settings-quality-select">
                    <button
                      type="button"
                      className="quality-trigger settings-quality-trigger"
                      aria-expanded={openSettingsQualityMenu === "playback"}
                      onClick={() => setOpenSettingsQualityMenu((current) => (current === "playback" ? null : "playback"))}
                    >
                      <span>{playbackQualityOptions.find((option) => option.level === settings.defaultPlaybackQuality)?.label ?? "128K"}</span>
                      <span className={openSettingsQualityMenu === "playback" ? "quality-caret open" : "quality-caret"}>
                        <ChevronIcon />
                      </span>
                    </button>

                    {openSettingsQualityMenu === "playback" ? (
                      <div className="quality-menu settings-quality-menu">
                        {playbackQualityOptions.map((option) => (
                          <button
                            key={option.level}
                            type="button"
                            className={settings.defaultPlaybackQuality === option.level ? "quality-option active" : "quality-option"}
                            onClick={() => {
                              setSettings((current) => ({ ...current, defaultPlaybackQuality: option.level }));
                              applyQualityDefaults(results, option.level);
                              setOpenSettingsQualityMenu(null);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="settings-card">
                  <span>默认下载音质</span>
                  <p>直连下载和服务器下载任务都会优先使用该音质；如果你手动改过某首歌的音质，会优先按手动选择下载。</p>
                  <div className="settings-quality-select">
                    <button
                      type="button"
                      className="quality-trigger settings-quality-trigger"
                      aria-expanded={openSettingsQualityMenu === "download"}
                      onClick={() => setOpenSettingsQualityMenu((current) => (current === "download" ? null : "download"))}
                    >
                      <span>{settingsQualityOptions.find((option) => option.level === settings.defaultDownloadQuality)?.label ?? "Hi-Res"}</span>
                      <span className={openSettingsQualityMenu === "download" ? "quality-caret open" : "quality-caret"}>
                        <ChevronIcon />
                      </span>
                    </button>

                    {openSettingsQualityMenu === "download" ? (
                      <div className="quality-menu settings-quality-menu">
                        {settingsQualityOptions.map((option) => (
                          <button
                            key={option.level}
                            type="button"
                            className={settings.defaultDownloadQuality === option.level ? "quality-option active" : "quality-option"}
                            onClick={() => {
                              setSettings((current) => ({ ...current, defaultDownloadQuality: option.level }));
                              setOpenSettingsQualityMenu(null);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                <label className="settings-card">
                  <span>同时下载任务数限制</span>
                  <p>控制服务器下载任务并发，范围 1-5。浏览器直连下载不受这个设置影响。</p>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={settings.maxConcurrentDownloads}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setSettings((current) => ({
                        ...current,
                        maxConcurrentDownloads: Number.isFinite(nextValue) ? Math.min(5, Math.max(1, Math.round(nextValue))) : current.maxConcurrentDownloads
                      }));
                    }}
                  />
                </label>

                <div className="form-actions">
                  <button type="submit" className="primary-button wide" disabled={savingSettings}>{savingSettings ? "保存中" : "保存设置"}</button>
                </div>
              </form>

              {showAdminFallbackControls ? (
                <>
                  <div className="form-head">
                    <p className="eyebrow">高级控制</p>
                    <h1>白名单特权与保底凭证</h1>
                  </div>

                  <form className="settings-grid" onSubmit={handleSaveAdminConfig}>
                    <label className="settings-card">
                      <span>Feature Pass Whitelist</span>
                      <p>填写允许触发高阶凭证回退的用户 ID，支持逗号分隔或按行输入。</p>
                      <textarea
                        value={adminConfig.trustedUserWhitelistText}
                        onChange={(event) => setAdminConfig((current) => ({ ...current, trustedUserWhitelistText: event.target.value }))}
                        placeholder={"123456789\n987654321"}
                      />
                    </label>

                    <label className="settings-card">
                      <span>System Default Token</span>
                      <p>{adminConfig.hasSystemDefaultToken ? "已配置全局保底凭证，留空表示保持不变。" : "管理员保底凭证，仅在命中白名单且个人凭证无高阶权限时回退使用。"}</p>
                      <input
                        type="password"
                        value={adminConfigTokenInput}
                        onChange={(event) => setAdminConfigTokenInput(event.target.value)}
                        placeholder={adminConfig.hasSystemDefaultToken ? "••••••••••••••••" : "输入新的系统保底凭证"}
                      />
                    </label>

                    <label className="settings-card">
                      <span>启用系统保底回退</span>
                      <p>仅对白名单内且已登录的测试用户生效，普通用户永远只能使用自己的个人凭证。</p>
                      <input
                        type="checkbox"
                        checked={adminConfig.systemFallbackEnabled}
                        onChange={(event) => setAdminConfig((current) => ({ ...current, systemFallbackEnabled: event.target.checked }))}
                      />
                    </label>

                    <div className="form-actions">
                      <button type="submit" className="primary-button wide" disabled={savingAdminConfig}>
                        {savingAdminConfig ? "保存中" : "保存高级控制"}
                      </button>
                    </div>
                  </form>
                </>
              ) : null}
            </section>
          )}
        </section>

        <aside className="utility-panel play-sidebar">
          <header className="play-sidebar-header">
            <CoverArt song={currentTrack} className="play-sidebar-cover" />
            <div className="play-sidebar-title">
              <span>当前播放</span>
              <strong>{currentTrack?.title ?? "未选择曲目"}</strong>
              <p>{currentTrack ? currentTrack.artist : "从搜索结果里试听一首歌"}</p>
            </div>
          </header>

          {playerError ? <div className="player-alert">{playerError}</div> : null}

          <div className="right-tabs" role="tablist" aria-label="播放侧栏">
            <button type="button" className={rightPanelTab === "queue" ? "right-tab active" : "right-tab"} onClick={() => setRightPanelTab("queue")}>
              队列
              <strong>{playQueue.length}</strong>
            </button>
            <button type="button" className={rightPanelTab === "lyrics" ? "right-tab active" : "right-tab"} onClick={() => setRightPanelTab("lyrics")}>
              歌词
            </button>
            <button
              type="button"
              className={rightPanelTab === "comments" ? "right-tab active" : "right-tab"}
              onClick={() => {
                if (!commentTrack && currentTrack) {
                  setCommentTrack(currentTrack);
                }
                setRightPanelTab("comments");
              }}
            >
              评论
              {commentTotalLabel ? <strong>{commentTotalLabel}</strong> : null}
            </button>
          </div>

          <section className="play-sidebar-body">
            {rightPanelTab === "queue" ? (
              <div className="play-queue-list">
                {playQueue.length === 0 ? (
                  <div className="empty-box">播放队列为空，先搜索或试听一首歌。</div>
                ) : (
                  playQueue.map((song, index) => (
                    <article
                      key={song.id}
                      className={[currentTrack?.id === song.id ? "play-queue-row active" : "play-queue-row", playbackLocked ? "locked-playback-row" : ""].filter(Boolean).join(" ")}
                      title={playbackLocked ? "登录后播放" : undefined}
                      onClick={() => handlePreview(song)}
                      onContextMenu={(event) => handleOpenSongContextMenu(event, song)}
                    >
                      <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
                      <div className="queue-song-copy">
                        <strong>{song.title}</strong>
                        <span>{song.artist}</span>
                      </div>
                      <button
                        type="button"
                        className="queue-remove"
                        aria-label={`从播放队列移除 ${song.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemoveFromQueue(song.id);
                        }}
                      >
                        ×
                      </button>
                    </article>
                  ))
                )}
              </div>
            ) : null}

            {rightPanelTab === "lyrics" ? (
              <div ref={lyricPanelRef} className={hasReadableLyrics ? "lyrics-panel has-lyrics" : "lyrics-panel is-empty"} onWheel={markLyricsManualScroll} onPointerDown={markLyricsManualScroll} onTouchStart={markLyricsManualScroll}>
                {shouldShowLyricsAtmosphere ? (
                  <div
                    className="lyrics-atmosphere"
                    style={{ backgroundImage: `url("${currentTrack?.coverUrl}")` }}
                    aria-hidden="true"
                  />
                ) : null}
                {!currentTrack ? (
                  <div className="lyrics-empty-state">
                    <MusicGlyph />
                    <p>未选择曲目，播放后这里显示歌词</p>
                  </div>
                ) : null}
                {currentTrack && loadingLyrics ? <div className="empty-box">正在加载歌词...</div> : null}
                {currentTrack && !loadingLyrics && lyricsError ? <div className="empty-box">{lyricsError}</div> : null}
                {currentTrack && !loadingLyrics && !lyricsError ? (
                  <div className="lyric-lines">
                    {lyrics.map((line, index) => (
                      <button
                        type="button"
                        key={`${line.time}-${line.text}-${index}`}
                        ref={index === activeLyricIndex ? activeLyricRef : null}
                        className={index === activeLyricIndex ? "lyric-line active" : "lyric-line"}
                        onClick={() => handleSeekToLyric(line.time)}
                        title={`跳转到 ${formatPlaybackTime(line.time)}`}
                      >
                        <span>{line.text}</span>
                        {line.translation ? <small>{line.translation}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {rightPanelTab === "comments" ? (
              <div className="comments-panel">
                {!commentTrack ? (
                  <div className="comments-empty">
                    <MusicGlyph />
                    <p>先播放或右键选择一首歌，再查看评论。</p>
                  </div>
                ) : (
                  <>
                    <header className="comments-toolbar">
                      <div>
                        <span>评论区</span>
                        <strong>{commentContextLabel}</strong>
                      </div>
                      <button type="button" className="comments-refresh" disabled={loadingComments} onClick={handleRefreshSongComments}>
                        刷新
                      </button>
                    </header>

                    <div ref={commentsScrollRef} className="comments-scroll">
                      {loadingComments && !activeSongComments ? <div className="empty-box">正在加载评论...</div> : null}
                      {!activeSongComments && commentsError ? <div className="empty-box">{commentsError}</div> : null}
                      {commentActionError ? <div className="comment-action-error">{commentActionError}</div> : null}
                      {activeSongComments ? (
                        <>
                          {activeSongComments.hotComments.length > 0 ? (
                            <section className="comments-section">
                              <div className="comments-section-head">
                                <h3>热评</h3>
                              </div>
                              <div className="comments-list">
                                {activeSongComments.hotComments.map((comment) => (
                                  renderCommentRow(comment, "hot-")
                                ))}
                              </div>
                            </section>
                          ) : null}

                          <section className="comments-section">
                            <div className="comments-section-head">
                              <h3>最新评论</h3>
                            </div>
                            {activeSongComments.comments.length === 0 ? (
                              <div className="empty-box">这首歌暂时没有读取到评论。</div>
                            ) : (
                              <div className="comments-list">
                                {activeSongComments.comments.map((comment) => (
                                  renderCommentRow(comment)
                                ))}
                              </div>
                            )}
                          </section>

                          <div className="comments-pager">
                            <button type="button" disabled={commentPage <= 1 || loadingComments} onClick={() => setCommentPage((page) => Math.max(1, page - 1))}>
                              上一页
                            </button>
                            <span>第 {commentPage} 页</span>
                            <button type="button" disabled={!activeSongComments.hasMore || loadingComments} onClick={() => setCommentPage((page) => page + 1)}>
                              下一页
                            </button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </section>
        </aside>
      </main>

      {userProfileTarget ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="用户资料" onClick={closeUserProfile}>
          <section className="user-profile-card" onClick={(event) => event.stopPropagation()}>
            <div className="user-profile-hero">
              {userProfileDisplay?.backgroundUrl ? <img src={userProfileDisplay.backgroundUrl} alt="" className="user-profile-bg" /> : null}
              <div className="user-profile-shade" />
              <button type="button" className="modal-close user-profile-close" onClick={closeUserProfile} aria-label="关闭用户资料">
                ×
              </button>
              <div className="user-profile-identity">
                <div className="user-profile-avatar">
                  {userProfileAvatarUrl ? <img src={userProfileAvatarUrl} alt={userProfileName} /> : <span>{userProfileName.slice(0, 1)}</span>}
                </div>
                <div className="user-profile-title">
                  <span>网易云用户</span>
                  <h2>{userProfileName}</h2>
                </div>
              </div>
            </div>

            <div className="user-profile-body">
              {loadingUserProfile && !userProfileDisplay ? (
                <div className="user-profile-skeleton" aria-label="资料加载中">
                  <div className="profile-skeleton-line wide" />
                  <div className="profile-skeleton-line medium" />
                  <div className="profile-skeleton-stats">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="profile-skeleton-tags">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="profile-skeleton-list">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ) : null}
              {!userProfileDisplay && userProfileError ? <div className="empty-box">{userProfileError}</div> : null}
              {userProfileDisplay ? (
                <>
                  {isUserProfileHome ? (
                    <>
                      <p className="user-profile-signature">{userProfileDisplay.signature}</p>
                      <div className="user-profile-stats">
                        <div>
                          <strong>{userProfileDisplay.level}</strong>
                          <span>等级</span>
                        </div>
                        <div>
                          <strong>{formatCompactCount(userProfileDisplay.listenSongs)}</strong>
                          <span>听歌</span>
                        </div>
                        <button
                          type="button"
                          className="user-profile-stat-button"
                          onClick={() => openUserSocial("followeds")}
                        >
                          <strong>{formatCompactCount(userProfileDisplay.followeds)}</strong>
                          <span>粉丝</span>
                        </button>
                        <button
                          type="button"
                          className="user-profile-stat-button"
                          onClick={() => openUserSocial("follows")}
                        >
                          <strong>{formatCompactCount(userProfileDisplay.follows)}</strong>
                          <span>关注</span>
                        </button>
                      </div>

                      <div className="user-profile-meta">
                        <span>{formatGenderLabel(userProfileDisplay.gender)}</span>
                        {userProfileDisplay.ageText ? <span>{userProfileDisplay.ageText}</span> : null}
                        {userProfileDisplay.createdAtText ? <span>{userProfileDisplay.createdAtText} 加入</span> : null}
                        <button type="button" className="user-profile-meta-button" onClick={openUserEvents}>
                          {formatCompactCount(userProfileDisplay.eventCount)} 动态
                        </button>
                        <span>{formatCompactCount(userProfileDisplay.playlistCount)} 歌单</span>
                      </div>

                      {userProfileDisplay.playlists.length > 0 ? (
                        <section className="user-profile-playlists">
                          <div className="user-profile-section-head">
                            <h3>公开歌单</h3>
                            <span>{userProfileDisplay.playlists.length} 个</span>
                          </div>
                          <div className="user-profile-playlist-list">
                            {userProfilePlaylistGroups.map((group) => (
                              <div key={group.key} className="user-profile-playlist-group">
                                {userProfilePlaylistGroups.length > 1 ? (
                                  <div className={`user-profile-playlist-divider ${group.key}`}>
                                    <span>
                                      {group.title}
                                      <small>{group.playlists.length} 个</small>
                                    </span>
                                  </div>
                                ) : null}
                                {group.playlists.map((playlist) => (
                                  <button
                                    key={playlist.id}
                                    type="button"
                                    className="user-profile-playlist"
                                    onClick={() => openProfilePlaylist(playlist)}
                                    title={`打开歌单：${playlist.name}`}
                                  >
                                    <div className="user-profile-playlist-cover">
                                      {playlist.coverUrl ? <img src={playlist.coverUrl} alt="" loading="lazy" /> : <span>{playlist.name.slice(0, 1)}</span>}
                                    </div>
                                    <div>
                                      <strong>{playlist.name}</strong>
                                      <span>{playlist.trackCount} 首 · 播放 {formatCompactCount(playlist.playCount)}</span>
                                    </div>
                                    <em className={playlist.owned ? "owned" : "collected"}>{playlist.owned ? "创建" : "收藏"}</em>
                                  </button>
                                ))}
                              </div>
                            ))}
                          </div>
                        </section>
                      ) : null}
                    </>
                  ) : (
                    <section className="user-profile-subview">
                      <div className="user-profile-subhead">
                        <button type="button" className="user-profile-subback" onClick={backToUserProfileHome}>
                          <svg aria-hidden="true" viewBox="0 0 24 24">
                            <path d="m15 6-6 6 6 6" />
                          </svg>
                          返回资料
                        </button>
                        <div>
                          <strong>{userProfileSubTitle}</strong>
                          <span>{loadingUserSocial || loadingUserEvents ? "读取中" : userProfileSubCount}</span>
                        </div>
                      </div>

                      {userProfileView === "events" ? (
                        <div className="user-profile-events">
                          {userEventsError ? <div className="empty-box">{userEventsError}</div> : null}
                          {loadingUserEvents && !userEventsPage ? <div className="empty-box">正在读取动态...</div> : null}
                          {userEventsPage && userEventsPage.events.length > 0 ? (
                            <div className="user-event-list">
                              {userEventsPage.events.map((event) => renderUserEventCard(event))}
                            </div>
                          ) : null}
                          {userEventsPage && userEventsPage.events.length === 0 && !loadingUserEvents && !userEventsError ? (
                            <div className="empty-box">暂时没有读取到动态。</div>
                          ) : null}
                          {userEventsPage?.hasMore ? (
                            <button
                              type="button"
                              className="secondary-button compact user-social-more"
                              disabled={loadingUserEvents}
                              onClick={() => void loadUserEvents(true)}
                            >
                              {loadingUserEvents ? "读取中" : "加载更多"}
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div className="user-profile-social">
                          {userSocialError ? <div className="empty-box">{userSocialError}</div> : null}
                          {loadingUserSocial && !userSocialPage ? <div className="empty-box">正在读取好友列表...</div> : null}
                          {userSocialPage && userSocialPage.users.length > 0 ? (
                            <div className="user-social-list">
                              {userSocialPage.users.map((user) => {
                                const isSelf = accountProfile?.provider === "netease" && accountProfile.id === user.id;
                                const actionBusy = userSocialActionIds.includes(user.id);

                                return (
                                  <article key={user.id} className="user-social-row">
                                    <button
                                      type="button"
                                      className="user-social-main"
                                      onClick={() => openUserProfile({ id: user.id, fallbackName: user.nickname, fallbackAvatarUrl: user.avatarUrl })}
                                    >
                                      <span className="user-social-avatar">
                                        {user.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" /> : user.nickname.slice(0, 1)}
                                      </span>
                                      <span className="user-social-copy">
                                        <strong>{user.nickname}</strong>
                                        <small>{user.signature}</small>
                                      </span>
                                    </button>
                                    <span className={user.mutual ? "user-social-badge mutual" : "user-social-badge"}>
                                      {user.mutual ? "互关" : user.followed ? "已关注" : `${formatCompactCount(user.followeds)} 粉丝`}
                                    </span>
                                    {!isSelf ? (
                                      <button
                                        type="button"
                                        className={user.followed ? "secondary-button compact user-social-follow active" : "secondary-button compact user-social-follow"}
                                        disabled={actionBusy}
                                        onClick={() => void toggleSocialUserFollow(user)}
                                      >
                                        {actionBusy ? "处理中" : user.followed ? "取消关注" : "关注"}
                                      </button>
                                    ) : (
                                      <span className="user-social-self">自己</span>
                                    )}
                                  </article>
                                );
                              })}
                            </div>
                          ) : null}
                          {userSocialPage && userSocialPage.users.length === 0 && !loadingUserSocial && !userSocialError ? (
                            <div className="empty-box">{userProfileView === "followeds" ? "还没有读取到粉丝。" : "还没有读取到关注用户。"}</div>
                          ) : null}
                          {userSocialPage?.hasMore ? (
                            <button
                              type="button"
                              className="secondary-button compact user-social-more"
                              disabled={loadingUserSocial}
                              onClick={() => void loadUserSocial(userSocialPage.kind, userSocialPage.page + 1, true)}
                            >
                              {loadingUserSocial ? "读取中" : "加载更多"}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </section>
                  )}
                </>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {qrLoginOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="网易云扫码登录" onClick={closeQrLogin}>
          <section className="qr-login-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Netease Login</p>
                <h2>网易云登录</h2>
              </div>
              <button type="button" className="modal-close" onClick={closeQrLogin} aria-label="关闭扫码登录">
                ×
              </button>
            </header>

            <div className="qr-mode-switch" role="tablist" aria-label="网易云登录方式">
                <button type="button" className={neteaseLoginMode === "qr" ? "qr-mode-button active" : "qr-mode-button"} onClick={() => handleSwitchNeteaseLoginMode("qr")}>扫码登录</button>
                <button type="button" className={neteaseLoginMode === "cellphone" ? "qr-mode-button active" : "qr-mode-button"} onClick={() => handleSwitchNeteaseLoginMode("cellphone")}>验证码登录</button>
                <button type="button" className={neteaseLoginMode === "cookie" ? "qr-mode-button active" : "qr-mode-button"} onClick={() => handleSwitchNeteaseLoginMode("cookie")}>Cookie 导入</button>
            </div>

            {neteaseLoginMode === "qr" ? (
              <>
                <div className="qr-box">
                  {qrLoginImage ? (
                    <img src={qrLoginImage} alt="网易云扫码登录二维码" />
                  ) : (
                    <div className="qr-placeholder">{startingQrLogin ? "生成中..." : "二维码暂不可用"}</div>
                  )}
                </div>

                <div className="qr-expiry">
                  <span>有效期</span>
                  <strong>{formatPlaybackTime(qrLoginExpiresIn)}</strong>
                </div>
              </>
            ) : neteaseLoginMode === "cellphone" ? (
              <form className="cellphone-login-form" onSubmit={handleCellphoneLoginSubmit}>
                <div className="cellphone-login-row">
                  <label>
                    <span>区号</span>
                    <input
                      value={cellphoneLoginForm.countryCode}
                      onChange={(event) => setCellphoneLoginForm((current) => ({ ...current, countryCode: event.target.value.replace(/\\D/g, "").slice(0, 4) || "86" }))}
                      inputMode="numeric"
                    />
                  </label>
                  <label className="cellphone-login-phone">
                    <span>手机号</span>
                    <input
                      value={cellphoneLoginForm.phone}
                      onChange={(event) => setCellphoneLoginForm((current) => ({ ...current, phone: event.target.value.replace(/\\D/g, "").slice(0, 20) }))}
                      inputMode="numeric"
                      placeholder="请输入手机号"
                    />
                  </label>
                </div>
                <label>
                  <span>验证码</span>
                  <div className="cellphone-captcha-row">
                    <input
                      value={cellphoneLoginForm.captcha}
                      onChange={(event) => setCellphoneLoginForm((current) => ({ ...current, captcha: event.target.value.replace(/\\D/g, "").slice(0, 8) }))}
                      inputMode="numeric"
                      placeholder="短信验证码"
                    />
                    <button type="button" className="secondary-button" disabled={sendingCaptcha} onClick={() => void handleSendCaptcha()}>
                      {sendingCaptcha ? "发送中" : "发送验证码"}
                    </button>
                  </div>
                </label>
                <button type="submit" className="primary-button wide" disabled={loggingCellphoneIn}>
                  {loggingCellphoneIn ? "登录中" : "验证码登录"}
                </button>
              </form>
            ) : (
              <form className="cellphone-login-form" onSubmit={handleCookieLoginSubmit}>
                <div className="cookie-login-tools">
                  <a className="secondary-button" href="https://music.163.com/" target="_blank" rel="noreferrer">
                    打开网易云网页登录
                  </a>
                  <button type="button" className="secondary-button" onClick={() => void handleCopyCookieGuide()}>
                    {copyingCookieGuide ? "已复制" : "复制面板路径"}
                  </button>
                </div>
                <p className="cookie-login-guide">{COOKIE_LOGIN_GUIDE}</p>
                <p className="cookie-login-warning">控制台读不到 MUSIC_U 是正常的。请在 Cookies 表格里复制 MUSIC_U 的 Value/值，再粘贴到下方。</p>
                <label>
                  <span>MUSIC_U Cookie</span>
                  <textarea
                    className="cookie-login-input"
                    value={cookieLoginInput}
                    onChange={(event) => setCookieLoginInput(event.target.value)}
                    placeholder="MUSIC_U=..."
                    spellCheck={false}
                  />
                </label>
                <button type="submit" className="primary-button wide" disabled={importingCookie}>
                  {importingCookie ? "导入中" : "导入 Cookie"}
                </button>
              </form>
            )}
            <p className="qr-message">{qrLoginMessage}</p>
            <div className="qr-actions">
              {neteaseLoginMode === "qr" ? (
                <button type="button" className="secondary-button" disabled={startingQrLogin} onClick={() => void handleStartQrLogin()}>
                  重新生成
                </button>
              ) : neteaseLoginMode === "cellphone" ? (
                <button type="button" className="secondary-button" onClick={() => setCellphoneLoginForm({ countryCode: "86", phone: "", captcha: "" })}>
                  清空
                </button>
              ) : (
                <button type="button" className="secondary-button" onClick={() => setCookieLoginInput("")}>
                  清空
                </button>
              )}
              <button type="button" className="primary-button" onClick={closeQrLogin}>
                关闭
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {downloadIssue ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="下载音质不可用" onClick={() => setDownloadIssue(null)}>
          <section className="download-issue-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Download Quality</p>
                <h2>当前音质不可用</h2>
              </div>
              <button type="button" className="modal-close" onClick={() => setDownloadIssue(null)} aria-label="关闭下载提示">
                ×
              </button>
            </header>

            <div className="download-issue-song">
              <CoverArt song={downloadIssue.song} className="result-cover" />
              <div>
                <strong>{downloadIssue.song.title}</strong>
                <span>{downloadIssue.song.artist} · {downloadIssue.song.album}</span>
              </div>
              <em>{downloadIssue.attemptedLabel}</em>
            </div>

            <p className="download-issue-message">{downloadIssue.message}</p>

            <div className="download-issue-actions">
              <button type="button" className="secondary-button" onClick={() => setDownloadIssue(null)}>
                关闭
              </button>
              {isDowngradedQualityError(downloadIssue.message) && downloadIssue.attemptedLevel !== "standard" ? (
                <button type="button" className="primary-button" disabled={Boolean(directDownloadingSongId || batchDownloading)} onClick={() => void handleDownloadStandardFromIssue()}>
                  下载 128K
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {playlistPickerSong ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="收藏到歌单" onClick={() => { setPlaylistPickerSong(null); setPlaylistPickerSongs([]); setPlaylistPickerSourcePlaylistId(null); }}>
          <section className="playlist-picker-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Add To Playlist</p>
                <h2>收藏到我的歌单</h2>
              </div>
              <button type="button" className="modal-close" onClick={() => { setPlaylistPickerSong(null); setPlaylistPickerSongs([]); setPlaylistPickerSourcePlaylistId(null); }} aria-label="关闭收藏到歌单">
                ×
              </button>
            </header>

            <div className="playlist-picker-song">
              <CoverArt song={playlistPickerSong} className="result-cover" />
              <div>
                <strong>{playlistPickerSongs.length > 1 ? `已选 ${playlistPickerSongs.length} 首歌曲` : playlistPickerSong.title}</strong>
                <span>{playlistPickerSongs.length > 1 ? `${playlistPickerSong.title} 等歌曲` : `${playlistPickerSong.artist} · ${playlistPickerSong.album}`}</span>
              </div>
            </div>

            {playlistPickerError ? <p className="playlist-picker-error">{playlistPickerError}</p> : null}

            {playlistPickerLoading ? (
              <div className="empty-box">正在读取我的歌单...</div>
            ) : availablePlaylistPickerPlaylists.length > 0 ? (
              <div className="playlist-picker-list">
                {availablePlaylistPickerPlaylists.map((playlist) => (
                  <button
                    key={playlist.id}
                    type="button"
                    className="playlist-picker-option"
                    disabled={addingToPlaylistId !== null}
                    onClick={() => void handleAddSongToPlaylist(playlist)}
                  >
                    <CoverArt
                      song={{
                        id: playlist.id,
                        title: playlist.name,
                        artist: playlist.creatorName,
                        album: "歌单",
                        coverUrl: playlist.coverUrl,
                        duration: "00:00",
                        quality: "歌单",
                        availableQualities: [{ level: "standard", label: "128K" }],
                        source: "netease"
                      }}
                      className="playlist-picker-cover"
                    />
                    <span>
                      <strong>{playlist.name}</strong>
                      <small>{playlist.trackCount} 首 · {playlist.creatorName}</small>
                    </span>
                    <em>{addingToPlaylistId === playlist.id ? "添加中" : playlistPickerSongs.length > 1 ? `添加 ${playlistPickerSongs.length} 首` : "添加"}</em>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-box">
                {createdPlaylists.length > 0 && playlistPickerSourcePlaylistId
                  ? "已排除当前歌曲所在歌单，没有其它可添加的自建歌单。"
                  : "当前账号没有可编辑的自建歌单。"}
              </div>
            )}

            <div className="qr-actions">
              <button type="button" className="secondary-button" onClick={() => { setPlaylistPickerSong(null); setPlaylistPickerSongs([]); setPlaylistPickerSourcePlaylistId(null); }}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={() => { setPlaylistPickerSong(null); setPlaylistPickerSongs([]); setPlaylistPickerSourcePlaylistId(null); navigateTo("playlists"); }}>
                查看歌单
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {songContextMenu ? (
        <div
          className="song-context-menu"
          role="menu"
          aria-label={`${songContextMenu.song.title} 操作菜单`}
          style={{ left: songContextMenu.x, top: songContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="song-context-head">
            <strong>{songContextMenu.song.title}</strong>
            <span>{songContextMenu.song.artist}</span>
          </div>
          <button type="button" role="menuitem" disabled={playbackLocked} onClick={() => runSongContextAction(() => handlePreview(songContextMenu.song))}>
            <span className="song-context-icon"><PlayerIcon name="play" /></span>
            播放
          </button>
          <button type="button" role="menuitem" onClick={() => runSongContextAction(() => handleQueueSongNext(songContextMenu.song))}>
            <span className="song-context-icon"><PlayerIcon name="next" /></span>
            下一首播放
          </button>
          <button type="button" role="menuitem" onClick={() => runSongContextAction(() => openSongComments(songContextMenu.song))}>
            <span className="song-context-icon">评</span>
            查看评论
          </button>
          <div className="song-context-divider" />
          <button type="button" role="menuitem" disabled={Boolean(addingToPlaylistId)} onClick={() => runSongContextAction(() => handleOpenPlaylistPicker(songContextMenu.song))}>
            <span className="song-context-icon"><PlaylistAddIcon /></span>
            收藏到歌单
          </button>
          <button type="button" role="menuitem" disabled={Boolean(directDownloadingSongId || batchDownloading)} onClick={() => runSongContextAction(() => handleDownload(songContextMenu.song))}>
            <span className="song-context-icon"><DownloadIcon /></span>
            下载
          </button>
          <button type="button" role="menuitem" onClick={() => runSongContextAction(() => handleCopySongLink(songContextMenu.song))}>
            <span className="song-context-icon">↗</span>
            复制链接
          </button>
          {resultSource === "playlist" && activePlaylist?.owned ? (
            <>
              <div className="song-context-divider" />
              <button type="button" role="menuitem" className="danger" disabled={removingPlaylistSongs} onClick={() => runSongContextAction(() => handleRemovePlaylistSongs([songContextMenu.song.id]))}>
                <span className="song-context-icon">×</span>
                从歌单移除
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <section className={isPlayerExpanded ? "player-modal open" : "player-modal"} aria-hidden={!isPlayerExpanded}>
        <div
          className="player-modal-backdrop"
          style={currentTrack?.coverUrl ? { backgroundImage: `url("${currentTrack.coverUrl}")` } : undefined}
          aria-hidden="true"
        />
        <div className="player-modal-shade" aria-hidden="true" />

        <button type="button" className="player-modal-close" aria-label="收起播放器" onClick={() => setIsPlayerExpanded(false)}>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M6.5 9.5 12 15l5.5-5.5" />
          </svg>
        </button>

        <div className="player-modal-window">
          <div className="player-modal-grid">
            <section className="turntable-stage" aria-label="黑胶唱机">
              <div className={isPlaying ? "stylus playing" : "stylus"}>
                <span className="stylus-pivot" />
                <span className="stylus-arm" />
                <span className="stylus-head" />
              </div>

              <div className={isPlaying ? "vinyl-disc spinning" : "vinyl-disc"}>
                <div className="vinyl-rings" />
                <CoverArt song={currentTrack} className="vinyl-cover" />
              </div>
            </section>

            <section className="player-modal-content">
              <div className="player-modal-title">
                <h2 title={currentTrack?.title ?? "未选择曲目"}>{currentTrack?.title ?? "未选择曲目"}</h2>
                <div className="player-meta-row">
                  <span>专辑：{currentTrack?.album ?? "未知专辑"}</span>
                  <span>歌手：{currentTrack?.artist ?? "未知歌手"}</span>
                  <span>音质：{currentTrack ? getSelectedLabel(currentTrack) : "--"}</span>
                </div>
              </div>

              <div ref={modalLyricPanelRef} className={hasReadableLyrics ? "player-modal-lyrics has-lyrics" : "player-modal-lyrics is-empty"} onWheel={markLyricsManualScroll} onPointerDown={markLyricsManualScroll} onTouchStart={markLyricsManualScroll}>
                {!currentTrack ? (
                  <div className="modal-lyrics-empty">
                    <MusicGlyph />
                    <p>选择一首歌，歌词会显示在这里</p>
                  </div>
                ) : null}
                {currentTrack && loadingLyrics ? <div className="modal-lyrics-empty">正在加载歌词...</div> : null}
                {currentTrack && !loadingLyrics && lyricsError ? <div className="modal-lyrics-empty">{lyricsError}</div> : null}
                {currentTrack && !loadingLyrics && !lyricsError ? (
                  <div className="modal-lyric-lines">
                    {lyrics.map((line, index) => (
                      <button
                        type="button"
                        key={`modal-${line.time}-${line.text}-${index}`}
                        ref={index === activeLyricIndex ? activeModalLyricRef : null}
                        className={index === activeLyricIndex ? "modal-lyric-line active" : "modal-lyric-line"}
                        onClick={() => handleSeekToLyric(line.time)}
                        title={`跳转到 ${formatPlaybackTime(line.time)}`}
                      >
                        <span>{line.text}</span>
                        {line.translation ? <small>{line.translation}</small> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </div>

        {renderPlayerBar("modal")}
      </section>

      {renderPlayerBar("dock")}
    </div>
  );
}
