import crypto from "node:crypto";
import { checkQqMusicCookie } from "./qqmusic-provider.js";
import { getSettings, saveSettings } from "./settings-store.js";
import type { QqMusicAccountStatus } from "./types.js";

const QQ_LOGIN_APP_ID = "1006102";
const QQ_LOGIN_DAID = "384";
const QQ_LOGIN_STYLE = "40";
const QQ_LOGIN_LANG = "2052";
const QQ_LOGIN_VERSION = "26030415";
const QQ_LOGIN_JS_VERSION = "b515fdc3";
const QQ_LOGIN_CALLBACK_URL = "https://y.qq.com/portal/close.html";
const QQ_LOGIN_REFERER = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin";
const QQ_LOGIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const QQ_QR_SESSION_TTL_MS = 5 * 60 * 1000;

type QqQrSession = {
  qrsig: string;
  loginSig: string;
  cookies: Map<string, string>;
  createdAt: number;
};

type PtuiCallback = {
  code: string;
  redirectUrl: string;
  message: string;
  nickname?: string;
};

export type QqMusicQrStartResult = {
  key: string;
  qrImage: string;
};

export type QqMusicQrCheckResult = {
  code: number;
  message: string;
  cookie?: string;
  account?: QqMusicAccountStatus;
};

const qrSessions = new Map<string, QqQrSession>();

function cleanupQrSessions() {
  const now = Date.now();
  for (const [key, session] of qrSessions.entries()) {
    if (now - session.createdAt > QQ_QR_SESSION_TTL_MS) {
      qrSessions.delete(key);
    }
  }
}

function cookiePairs(cookies: Map<string, string>) {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function setCookieHeaders(headers: Headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const header = headers.get("set-cookie");
  return header ? [header] : [];
}

function mergeSetCookies(cookies: Map<string, string>, headers: Headers) {
  for (const setCookie of setCookieHeaders(headers)) {
    const pair = setCookie.split(";")[0];
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (key && value) {
      cookies.set(key, value);
    }
  }
}

function hash33(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash += (hash << 5) + input.charCodeAt(index);
  }

  return hash & 0x7fffffff;
}

