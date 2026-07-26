import { createRequire } from "node:module";
import { getClientSessionId, runWithRequestContext } from "./request-context.js";
import { getSettings, saveSettingsWithinCredentialWrite } from "./settings-store.js";
import {
  clearStoredAccountSession,
  readStoredAccountSession,
  writeStoredDemoAccountSession,
  writeStoredNeteaseAccountSession
} from "./account-session-snapshot.js";
import { findMembershipExpireAt, formatMembershipExpireText } from "./membership-utils.js";
import {
  captureCredentialWriteGuard,
  CredentialWriteCancelledError,
  invalidateCredentialWrites,
  isCredentialWriteGuardCurrent,
  runCredentialWriteIfCurrent,
  type CredentialWriteGuard
} from "./credential-write-guard.js";
import type { AccountProfile, AppSettings, AuthSession } from "./types.js";

const require = createRequire(import.meta.url);
const { login_status, vip_info, vip_info_v2 } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

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

function isVip(vipType: number | undefined) {
  return typeof vipType === "number" && vipType > 0;
}

type NeteaseApiResponse = { body: unknown };

export type AccountSessionResolverDependencies = {
  getSettings: () => Promise<AppSettings>;
  loginStatus: (input: { cookie: string }) => Promise<NeteaseApiResponse>;
  vipInfo: (input: { uid: number; cookie: string }) => Promise<NeteaseApiResponse>;
  vipInfoV2: (input: { uid: number; cookie: string }) => Promise<NeteaseApiResponse>;
  captureCredentialGuard: () => CredentialWriteGuard;
  isCredentialGuardCurrent: (guard: CredentialWriteGuard) => boolean;
  runCredentialWriteIfCurrent: typeof runCredentialWriteIfCurrent;
  readStoredSession: (neteaseCookie: string) => Promise<AuthSession>;
  writeVerifiedSession: (session: AuthSession, neteaseCookie: string) => Promise<void>;
};

export function createAccountSessionResolver(dependencies: AccountSessionResolverDependencies) {
  async function getNeteaseVipExpireAt(accountId: number | undefined, cookie: string) {
    if (!accountId) {
      return undefined;
    }

    const query = { uid: accountId, cookie };
    const responses = await Promise.allSettled([
      dependencies.vipInfoV2(query),
      dependencies.vipInfo(query)
    ]);

    for (const response of responses) {
      if (response.status !== "fulfilled") {
        continue;
      }

      const expireAt = findMembershipExpireAt(response.value.body);
      if (expireAt) {
        return expireAt;
      }
    }

    return undefined;
  }

  async function getNeteaseSession(cookie: string): Promise<AuthSession> {
    const response = await dependencies.loginStatus({ cookie });
    const body = response.body as LoginStatusBody;
    const accountId = body.data?.account?.id ?? body.account?.id ?? body.data?.profile?.userId ?? body.profile?.userId;
    const nickname = body.data?.profile?.nickname ?? body.profile?.nickname;

    if (!accountId) {
      throw new Error("网易云登录态未返回稳定账号 ID");
    }

    const vipType = body.data?.profile?.vipType ?? body.profile?.vipType ?? body.data?.account?.vipType ?? body.account?.vipType ?? body.data?.vipType ?? body.vipType ?? 0;
    const displayName = nickname?.trim() || `UID ${accountId}`;
    const vipExpireAt = await getNeteaseVipExpireAt(accountId, cookie).catch(() => undefined);
    const vipExpireText = formatMembershipExpireText(vipExpireAt);

    return {
      loggedIn: true,
      profile: {
        id: String(accountId),
        displayName,
        level: isVip(vipType) ? 10 : 0,
        vipEnabled: isVip(vipType),
        vipType,
        vipExpireAt,
        vipExpireText,
        avatarUrl: body.data?.profile?.avatarUrl ?? body.profile?.avatarUrl,
        avatarSeed: displayName.slice(0, 2),
        provider: "netease",
        bio: "网易云 Cookie 登录态",
        favoriteGenres: isVip(vipType) ? ["黑胶 VIP", "网易云音乐"] : ["网易云音乐"],
        lastLoginAt: new Date().toLocaleString("zh-CN", { hour12: false })
      }
    };
  }

  return async function resolveSession(): Promise<AuthSession> {
    const credentialGuard = dependencies.captureCredentialGuard();
    const settings = await dependencies.getSettings();
    const cookie = settings.neteaseCookie.trim();

    if (!cookie) {
      return dependencies.readStoredSession("");
    }

    try {
      const neteaseSession = await getNeteaseSession(cookie);
      await dependencies.runCredentialWriteIfCurrent(credentialGuard, async () => {
        const currentCookie = (await dependencies.getSettings()).neteaseCookie.trim();
        if (currentCookie !== cookie) {
          throw new CredentialWriteCancelledError();
        }
        await dependencies.writeVerifiedSession(neteaseSession, cookie);
      });
      return neteaseSession;
    } catch (error) {
      const currentSettings = await dependencies.getSettings();
      if (error instanceof CredentialWriteCancelledError
        || !dependencies.isCredentialGuardCurrent(credentialGuard)
        || currentSettings.neteaseCookie.trim() !== cookie) {
        return dependencies.readStoredSession(currentSettings.neteaseCookie);
      }
      throw error;
    }
  };
}

const resolveSession = createAccountSessionResolver({
  getSettings,
  loginStatus: (input) => login_status(input),
  vipInfo: (input) => vip_info(input),
  vipInfoV2: (input) => vip_info_v2(input),
  captureCredentialGuard: () => captureCredentialWriteGuard("netease"),
  isCredentialGuardCurrent: isCredentialWriteGuardCurrent,
  runCredentialWriteIfCurrent,
  readStoredSession: readStoredAccountSession,
  writeVerifiedSession: writeStoredNeteaseAccountSession
});

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
  return resolveSession();
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

  await writeStoredDemoAccountSession(session);
  return session;
}

export async function logoutSession(): Promise<AuthSession> {
  await invalidateCredentialWrites("netease", async () => {
    await saveSettingsWithinCredentialWrite({ clearNeteaseCookie: true });
    await clearStoredAccountSession();
  });
  return emptySession;
}
