import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { UserFollowActionResult, UserProfile, UserProfilePlaylist, UserSocialListKind, UserSocialPage, UserSocialUser } from "./types.js";

const require = createRequire(import.meta.url);
const { follow, user_detail, user_followeds, user_follows, user_mutualfollow_get, user_playlist } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi") & {
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

function formatImageUrl(url: string | undefined, size = 240) {
  const trimmed = url?.trim();
  if (!trimmed) {
    return undefined;
  }

  return `${trimmed}?param=${size}y${size}`;
}

function toNumber(value: number | undefined) {
  return Math.max(0, Number.isFinite(value) ? Number(value) : 0);
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
