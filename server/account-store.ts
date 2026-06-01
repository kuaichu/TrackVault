import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { getClientSessionId, runWithRequestContext } from "./request-context.js";
import { getSettings } from "./settings-store.js";
import type { AccountProfile, AuthSession } from "./types.js";

const require = createRequire(import.meta.url);
const { login_status } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");
const dataDir = path.resolve(process.cwd(), "data");

type LoginStatusBody = {
  data?: {
    account?: {
      id?: number;
      vipType?: number;
    } | null;
    profile?: {
      userId?: number;
      nickname?: string;
      avatarUrl?: string;
      vipType?: number;
    } | null;
    vipType?: number;
  };
  account?: {
    id?: number;
    vipType?: number;
  } | null;
  profile?: {
    userId?: number;
    nickname?: string;
    avatarUrl?: string;
    vipType?: number;
  } | null;
  vipType?: number;
};

const emptySession: AuthSession = {
  loggedIn: false,
  profile: null
};

async function ensureDataDir() {
  await fs.mkdir(dataDir, { recursive: true });
}

function getSessionPath() {
  return path.join(dataDir, `account-session.${getClientSessionId()}.json`);
}

function isVip(vipType: number | undefined) {
  return typeof vipType === "number" && vipType > 0;
}

async function getNeteaseSession(): Promise<AuthSession | null> {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();

  if (!cookie) {
    return null;
  }

  const response = await login_status({ cookie });
  const body = response.body as LoginStatusBody;
  const accountId = body.data?.account?.id ?? body.account?.id ?? body.data?.profile?.userId ?? body.profile?.userId;
  const nickname = body.data?.profile?.nickname ?? body.profile?.nickname;

  if (!accountId && !nickname) {
    return null;
  }

  const vipType = body.data?.profile?.vipType ?? body.profile?.vipType ?? body.data?.account?.vipType ?? body.account?.vipType ?? body.data?.vipType ?? body.vipType ?? 0;
  const displayName = nickname?.trim() || `UID ${accountId}`;

  return {
    loggedIn: true,
    profile: {
      id: String(accountId ?? displayName),
      displayName,
      level: isVip(vipType) ? 10 : 0,
      vipEnabled: isVip(vipType),
      vipType,
      avatarUrl: body.data?.profile?.avatarUrl ?? body.profile?.avatarUrl,
      avatarSeed: displayName.slice(0, 2),
      provider: "netease",
      bio: "网易云 Cookie 登录态",
      favoriteGenres: isVip(vipType) ? ["黑胶 VIP", "网易云音乐"] : ["网易云音乐"],
      lastLoginAt: new Date().toLocaleString("zh-CN", { hour12: false })
    }
  };
}

export async function getCurrentUserKey(): Promise<string> {
  const clientSessionId = getClientSessionId();
  const session = await getSession();
  const profile = session.profile;

  if (session.loggedIn && profile?.id) {
    return `session:${clientSessionId}:${profile.provider}:${profile.id}`;
  }

  return `guest:${clientSessionId}`;
}

export async function getSessionForClientSessionId(clientSessionId: string): Promise<AuthSession> {
  return runWithRequestContext(clientSessionId, () => getSession());
}

export async function getSession(): Promise<AuthSession> {
  await ensureDataDir();

  try {
    const neteaseSession = await getNeteaseSession();
    if (neteaseSession) {
      return neteaseSession;
    }
  } catch {
    // Fall back to the local session if the Cookie is absent or expired.
  }

  try {
    const raw = await fs.readFile(getSessionPath(), "utf8");
    return JSON.parse(raw) as AuthSession;
  } catch {
    await fs.writeFile(getSessionPath(), JSON.stringify(emptySession, null, 2), "utf8");
    return emptySession;
  }
}

export async function loginSession(input: {
  accountName: string;
  vipEnabled: boolean;
  note: string;
}): Promise<AuthSession> {
  const displayName = input.accountName.trim() || "本地账号";
  const profile: AccountProfile = {
    id: crypto.randomUUID(),
    displayName,
    level: input.vipEnabled ? 10 : 6,
    vipEnabled: Boolean(input.vipEnabled),
    avatarSeed: displayName.slice(0, 2),
    provider: "demo",
    bio: input.note.trim() || "本地登录资料卡",
    favoriteGenres: input.vipEnabled ? ["华语流行", "Live", "ACG"] : ["华语流行", "轻音乐"],
    lastLoginAt: new Date().toLocaleString("zh-CN", { hour12: false })
  };

  const session: AuthSession = {
    loggedIn: true,
    profile
  };

  await ensureDataDir();
  await fs.writeFile(getSessionPath(), JSON.stringify(session, null, 2), "utf8");
  return session;
}

export async function logoutSession(): Promise<AuthSession> {
  await ensureDataDir();
  await fs.writeFile(getSessionPath(), JSON.stringify(emptySession, null, 2), "utf8");
  return emptySession;
}
