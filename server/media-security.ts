import { getSessionForClientSessionId } from "./account-store.js";
import { getClientSessionId } from "./request-context.js";
import { getStoredAdminConfig, getSettingsForClientSessionId } from "./settings-store.js";

export class MediaAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "MediaAccessError";
    this.status = status;
  }
}

export type MediaCredentialPlan = {
  clientSessionId: string;
  primaryCookie: string;
  fallbackCookie: string;
  trustedUser: boolean;
};

export async function buildMediaCredentialPlan(options: { clientSessionId?: string; userCookieOverride?: string } = {}): Promise<MediaCredentialPlan> {
  const clientSessionId = sanitizeSessionId(options.clientSessionId ?? getClientSessionId());
  const session = await getSessionForClientSessionId(clientSessionId);

  if (!session.loggedIn || !session.profile?.id) {
    throw new MediaAccessError(401, "Unauthorized: Login Required");
  }

  const [settings, adminConfig] = await Promise.all([
    getSettingsForClientSessionId(clientSessionId),
    getStoredAdminConfig()
  ]);
  const personalCookie = (options.userCookieOverride ?? settings.neteaseCookie).trim();
  const trustedUser = adminConfig.trustedUserWhitelist.includes(session.profile.id);
  const fallbackCookie =
    trustedUser && adminConfig.systemFallbackEnabled
      ? adminConfig.systemDefaultToken.trim()
      : "";

  if (!trustedUser && !personalCookie) {
    throw new MediaAccessError(403, "普通登录用户必须上传自己的个人凭证后才能请求媒体资源。");
  }

  if (trustedUser && !personalCookie && !fallbackCookie) {
    throw new MediaAccessError(403, "当前白名单用户既没有个人凭证，系统保底凭证也未启用。");
  }

  return {
    clientSessionId,
    primaryCookie: personalCookie,
    fallbackCookie: fallbackCookie && fallbackCookie !== personalCookie ? fallbackCookie : "",
    trustedUser
  };
}

export function extractClientSessionIdFromUserKey(userKey: string) {
  const match = /^(?:session|guest):([^:]+)/.exec(userKey.trim());
  return sanitizeSessionId(match?.[1] ?? "default");
}

function sanitizeSessionId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
}
