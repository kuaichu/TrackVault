import crypto from "node:crypto";
import type { QrCheckResult, QrStartResult } from "#shared";
import { AppError } from "../../../domain/errors.js";
import type { SafeHttpClient } from "../../security/safe-http-client.js";
import { computeQqGtk, hash33, serializeQqCookie } from "./qq-cookie.js";

const QQ_LOGIN_APP_ID = "1006102";
const QQ_LOGIN_DAID = "384";
const QQ_OAUTH_CLIENT_ID = "100497308";
const QQ_OAUTH_REDIRECT_URI = "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const QQ_LOGIN_CALLBACK_URL = "https://y.qq.com/portal/close.html";
const QQ_LOGIN_REFERER = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin";
const QQ_LOGIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const QR_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_QR_SESSIONS = 100;
const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_QR_TEXT_BYTES = 256 * 1024;
const QR_ALLOWED_HOSTS = ["qq.com", "y.qq.com"] as const;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

interface QqQrSession {
  scopeKey: string;
  qrsig: string;
  loginSig: string;
  cookies: Map<string, string>;
  createdAt: number;
  completing: boolean;
}

function mergeSetCookies(cookies: Map<string, string>, headers: Headers): void {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const header of list) {
    const pair = header.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!key) continue;
    if (!value) cookies.delete(key);
    else cookies.set(key, value);
  }
}

