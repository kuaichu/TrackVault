import { createRequire } from "node:module";
import { getCurrentUserKey } from "./account-store.js";
import { getSettings } from "./settings-store.js";

const require = createRequire(import.meta.url);
const { like, likelist, login_status } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type LoginStatusBody = {
  data?: {
    account?: {
      id?: number;
    } | null;
    profile?: {
      userId?: number;
    } | null;
  };
  account?: {
    id?: number;
  } | null;
  profile?: {
    userId?: number;
  } | null;
};

const LIKE_LIST_CACHE_TTL_MS = 60 * 1000;
const likeListCache = new Map<string, { expiresAt: number; ids: string[] }>();

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("当前操作需要有效的网易云 Cookie，请先登录或重新扫码。");
  }

  return cookie;
}

async function getCurrentNeteaseUid(cookie: string) {
  const response = await login_status({ cookie });
  const body = response.body as LoginStatusBody;
  const uid = body.data?.profile?.userId ?? body.profile?.userId ?? body.data?.account?.id ?? body.account?.id;

  if (!uid) {
    throw new Error("Cookie 未通过登录态校验，请重新登录网易云。");
  }

  return String(uid);
}

async function fetchLikeList(force = false) {
  const userKey = await getCurrentUserKey();
  const cached = likeListCache.get(userKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.ids;
  }

  const cookie = await getCookie();
  const uid = await getCurrentNeteaseUid(cookie);
  const response = await likelist({ uid, cookie });
  const ids = Array.isArray((response.body as { ids?: number[] | string[] }).ids)
    ? ((response.body as { ids?: number[] | string[] }).ids ?? []).map((id) => String(id))
    : [];

  likeListCache.set(userKey, {
    expiresAt: Date.now() + LIKE_LIST_CACHE_TTL_MS,
    ids
  });

  return ids;
}

export async function isSongLiked(songId: string) {
  const ids = await fetchLikeList();
  return ids.includes(songId);
}

export async function toggleSongLike(songId: string, shouldLike: boolean) {
  const cookie = await getCookie();
  const response = await like({
    id: songId,
    like: shouldLike,
    cookie
  });

  const body = response.body as { code?: number };
  if (body.code !== 200) {
    throw new Error(shouldLike ? "加入喜欢失败" : "取消喜欢失败");
  }

  const userKey = await getCurrentUserKey();
  const currentIds = await fetchLikeList(true);
  const nextIds = shouldLike
    ? Array.from(new Set([songId, ...currentIds]))
    : currentIds.filter((id) => id !== songId);

  likeListCache.set(userKey, {
    expiresAt: Date.now() + LIKE_LIST_CACHE_TTL_MS,
    ids: nextIds
  });

  return { liked: shouldLike };
}
