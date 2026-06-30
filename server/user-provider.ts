import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type {
  UserEventItem,
  UserEventResource,
  UserEventsPage,
  UserFollowActionResult,
  UserProfile,
  UserProfilePlaylist,
  UserSocialListKind,
  UserSocialPage,
  UserSocialUser
} from "./types.js";

const require = createRequire(import.meta.url);
const { follow, user_detail, user_event, user_followeds, user_follows, user_mutualfollow_get, user_playlist } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi") & {
  user_event: (params: { uid: string; lasttime: number; limit: number; cookie?: string }) => Promise<{ body: unknown }>;
  user_mutualfollow_get: (params: { uid: string; cookie?: string }) => Promise<{ body: unknown }>;
  user_followeds: (params: { uid: string; limit: number; offset: number; cookie?: string }) => Promise<{ body: unknown }>;
};

type RawUserProfile = {
  userId?: number;
  nickname?: string;
  avatarUrl?: string;
  backgroundUrl?: string;
  signature?: string;
  follows?: number;
  followeds?: number;
  eventCount?: number;
  playlistCount?: number;
  gender?: number;
  province?: number;
  city?: number;
  birthday?: number;
  createTime?: number;
  vipType?: number;
};

type UserDetailBody = {
  code?: number;
  message?: string;
  msg?: string;
  level?: number;
  listenSongs?: number;
  profile?: RawUserProfile;
};

type RawUserPlaylist = {
  id?: number;
  name?: string;
  coverImgUrl?: string;
  trackCount?: number;
  playCount?: number;
  subscribed?: boolean;
  creator?: {
    userId?: number;
  };
};

type RawSocialUser = {
  userId?: number | string;
  nickname?: string;
  avatarUrl?: string;
  signature?: string;
  followed?: boolean;
  mutual?: boolean;
  followeds?: number;
  follows?: number;
};

type UserSocialBody = {
  code?: number;
  message?: string;
  msg?: string;
  follow?: RawSocialUser[];
  followeds?: RawSocialUser[];
  more?: boolean;
  size?: number;
  total?: number;
  count?: number;
};

type RawEventImage = {
  originUrl?: string;
  squareUrl?: string;
  rectangleUrl?: string;
  pcSquareUrl?: string;
  pcRectangleUrl?: string;
  url?: string;
  picUrl?: string;
};

type RawEventSong = {
  id?: number | string;
  name?: string;
  ar?: Array<{ id?: number | string; name?: string }>;
  artists?: Array<{ id?: number | string; name?: string }>;
  al?: { id?: number | string; name?: string; picUrl?: string };
  album?: { id?: number | string; name?: string; picUrl?: string };
  picUrl?: string;
  coverUrl?: string;
};

type RawEventPlaylist = {
  id?: number | string;
  name?: string;
  coverImgUrl?: string;
  coverUrl?: string;
  picUrl?: string;
  creator?: { nickname?: string };
  trackCount?: number;
};

type RawEventAlbum = {
  id?: number | string;
  name?: string;
  picUrl?: string;
  coverUrl?: string;
  artist?: { name?: string };
  artists?: Array<{ name?: string }>;
};

type RawEventVideo = {
  id?: number | string;
  vid?: number | string;
  title?: string;
  name?: string;
  coverUrl?: string;
  cover?: string;
  imgurl?: string;
  creator?: { nickname?: string };
  artistName?: string;
};

type RawEventResource = {
  id?: number | string;
  resourceId?: number | string;
  name?: string;
  title?: string;
  coverUrl?: string;
  coverImgUrl?: string;
  picUrl?: string;
  user?: { nickname?: string };
  creator?: { nickname?: string };
};

type ParsedEventJson = {
  msg?: string;
  song?: RawEventSong;
  playlist?: RawEventPlaylist;
  album?: RawEventAlbum;
  video?: RawEventVideo;
  mv?: RawEventVideo;
  resource?: RawEventResource;
  pics?: RawEventImage[];
};