function parsePtuiCallback(input: string): {
  code: string;
  redirectUrl: string;
  message: string;
  nickname?: string;
} {
  const matches = [...input.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
  return {
    code: matches[0] ?? "",
    redirectUrl: matches[2] ?? "",
    message: matches[4] ?? "等待扫码确认。",
    nickname: matches[5],
  };
}

/**
 * Scope-bound, bounded-memory QQ QR login manager.
 * Uses SafeHttpClient so login redirects can NEVER leak QQ session cookies to non-QQ hosts.
 */
export class QqQrAuthManager {
  readonly #http: SafeHttpClient;
  readonly #sessions = new Map<string, QqQrSession>();

  constructor(http: SafeHttpClient) {
    this.#http = http;
  }

  #cleanup(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions.entries()) {
      if (now - session.createdAt > QR_TTL_MS) {
        this.#sessions.delete(key);
      }
    }
    while (this.#sessions.size >= MAX_ACTIVE_QR_SESSIONS) {
      const oldest = this.#sessions.keys().next().value;
      if (!oldest) break;
      this.#sessions.delete(oldest);
    }
  }

  async start(scopeKey: string): Promise<QrStartResult> {
    this.#cleanup();
    const cookies = new Map<string, string>();

    const xloginParams = new URLSearchParams({
      daid: QQ_LOGIN_DAID,
      pt_no_auth: "1",
      style: "40",
      appid: QQ_LOGIN_APP_ID,
      s_url: QQ_LOGIN_CALLBACK_URL,
      low_login: "1",
      target: "self",
    });

    const { response: xloginRes } = await this.#http.fetchResponse(
      `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?${xloginParams.toString()}`,
      {
        headers: { "User-Agent": QQ_LOGIN_USER_AGENT, Referer: "https://y.qq.com/portal/pop_login.html" },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 0,
      },
    );
    mergeSetCookies(cookies, xloginRes.headers);
    await xloginRes.body?.cancel().catch(() => undefined);

    const qrParams = new URLSearchParams({
      appid: QQ_LOGIN_APP_ID,
      e: "2",
      l: "M",
      s: "3",
      d: "72",
      v: "4",
      t: String(Math.random()),
      daid: QQ_LOGIN_DAID,
      u1: QQ_LOGIN_CALLBACK_URL,
    });

    const { bytes: qrRawBytes, headers: qrHeaders } = await this.#http.fetchBoundedBytes(
      `https://ssl.ptlogin2.qq.com/ptqrshow?${qrParams.toString()}`,
      {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: QQ_LOGIN_REFERER,
          Cookie: serializeQqCookie(Object.fromEntries(cookies)),
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 0,
        maxBytes: MAX_QR_IMAGE_BYTES,
      },
    );

    mergeSetCookies(cookies, qrHeaders);
    const qrsig = cookies.get("qrsig");
    if (!qrsig) {
      throw new AppError("UPSTREAM_ERROR", "QQ 音乐二维码缺少 qrsig。");
    }

    const qrBytes = Buffer.from(qrRawBytes);
    const key = crypto.randomUUID();
    this.#sessions.set(key, {
      scopeKey,
      qrsig,
      loginSig: cookies.get("pt_login_sig") ?? "",
      cookies,
      createdAt: Date.now(),
      completing: false,
    });

    return { key, qrImage: `data:image/png;base64,${qrBytes.toString("base64")}` };
  }

  async #exchangeMusicKey(cookies: Map<string, string>): Promise<boolean> {
    if (cookies.get("qm_keyst") || cookies.get("qqmusic_key")) {
      return true;
    }
    const cookieObj = Object.fromEntries(cookies);
    const gtk = computeQqGtk(cookieObj);
    const authorizeBody = new URLSearchParams({
      response_type: "code",
      client_id: QQ_OAUTH_CLIENT_ID,
      redirect_uri: QQ_OAUTH_REDIRECT_URI,
      scope: "get_user_info",
      state: "state",
      switch: "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi: "80901010_1030",
      g_tk: String(gtk),
      auth_time: String(Date.now()),
      ui: crypto.randomUUID(),
    }).toString();

    const { response: authRes } = await this.#http.fetchResponse("https://graph.qq.com/oauth2.0/authorize", {
      method: "POST",
      headers: {
        "User-Agent": QQ_LOGIN_USER_AGENT,
        Referer: "https://graph.qq.com/oauth2.0/show",
        Origin: "https://graph.qq.com",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: serializeQqCookie(cookieObj),
      },
      body: authorizeBody,
      allowedHostSuffixes: QR_ALLOWED_HOSTS,
      allowHttp: false,
      maxRedirects: 0,
      redirectMode: "manual",
      stripSensitiveHeadersOnHostChange: false,
    });
    mergeSetCookies(cookies, authRes.headers);
    const location = authRes.headers.get("location");
    await authRes.body?.cancel().catch(() => undefined);

    if (!location) {
      return Boolean(cookies.get("qm_keyst") || cookies.get("qqmusic_key"));
    }

    let oauthCode = "";
    try {
      oauthCode = new URL(location, "https://graph.qq.com").searchParams.get("code")?.trim() ?? "";
    } catch {
      oauthCode = "";
    }
    if (!oauthCode) {
      return Boolean(cookies.get("qm_keyst") || cookies.get("qqmusic_key"));
    }

    const uin = (cookies.get("uin") ?? "").replace(/\D/g, "") || "0";
    const loginPayload = JSON.stringify({
      comm: {
        g_tk: gtk,
        platform: "yqq",
        ct: 24,
        cv: 0,
      },
      req: {
        module: "music.login.LoginServer",
        method: "Login",
        param: {
          code: oauthCode,
          strAppid: QQ_OAUTH_CLIENT_ID,
          musicid: Number(uin) || 0,
        },
      },
    });

    const { bytes: loginBytes, headers: loginHeaders } = await this.#http.fetchBoundedBytes(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
          "Content-Type": "application/json; charset=utf-8",
          Cookie: serializeQqCookie(Object.fromEntries(cookies)),
        },
        body: loginPayload,
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        allowHttp: false,
        maxRedirects: 0,
        maxBytes: MAX_QR_TEXT_BYTES,
      },
    );
    mergeSetCookies(cookies, loginHeaders);

    try {
      const parsed = JSON.parse(textDecoder.decode(loginBytes)) as {
        req?: {
          data?: {
            musickey?: string;
            musicid?: number | string;
            openid?: string;
            refresh_token?: string;
            access_token?: string;
          };
        };
      };
      const data = parsed.req?.data;
      if (data?.musickey) {
        cookies.set("qm_keyst", data.musickey);
        cookies.set("qqmusic_key", data.musickey);
      }
      if (data?.musicid) {
        cookies.set("uin", String(data.musicid));
      }
      if (data?.openid) {
        cookies.set("psrf_qqopenid", data.openid);
      }
      if (data?.access_token) {
        cookies.set("psrf_qqaccess_token", data.access_token);
      }
      if (data?.refresh_token) {
        cookies.set("psrf_qqrefresh_token", data.refresh_token);
      }
    } catch {
      // Fall back to whatever Set-Cookie headers delivered
    }

    return Boolean(cookies.get("qm_keyst") || cookies.get("qqmusic_key"));
  }

  async check(scopeKey: string, key: string): Promise<QrCheckResult & { rawCookie?: string }> {
    this.#cleanup();
    const session = this.#sessions.get(key.trim());
    if (!session || session.scopeKey !== scopeKey) {
      return { status: "expired", code: 65, message: "二维码已过期或不属于当前账号，请重新生成。" };
    }
    if (session.completing) {
      return { status: "scanned", code: 67, message: "正在完成登录跳转，请稍候。" };
    }

    const params = new URLSearchParams({
      u1: QQ_LOGIN_CALLBACK_URL,
      ptqrtoken: String(hash33(session.qrsig)),
      ptredirect: "0",
      h: "1",
      t: "1",
      g: "1",
      from_ui: "1",
      ptlang: "2052",
      action: `0-0-${Date.now()}`,
      js_ver: "26030415",
      js_type: "1",
      login_sig: session.loginSig,
      pt_uistyle: "40",
      low_login_enable: "1",
      low_login_hour: "720",
      aid: QQ_LOGIN_APP_ID,
      daid: QQ_LOGIN_DAID,
      o1vId: "",
      pt_js_version: "b515fdc3",
    });

    const { bytes: checkBytes } = await this.#http.fetchBoundedBytes(
      `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`,
      {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: QQ_LOGIN_REFERER,
          Cookie: serializeQqCookie(Object.fromEntries(session.cookies)),
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 0,
        maxBytes: MAX_QR_TEXT_BYTES,
      },
    );

    const parsed = parsePtuiCallback(textDecoder.decode(checkBytes));
    const code = Number(parsed.code || -1);

    if (parsed.code === "65") {
      this.#sessions.delete(key.trim());
      return { status: "expired", code, message: "二维码已过期，请重新生成。" };
    }
    if (parsed.code === "66") return { status: "waiting", code, message: "等待手机 QQ 扫码。" };
    if (parsed.code === "67") return { status: "scanned", code, message: "已扫码，请在手机确认。" };
    if (parsed.code === "23013") {
      return {
        status: "error",
        code,
        message: "腾讯安全策略拦截了服务端扫码轮询，请改用安全 Cookie 导入方式绑定。",
      };
    }
    if (parsed.code !== "0" || !parsed.redirectUrl) {
      return { status: "error", code, message: parsed.message || "QQ 扫码登录失败。" };
    }

    // Acquire completion lock before following redirect chain (A01: manual redirect mode per hop)
    session.completing = true;
    try {
      let nextUrl = parsed.redirectUrl;
      for (let hop = 0; hop < 4; hop += 1) {
        const { response: hopRes } = await this.#http.fetchResponse(nextUrl, {
          headers: {
            "User-Agent": QQ_LOGIN_USER_AGENT,
            Referer: QQ_LOGIN_REFERER,
            Cookie: serializeQqCookie(Object.fromEntries(session.cookies)),
          },
          allowedHostSuffixes: QR_ALLOWED_HOSTS,
          allowHttp: false,
          maxRedirects: 0,
          redirectMode: "manual",
          stripSensitiveHeadersOnHostChange: false, // safe because every hop is strictly validated against *.qq.com
        });
        mergeSetCookies(session.cookies, hopRes.headers);
        const location = hopRes.headers.get("location");
        await hopRes.body?.cancel().catch(() => undefined);
        if (!location) break;
        nextUrl = new URL(location, nextUrl).toString();
      }

      // C032: Exchange ptlogin2 skey/p_skey for QQ Music qm_keyst via OAuth2 + LoginServer
      const hasMusicKey = await this.#exchangeMusicKey(session.cookies).catch(() => false);
      this.#sessions.delete(key.trim());
      if (!hasMusicKey) {
        return {
          status: "error",
          code: -2,
          message:
            "QQ 扫码已确认，但腾讯风控拦截了音乐票据 (qm_keyst) 换取，请改用安全 Cookie 导入方式绑定。",
        };
      }

      const rawCookie = serializeQqCookie(Object.fromEntries(session.cookies));
      return {
        status: "confirmed",
        code: 0,
        message: parsed.nickname ? `QQ 音乐扫码成功：${parsed.nickname}` : "QQ 音乐扫码成功。",
        rawCookie,
      };
    } catch (error) {
      this.#sessions.delete(key.trim());
      throw error;
    }
  }
}
