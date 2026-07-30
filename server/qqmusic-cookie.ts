export const QQ_UIN_FIELDS = "uin/wxuin";
export const QQ_KEY_FIELDS = "qm_keyst/qqmusic_key";

export type QqCookieValidation = {
  cookie: Record<string, string>;
  missingFields: string[];
};

export function parseQqCookie(cookie: string) {
  const cookieObj: Record<string, string> = {};
  cookie
    .replace(/\r?\n+/g, "; ")
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const equalIndex = part.indexOf("=");
      const colonIndex = part.indexOf(":");
      const separatorIndex = equalIndex >= 0 ? equalIndex : colonIndex;
      if (separatorIndex <= 0) return;
      const key = part.slice(0, separatorIndex).trim().replace(/^"+|"+$/g, "");
      const value = part.slice(separatorIndex + 1).trim().replace(/^"+|"+$/g, "");
      if (key && value) cookieObj[key] = value;
    });

  if (Number(cookieObj.login_type) === 2 && cookieObj.wxuin) {
    cookieObj.uin = /^o\d+$/.test(cookieObj.wxuin)
      ? cookieObj.wxuin.slice(1)
      : /^\d+$/.test(cookieObj.wxuin) ? cookieObj.wxuin : "";
  } else {
    const uin = cookieObj.uin || "";
    cookieObj.uin = /^o\d+$/.test(uin) ? uin.slice(1) : /^\d+$/.test(uin) ? uin : "";
  }
  return cookieObj;
}

export function validateQqCookie(cookie: string): QqCookieValidation {
  const parsed = parseQqCookie(cookie);
  const missingFields: string[] = [];
  if (!parsed.uin) missingFields.push(QQ_UIN_FIELDS);
  if (!parsed.qm_keyst && !parsed.qqmusic_key) missingFields.push(QQ_KEY_FIELDS);
  return { cookie: parsed, missingFields };
}

export function getQqCookieMissingFieldsMessage(missingFields: string[]) {
  return missingFields.length ? `QQ 音乐 Cookie 缺少 ${missingFields.join("、")}` : "";
}