function parsePtuiCallback(input: string): PtuiCallback {
  const matches = [...input.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return {
    code: matches[0] ?? "",
    redirectUrl: matches[2] ?? "",
    message: matches[4] ?? "正在等待扫码确认。",
    nickname: matches[5]
  };
}

function getQqQrMessage(code: string, fallback: string) {
  switch (code) {
    case "0":
      return "登录成功，正在同步 QQ 音乐登录态。";
    case "65":
      return "二维码已过期，请重新生成。";
    case "66":
      return "等待 QQ 手机版扫码。";
    case "67":
      return "已扫码，请在手机 QQ 上确认登录。";
    case "23013":
      return `${fallback} 当前 QQ 登录接口拒绝服务端扫码轮询，请暂时使用 Cookie 导入。`;
    default:
      return fallback || "正在等待 QQ 扫码确认。";
  }
}

function getXloginUrl() {
  const params = new URLSearchParams({
    daid: QQ_LOGIN_DAID,
    pt_no_auth: "1",
    style: QQ_LOGIN_STYLE,
    appid: QQ_LOGIN_APP_ID,
    s_url: QQ_LOGIN_CALLBACK_URL,
    low_login: "1",
    target: "self"
  });

  return `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?${params.toString()}`;
}

async function fetchWithLoginHeaders(url: string, cookies?: Map<string, string>, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", QQ_LOGIN_USER_AGENT);
  headers.set("Referer", QQ_LOGIN_REFERER);
  if (cookies?.size) {
    headers.set("Cookie", cookiePairs(cookies));
  }

  return fetch(url, {
    ...init,
    headers
  });
}

export async function startQqMusicQrLogin(): Promise<QqMusicQrStartResult> {
  cleanupQrSessions();

  const cookies = new Map<string, string>();
  const xloginResponse = await fetchWithLoginHeaders(getXloginUrl(), cookies, {
    headers: {
      Referer: "https://y.qq.com/portal/pop_login.html"
    }
  });
  mergeSetCookies(cookies, xloginResponse.headers);

  const loginSig = cookies.get("pt_login_sig") ?? "";
  const qrParams = new URLSearchParams({
    appid: QQ_LOGIN_APP_ID,
    e: "2",
    l: "M",
    s: "3",
    d: "72",
    v: "4",
    t: String(Math.random()),
    daid: QQ_LOGIN_DAID,
    u1: QQ_LOGIN_CALLBACK_URL
  });
  const qrResponse = await fetchWithLoginHeaders(`https://ssl.ptlogin2.qq.com/ptqrshow?${qrParams.toString()}`, cookies);

  if (!qrResponse.ok) {
    throw new Error("QQ 音乐登录二维码生成失败。");
  }

  mergeSetCookies(cookies, qrResponse.headers);
  const qrsig = cookies.get("qrsig");
  if (!qrsig) {
    throw new Error("QQ 音乐登录二维码生成失败，未获取到 qrsig。");
  }

  const qrBytes = Buffer.from(await qrResponse.arrayBuffer());
  const key = crypto.randomUUID();
  qrSessions.set(key, {
    qrsig,
    loginSig,
    cookies,
    createdAt: Date.now()
  });

  return {
    key,
    qrImage: `data:image/png;base64,${qrBytes.toString("base64")}`
  };
}

async function followLoginRedirect(redirectUrl: string, cookies: Map<string, string>) {
  let nextUrl = redirectUrl;
  for (let index = 0; index < 4; index += 1) {
    const response = await fetchWithLoginHeaders(nextUrl, cookies, {
      redirect: "manual"
    });
    mergeSetCookies(cookies, response.headers);

    const location = response.headers.get("location");
    if (!location) {
      break;
    }

    nextUrl = new URL(location, nextUrl).toString();
  }
}

async function persistQqCookie(cookie: string) {
  const checkResult = await checkQqMusicCookie(cookie);
  if (!checkResult.ok) {
    throw new Error(checkResult.message);
  }

  const settings = await getSettings();
  await saveSettings({
    ...settings,
    qqMusicCookie: checkResult.refreshedCookie ?? cookie
  });

  return {
    cookie: checkResult.refreshedCookie ?? cookie,
    account: {
      ok: true,
      uin: checkResult.uin,
      displayName: checkResult.uin ? `QQ ${checkResult.uin}` : null,
      vipEnabled: false,
      message: checkResult.message
    } satisfies QqMusicAccountStatus
  };
}

export async function checkQqMusicQrLogin(key: string): Promise<QqMusicQrCheckResult> {
  cleanupQrSessions();

  const session = qrSessions.get(key.trim());
  if (!session) {
    return {
      code: 65,
      message: "二维码已过期，请重新生成。"
    };
  }

  const params = new URLSearchParams({
    u1: QQ_LOGIN_CALLBACK_URL,
    ptqrtoken: String(hash33(session.qrsig)),
    ptredirect: "0",
    h: "1",
    t: "1",
    g: "1",
    from_ui: "1",
    ptlang: QQ_LOGIN_LANG,
    action: `0-0-${Date.now()}`,
    js_ver: QQ_LOGIN_VERSION,
    js_type: "1",
    login_sig: session.loginSig,
    pt_uistyle: QQ_LOGIN_STYLE,
    low_login_enable: "1",
    low_login_hour: "720",
    aid: QQ_LOGIN_APP_ID,
    daid: QQ_LOGIN_DAID,
    o1vId: "",
    pt_js_version: QQ_LOGIN_JS_VERSION
  });
  const response = await fetchWithLoginHeaders(`https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`, session.cookies);
  const body = await response.text();
  const result = parsePtuiCallback(body);
  const code = result.code ? Number(result.code) : -1;

  if (result.code !== "0" || !result.redirectUrl) {
    return {
      code,
      message: getQqQrMessage(result.code, result.message)
    };
  }

  await followLoginRedirect(result.redirectUrl, session.cookies);
  qrSessions.delete(key.trim());

  const cookie = cookiePairs(session.cookies);
  const persisted = await persistQqCookie(cookie);
  return {
    code: 0,
    message: result.nickname ? `QQ 音乐扫码登录成功：${result.nickname}` : "QQ 音乐扫码登录成功。",
    cookie: persisted.cookie,
    account: persisted.account
  };
}
