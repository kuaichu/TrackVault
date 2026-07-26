import { getSession } from "./account-store.js";
import { readStoredVerifiedIdentityState } from "./account-session-snapshot.js";
import { getClientSessionId } from "./request-context.js";
import { getSettings } from "./settings-store.js";
import type { AccountState, AuthSession } from "./types.js";

type DataScopeSession = {
  loggedIn: boolean;
  profile: {
    id: string;
    provider: "demo" | "netease";
  } | null;
};

function normalizeScopePart(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 160);
  return normalized || fallback;
}

export function extractQqMusicUin(cookie: string) {
  const values = new Map<string, string>();
  cookie
    .replace(/\r?\n+/g, "; ")
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const equalIndex = part.indexOf("=");
      const colonIndex = part.indexOf(":");
      const separatorIndex = equalIndex >= 0 ? equalIndex : colonIndex;
      if (separatorIndex <= 0) {
        return;
      }

      const key = part.slice(0, separatorIndex).trim().replace(/^"+|"+$/g, "");
      const value = part.slice(separatorIndex + 1).trim().replace(/^"+|"+$/g, "");
      if (key && value) {
        values.set(key, value);
      }
    });

  const rawUin = Number(values.get("login_type")) === 2
    ? values.get("wxuin") || values.get("uin")
    : values.get("uin") || values.get("wxuin");
  const match = (rawUin || "").trim().match(/^o?(\d+)$/);
  return match?.[1] ?? null;
}

export function resolveDataScopeId(input: {
  session: DataScopeSession;
  qqMusicUin?: string | null;
  clientSessionId: string;
}) {
  const profile = input.session.profile;
  if (input.session.loggedIn && profile?.id) {
    return `account:${profile.provider}:${normalizeScopePart(profile.id, "unknown")}`;
  }

  if (input.qqMusicUin && /^\d+$/.test(input.qqMusicUin)) {
    return `account:qqmusic:${input.qqMusicUin}`;
  }

  return `guest:${normalizeScopePart(input.clientSessionId, "default")}`;
}

export async function getDataScopeId(sessionOverride?: AuthSession) {
  const [session, settings] = await Promise.all([
    sessionOverride ? Promise.resolve(sessionOverride) : getSession(),
    getSettings()
  ]);
  const identityState = await readStoredVerifiedIdentityState({
    neteaseCookie: settings.neteaseCookie,
    qqMusicCookie: settings.qqMusicCookie ?? ""
  });
  return resolveDataScopeId({
    session,
    qqMusicUin: identityState.qqMusicUin,
    clientSessionId: getClientSessionId()
  });
}

export async function getAccountState(sessionOverride?: AuthSession): Promise<AccountState> {
  const session = sessionOverride ?? await getSession();
  return {
    ...session,
    dataScopeId: await getDataScopeId(session)
  };
}