type RawUserEvent = {
  id?: number | string;
  idStr?: string;
  eventId?: number | string;
  threadId?: string;
  type?: number;
  json?: string | ParsedEventJson;
  msg?: string;
  user?: RawSocialUser;
  eventTime?: number;
  showTime?: number;
  time?: number;
  pics?: RawEventImage[];
  info?: {
    likedCount?: number;
    commentCount?: number;
    shareCount?: number;
  };
  likedCount?: number;
  commentCount?: number;
  shareCount?: number;
};

type UserEventsBody = {
  code?: number;
  message?: string;
  msg?: string;
  events?: RawUserEvent[];
  lasttime?: number;
  more?: boolean;
};

function formatImageUrl(url: string | undefined, size = 240) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}

function toNumber(value: unknown) {
  const numeric = Number(value ?? 0);
  return Math.max(0, Number.isFinite(numeric) ? numeric : 0);
}

function formatGender(gender: number | undefined): UserProfile["gender"] {
  if (gender === 1) {
    return "male";
  }

  if (gender === 2) {
    return "female";
  }

  return "unknown";
}

function formatDateText(timestamp: number | undefined) {
  if (!timestamp || timestamp <= 0) {
    return undefined;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timestamp));
}

function formatEventTimeText(timestamp: number | undefined) {
  if (!timestamp || timestamp <= 0) {
    return "刚刚";
  }

  const eventDate = new Date(timestamp);
  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - eventDate.getTime());
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) {
    return "刚刚";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays} 天前`;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: eventDate.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(eventDate);
}

function formatAgeText(timestamp: number | undefined) {
  if (!timestamp || timestamp <= 0) {
    return undefined;
  }

  const birthday = new Date(timestamp);
  const now = new Date();
  let age = now.getFullYear() - birthday.getFullYear();
  const hasBirthdayPassed =
    now.getMonth() > birthday.getMonth() ||
    (now.getMonth() === birthday.getMonth() && now.getDate() >= birthday.getDate());

  if (!hasBirthdayPassed) {
    age -= 1;
  }

  if (age <= 0 || age > 120) {
    return undefined;
  }

  return `${age} 岁`;
}

function mapPlaylist(playlist: RawUserPlaylist, userId: string): UserProfilePlaylist | null {
  if (!playlist.id) {
    return null;
  }

  const creatorId = playlist.creator?.userId ? String(playlist.creator.userId) : "";

  return {
    id: String(playlist.id),
    name: playlist.name?.trim() || "未命名歌单",
    coverUrl: formatImageUrl(playlist.coverImgUrl, 120),
    trackCount: toNumber(playlist.trackCount),
    playCount: toNumber(playlist.playCount),
    owned: creatorId ? creatorId === userId : !playlist.subscribed
  };
}

function mapSocialUser(user: RawSocialUser): UserSocialUser | null {
  const id = user.userId ? String(user.userId) : "";
  if (!id) {
    return null;
  }

  return {
    id,
    nickname: user.nickname?.trim() || `UID ${id}`,
    avatarUrl: formatImageUrl(user.avatarUrl, 120),
    signature: user.signature?.trim() || "这个人还没有写签名。",
    followed: Boolean(user.followed),
    mutual: Boolean(user.mutual),
    followeds: toNumber(user.followeds),
    follows: toNumber(user.follows)
  };
}

function parseEventJson(value: RawUserEvent["json"]): ParsedEventJson {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ParsedEventJson) : {};
    } catch {
      return {};
    }
  }

  return value;
}

function joinArtistNames(artists: Array<{ name?: string }> | undefined) {
  return artists?.map((artist) => artist.name?.trim()).filter(Boolean).join(" / ") ?? "";
}

function mapEventSong(song: RawEventSong | undefined): UserEventResource | undefined {
  if (!song) {
    return undefined;
  }

  const id = song.id ? String(song.id) : "";
  const title = song.name?.trim() || "";
  if (!id && !title) {
    return undefined;
  }

  const artist = joinArtistNames(song.ar) || joinArtistNames(song.artists) || "未知歌手";
  const album = song.al?.name?.trim() || song.album?.name?.trim();

  return {
    type: "song",
    id,
    title: title || `歌曲 ${id}`,
    subtitle: album ? `${artist} · ${album}` : artist,
    coverUrl: formatImageUrl(song.al?.picUrl ?? song.album?.picUrl ?? song.picUrl ?? song.coverUrl, 120)
  };
}

function mapEventPlaylist(playlist: RawEventPlaylist | undefined): UserEventResource | undefined {
  if (!playlist) {
    return undefined;
  }

  const id = playlist.id ? String(playlist.id) : "";
  const title = playlist.name?.trim() || "";
  if (!id && !title) {
    return undefined;
  }

  return {
    type: "playlist",
    id,
    title: title || `歌单 ${id}`,
    subtitle: playlist.creator?.nickname?.trim() || (playlist.trackCount ? `${playlist.trackCount} 首歌曲` : "网易云歌单"),
    coverUrl: formatImageUrl(playlist.coverImgUrl ?? playlist.coverUrl ?? playlist.picUrl, 120)
  };
}

function mapEventAlbum(album: RawEventAlbum | undefined): UserEventResource | undefined {
  if (!album) {
    return undefined;
  }

  const id = album.id ? String(album.id) : "";
  const title = album.name?.trim() || "";
  if (!id && !title) {
    return undefined;
  }

  return {
    type: "album",
    id,
    title: title || `专辑 ${id}`,
    subtitle: album.artist?.name?.trim() || joinArtistNames(album.artists) || "网易云专辑",
    coverUrl: formatImageUrl(album.picUrl ?? album.coverUrl, 120)
  };
}

function mapEventVideo(video: RawEventVideo | undefined): UserEventResource | undefined {
  if (!video) {
    return undefined;
  }

  const id = video.vid ? String(video.vid) : video.id ? String(video.id) : "";
  const title = video.title?.trim() || video.name?.trim() || "";
  if (!id && !title) {
    return undefined;
  }

  return {
    type: "video",
    id,
    title: title || `视频 ${id}`,
    subtitle: video.creator?.nickname?.trim() || video.artistName?.trim() || "网易云视频",
    coverUrl: formatImageUrl(video.coverUrl ?? video.cover ?? video.imgurl, 120)
  };
}

function mapGenericEventResource(resource: RawEventResource | undefined): UserEventResource | undefined {
  if (!resource) {
    return undefined;
  }

  const id = resource.id ? String(resource.id) : resource.resourceId ? String(resource.resourceId) : "";
  const title = resource.title?.trim() || resource.name?.trim() || "";
  if (!id && !title) {
    return undefined;
  }

  return {
    type: "resource",
    id,
    title: title || `资源 ${id}`,
    subtitle: resource.creator?.nickname?.trim() || resource.user?.nickname?.trim() || "网易云资源",
    coverUrl: formatImageUrl(resource.coverUrl ?? resource.coverImgUrl ?? resource.picUrl, 120)
  };
}

function getEventFallbackText(type: number | undefined, resource: UserEventResource | undefined) {
  if (resource?.type === "song") {
    return `分享单曲：${resource.title}`;
  }

  if (resource?.type === "playlist") {
    return `分享歌单：${resource.title}`;
  }

  if (resource?.type === "album") {
    return `分享专辑：${resource.title}`;
  }

  if (resource?.type === "video") {
    return `分享视频：${resource.title}`;
  }

  if (type === 22) {
    return "转发了一条动态";
  }

  return "发布了一条动态";
}

function mapUserEvent(event: RawUserEvent, fallbackUserId: string): UserEventItem | null {
  const parsed = parseEventJson(event.json);
  const resource =
    mapEventSong(parsed.song) ??
    mapEventPlaylist(parsed.playlist) ??
    mapEventAlbum(parsed.album) ??
    mapEventVideo(parsed.video) ??
    mapEventVideo(parsed.mv) ??
    mapGenericEventResource(parsed.resource);
  const rawUser = event.user;
  const userId = rawUser?.userId ? String(rawUser.userId) : fallbackUserId;
  const rawTime = Number(event.eventTime ?? event.showTime ?? event.time ?? 0);
  const time = Number.isFinite(rawTime) && rawTime > 0 ? rawTime : undefined;
  const rawPics = event.pics ?? parsed.pics ?? [];
  const pics = rawPics
    .map((pic) => formatImageUrl(pic.originUrl ?? pic.pcSquareUrl ?? pic.squareUrl ?? pic.pcRectangleUrl ?? pic.rectangleUrl ?? pic.url ?? pic.picUrl, 240))
    .filter((url): url is string => Boolean(url));
  const id = event.idStr ?? (event.eventId ? String(event.eventId) : event.id ? String(event.id) : event.threadId ?? `${userId}-${time ?? Date.now()}`);
  const text = parsed.msg?.trim() || event.msg?.trim() || getEventFallbackText(event.type, resource);

  return {
    id,
    userId,
    nickname: rawUser?.nickname?.trim() || `UID ${userId}`,
    avatarUrl: formatImageUrl(rawUser?.avatarUrl, 120),
    text,
    timeText: formatEventTimeText(time),
    time,
    type: event.type,
    pics,
    resource,
    likedCount: toNumber(event.info?.likedCount ?? event.likedCount),
    commentCount: toNumber(event.info?.commentCount ?? event.commentCount),
    shareCount: toNumber(event.info?.shareCount ?? event.shareCount)
  };
}

async function getNeteaseRequestConfig(options: { requireCookie?: boolean } = {}) {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();

  if (options.requireCookie && !cookie) {
    throw new Error("需要先配置有效的网易云 Cookie。");
  }

  return cookie ? { cookie } : {};
}

export async function getUserProfile(userId: string): Promise<UserProfile> {
  const safeUserId = userId.trim();
  if (!safeUserId) {
    throw new Error("缺少用户 ID。");
  }

  const requestConfig = await getNeteaseRequestConfig();
  const [detailResponse, playlistResponse] = await Promise.all([
    user_detail({ uid: safeUserId, ...requestConfig }),
    user_playlist({ uid: safeUserId, limit: 6, offset: 0, ...requestConfig }).catch(() => ({ body: {} }))
  ]);

  const detailBody = detailResponse.body as UserDetailBody;
  if (typeof detailBody.code === "number" && detailBody.code !== 200) {
    throw new Error(detailBody.message ?? detailBody.msg ?? `获取用户信息失败：${detailBody.code}`);
  }

  const profile = detailBody.profile;
  if (!profile) {
    throw new Error("没有读取到用户资料。");
  }

  const rawPlaylists = ((playlistResponse.body as { playlist?: RawUserPlaylist[] }).playlist ?? []) as RawUserPlaylist[];
  const playlists = rawPlaylists
    .map((playlist) => mapPlaylist(playlist, safeUserId))
    .filter((playlist): playlist is UserProfilePlaylist => Boolean(playlist));

  return {
    id: String(profile.userId ?? safeUserId),
    nickname: profile.nickname?.trim() || `UID ${safeUserId}`,
    avatarUrl: formatImageUrl(profile.avatarUrl, 240),
    backgroundUrl: formatImageUrl(profile.backgroundUrl, 720),
    signature: profile.signature?.trim() || "这个人还没有写签名。",
    level: toNumber(detailBody.level),
    listenSongs: toNumber(detailBody.listenSongs),
    follows: toNumber(profile.follows),
    followeds: toNumber(profile.followeds),
    eventCount: toNumber(profile.eventCount),
    playlistCount: toNumber(profile.playlistCount),
    gender: formatGender(profile.gender),
    province: profile.province,
    city: profile.city,
    ageText: formatAgeText(profile.birthday),
    createdAtText: formatDateText(profile.createTime),
    vipType: profile.vipType,
    playlists
  };
}

export async function getUserSocialList(userId: string, kind: UserSocialListKind, page = 1, limit = 30): Promise<UserSocialPage> {
  const safeUserId = userId.trim();
  if (!safeUserId) {
    throw new Error("缺少用户 ID。");
  }

  const safeKind: UserSocialListKind = kind === "followeds" ? "followeds" : "follows";
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeLimit = Math.min(60, Math.max(1, Math.floor(Number(limit) || 30)));
  const offset = (safePage - 1) * safeLimit;
  const requestConfig = await getNeteaseRequestConfig();
  const response = safeKind === "followeds"
    ? await user_followeds({ uid: safeUserId, limit: safeLimit, offset, ...requestConfig })
    : await user_follows({ uid: safeUserId, limit: safeLimit, offset, ...requestConfig });
  const body = response.body as UserSocialBody;

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `获取用户社交列表失败：${body.code}`);
  }

  const rawUsers = safeKind === "followeds" ? body.followeds ?? [] : body.follow ?? [];
  const users = rawUsers
    .map(mapSocialUser)
    .filter((user): user is UserSocialUser => Boolean(user));
  const total = body.total ?? body.size ?? body.count;

  return {
    userId: safeUserId,
    kind: safeKind,
    users,
    page: safePage,
    limit: safeLimit,
    total,
    hasMore: Boolean(body.more ?? users.length >= safeLimit)
  };
}

export async function getUserEvents(userId: string, lasttime = -1, limit = 20): Promise<UserEventsPage> {
  const safeUserId = userId.trim();
  if (!safeUserId) {
    throw new Error("缺少用户 ID。");
  }

  const safeLasttime = Number.isFinite(Number(lasttime)) ? Number(lasttime) : -1;
  const safeLimit = Math.min(30, Math.max(1, Math.floor(Number(limit) || 20)));
  const requestConfig = await getNeteaseRequestConfig();
  const response = await user_event({
    uid: safeUserId,
    lasttime: safeLasttime,
    limit: safeLimit,
    ...requestConfig
  });
  const body = response.body as UserEventsBody;

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `获取用户动态失败：${body.code}`);
  }

  const events = (body.events ?? [])
    .map((event) => mapUserEvent(event, safeUserId))
    .filter((event): event is UserEventItem => Boolean(event));

  return {
    userId: safeUserId,
    events,
    lasttime: body.lasttime,
    hasMore: Boolean(body.more ?? events.length >= safeLimit)
  };
}

export async function getUserMutualFollow(userId: string) {
  const safeUserId = userId.trim();
  if (!safeUserId) {
    throw new Error("缺少用户 ID。");
  }

  const requestConfig = await getNeteaseRequestConfig({ requireCookie: true });
  const response = await user_mutualfollow_get({ uid: safeUserId, ...requestConfig });
  const body = response.body as { code?: number; message?: string; msg?: string; data?: unknown; mutual?: unknown; follow?: unknown };

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `获取互关状态失败：${body.code}`);
  }

  return {
    userId: safeUserId,
    mutual: Boolean(body.data ?? body.mutual ?? body.follow)
  };
}

export async function setUserFollowed(userId: string, shouldFollow: boolean): Promise<UserFollowActionResult> {
  const safeUserId = userId.trim();
  if (!safeUserId) {
    throw new Error("缺少用户 ID。");
  }

  const requestConfig = await getNeteaseRequestConfig({ requireCookie: true });
  const response = await follow({ id: safeUserId, t: shouldFollow ? 1 : 0, ...requestConfig });
  const body = response.body as { code?: number; message?: string; msg?: string };

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `${shouldFollow ? "关注" : "取消关注"}失败：${body.code}`);
  }

  return {
    userId: safeUserId,
    followed: shouldFollow
  };
}
