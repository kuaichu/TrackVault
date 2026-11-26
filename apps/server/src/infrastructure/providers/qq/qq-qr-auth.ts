import crypto from "node:crypto";
import type { QqQrLoginChannel, QrCheckResult, QrStartResult } from "#shared";
import { AppError } from "../../../domain/errors.js";
import type { HostResolver, SafeHttpClient } from "../../security/safe-http-client.js";
import { QrSessionStore } from "../common/qr-session-store.js";
import { hash33, serializeQqCookie } from "./qq-cookie.js";
import {
  type MqttSocketFactory,
  type QqMqttQrSubscription,
  subscribeQqMobileQrEvents,
} from "./qq-mqtt-qr-listener.js";

const QQ_OAUTH_PTLOGIN_APP_ID = "716027609";
const QQ_OAUTH_PTLOGIN_DAID = "383";
const QQ_OAUTH_CLIENT_ID = "100497308";
const QQ_OAUTH_LOGIN_JUMP_URL = "https://graph.qq.com/oauth2.0/login_jump";
const QQ_OAUTH_REDIRECT_URI = "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/";
const QQ_PTLOGIN_REFERER = "https://xui.ptlogin2.qq.com/";

const WX_OAUTH_APP_ID = "wx48db31d50e334801";
const WX_OAUTH_REDIRECT_URI = "https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/";
const WX_OAUTH_HREF = "https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect";
const WX_POLL_TIMEOUT_MS = 3500;

const QQ_ANDROID_CT = 11;
const QQ_ANDROID_CV = 20_090_008;
const QQ_MOBILE_SESSION_TTL_MS = 5 * 60 * 1000;

const QQ_LOGIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_QR_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_QR_TEXT_BYTES = 256 * 1024;
const MAX_ACTIVE_MOBILE_LISTENERS = 100;
const QR_ALLOWED_HOSTS = ["qq.com", "y.qq.com", "weixin.qq.com"] as const;
const textDecoder = new TextDecoder("utf-8", { fatal: false });

type MobileQrState =
  | { readonly kind: "waiting" }
  | { readonly kind: "scanned" }
  | { readonly kind: "expired" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cookies"; readonly uin: string; readonly token: string };

type QqQrSession =
  | {
      channel: "qq";
      qrsig: string;
      completing: boolean;
    }
  | {
      channel: "wx";
      uuid: string;
      scanned: boolean;
      polling: boolean;
      completing: boolean;
    }
  | {
      channel: "mobile";
      qrcodeId: string;
      state: MobileQrState;
      completing: boolean;
    };

export interface QqQrAuthOptions {
  mqttResolveHost?: HostResolver;
  mqttSocketFactory?: MqttSocketFactory;
}

export interface QqQrCheckExtendedResult extends QrCheckResult {
  rawCookie?: string;
  nickname?: string;
  avatarUrl?: string;
}

interface RawLoginRpcResponse {
  code?: number;
  req?: {
    code?: number;
    data?: {
      musickey?: string;
      musicid?: number | string;
      str_musicid?: string;
      openid?: string;
      unionid?: string;
      refresh_token?: string;
      access_token?: string;
      refresh_key?: string;
      musickeyCreateTime?: number;
      encryptUin?: string;
      loginType?: number;
      nick?: string;
      logo?: string;
      errMsg?: string;
      errtip?: string;
      errTip2?: string;
    };
  };
}

function collectNonEmptySetCookies(target: Map<string, string>, headers: Headers): void {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const header of list) {
    const pair = header.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key && value) {
      target.set(key, value);
    }
  }
}

function parsePtuiCallback(input: string): {
  code: string;
  redirectUrl: string;
  message: string;
  nickname?: string;
} {
  const matches = [...input.matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1] ?? "");
  return {
    code: matches[0] ?? "",
    redirectUrl: matches[2] ?? "",
    message: matches[4] ?? "等待扫码确认。",
    nickname: matches[5] || undefined,
  };
}

function mapLoginRpcErrorMessage(code: number, fallbackMsg?: string): string {
  switch (code) {
    case 20279:
      return "当前 QQ 音乐账号登录设备数量已达上限，请在客户端清理旧设备后重试。";
    case 20277:
    case 20278:
    case 20450:
      return "当前 QQ 音乐账号处于安全受限状态，请先在官方客户端解除限制。";
    case 104604:
      return "登录操作过于频繁，请稍后再试。";
    case 20272:
    case 20274:
      return "当前扫码账号尚未完成 QQ 音乐账号绑定，请先在手机 QQ 音乐客户端登录一次。";
    default:
      return (
        fallbackMsg?.trim() ||
        `扫码已确认，但换取 QQ 音乐会话票据失败 (code ${code})，可切换其他扫码通道或使用 Cookie 绑定。`
      );
  }
}

function extractExactMusicIdFromJson(rawJson: string, parsedData: RawLoginRpcResponse["req"]): string {
  const strId = parsedData?.data?.str_musicid?.trim() ?? "";
  if (/^\d+$/.test(strId) && strId !== "0") {
    return strId;
  }
  const rawMatch = /"musicid"\s*:\s*"?(\d+)"?/.exec(rawJson)?.[1] ?? "";
  if (rawMatch && rawMatch !== "0") {
    return rawMatch;
  }
  const numVal = parsedData?.data?.musicid;
  if (numVal !== undefined && numVal !== null) {
    const asStr = String(numVal).replace(/\D/g, "");
    if (asStr && asStr !== "0") return asStr;
  }
  return "";
}

function buildNormalizedCookieFromLoginRpc(
  rawJson: string,
  parsed: RawLoginRpcResponse,
  defaultLoginType: "1" | "2",
  fallbackUin = "",
  fallbackCookies?: ReadonlyMap<string, string>,
): { ok: true; rawCookie: string; nickname?: string; avatarUrl?: string } | { ok: false; message: string } {
  const topCode = parsed.code ?? 0;
  const innerCode = parsed.req?.code ?? 0;
  const data = parsed.req?.data;

  if (topCode !== 0 || innerCode !== 0) {
    const errCode = innerCode || topCode;
    const hint = data?.errTip2 || data?.errtip || data?.errMsg;
    return { ok: false, message: mapLoginRpcErrorMessage(errCode, hint) };
  }

  const musickey =
    data?.musickey?.trim() ||
    fallbackCookies?.get("qm_keyst")?.trim() ||
    fallbackCookies?.get("qqmusic_key")?.trim() ||
    "";
  const uin =
    extractExactMusicIdFromJson(rawJson, parsed.req) ||
    fallbackUin.replace(/\D/g, "") ||
    (fallbackCookies?.get("uin") ?? "").replace(/\D/g, "");

  if (!musickey || !uin) {
    return {
      ok: false,
      message: "扫码已确认，但未返回有效的音乐票据 (qm_keyst)，请尝试「QQ 音乐 App」通道或手动粘贴 Cookie。",
    };
  }

  const isWechat = data?.loginType === 1 || defaultLoginType === "1" || musickey.startsWith("W_X");
  const cookieRecord: Record<string, string> = {
    uin,
    qqmusic_uin: uin,
    qm_keyst: musickey,
    qqmusic_key: musickey,
    tmeLoginType: isWechat ? "1" : "2",
    login_type: isWechat ? "2" : "1",
  };
  if (isWechat) {
    cookieRecord.wxuin = uin;
  }
  if (data?.encryptUin) {
    cookieRecord.euin = data.encryptUin;
  }
  if (data?.openid) {
    cookieRecord.psrf_qqopenid = data.openid;
  }
  if (data?.unionid) {
    cookieRecord.psrf_qqunionid = data.unionid;
  }
  if (data?.access_token) {
    cookieRecord.psrf_qqaccess_token = data.access_token;
  }
  if (data?.refresh_token) {
    cookieRecord.psrf_qqrefresh_token = data.refresh_token;
  }
  if (data?.refresh_key) {
    cookieRecord.psrf_qqrefresh_key = data.refresh_key;
  }
  if (data?.musickeyCreateTime) {
    cookieRecord.psrf_musickey_createtime = String(data.musickeyCreateTime);
  }

  return {
    ok: true,
    rawCookie: serializeQqCookie(cookieRecord),
    nickname: data?.nick?.trim() || undefined,
    avatarUrl: data?.logo?.trim() || undefined,
  };
}

/**
 * Multi-channel, scope-bound, bounded-memory QQ Music QR login manager:
 * - `mobile`: QQ Music App QR (`CreateQRCode` + MQTT 5.0 over WSS `mu.y.qq.com` + `LoginServer.Login`)
 * - `qq`: QQ Connect OAuth QR (`appid=716027609` / `daid=383` / `pt_3rd_aid=100497308` + `QQConnectLogin`)
 * - `wx`: WeChat Open Platform QR (`appid=wx48db31d50e334801` + `LoginServer.Login`)
 */
export class QqQrAuthManager {
  readonly #http: SafeHttpClient;
  readonly #sessions = new QrSessionStore<QqQrSession>({ ttlMs: QQ_MOBILE_SESSION_TTL_MS });
  readonly #mqttOptions: QqQrAuthOptions;
  readonly #mobileListeners = new Map<
    string,
    { scopeKey: string; sub: QqMqttQrSubscription; timer: NodeJS.Timeout }
  >();

  constructor(http: SafeHttpClient, options: QqQrAuthOptions = {}) {
    this.#http = http;
    this.#mqttOptions = options;
  }

  #listenerId(scopeKey: string, key: string): string {
    return `${scopeKey}\u0000${key}`;
  }

  #disposeMobileListener(scopeKey: string, key: string): void {
    const id = this.#listenerId(scopeKey, key);
    const entry = this.#mobileListeners.get(id);
    if (!entry) return;
    this.#mobileListeners.delete(id);
    clearTimeout(entry.timer);
    entry.sub.close();
  }

  invalidateScope(scopeKey: string): void {
    this.#sessions.invalidateScope(scopeKey);
    for (const [id, entry] of this.#mobileListeners.entries()) {
      if (entry.scopeKey === scopeKey) {
        this.#mobileListeners.delete(id);
        clearTimeout(entry.timer);
        entry.sub.close();
      }
    }
  }

  close(): void {
    for (const entry of this.#mobileListeners.values()) {
      clearTimeout(entry.timer);
      entry.sub.close();
    }
    this.#mobileListeners.clear();
  }

  async start(scopeKey: string, channel: QqQrLoginChannel = "qq"): Promise<QrStartResult> {
    if (channel === "mobile") {
      return this.#startMobileQr(scopeKey);
    }
    if (channel === "wx") {
      return this.#startWechatQr(scopeKey);
    }
    return this.#startQqOAuthQr(scopeKey);
  }

  async #startQqOAuthQr(scopeKey: string): Promise<QrStartResult> {
    const cookies = new Map<string, string>();
    const qrParams = new URLSearchParams({
      appid: QQ_OAUTH_PTLOGIN_APP_ID,
      e: "2",
      l: "M",
      s: "3",
      d: "72",
      v: "4",
      t: String(Math.random()),
      daid: QQ_OAUTH_PTLOGIN_DAID,
      pt_3rd_aid: QQ_OAUTH_CLIENT_ID,
      u1: QQ_OAUTH_LOGIN_JUMP_URL,
    });

    const { bytes: qrRawBytes, headers: qrHeaders } = await this.#http.fetchBoundedBytes(
      `https://ssl.ptlogin2.qq.com/ptqrshow?${qrParams.toString()}`,
      {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: QQ_PTLOGIN_REFERER,
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 0,
        maxBytes: MAX_QR_IMAGE_BYTES,
      },
    );

    collectNonEmptySetCookies(cookies, qrHeaders);
    const qrsig = cookies.get("qrsig");
    if (!qrsig) {
      throw new AppError("UPSTREAM_ERROR", "QQ 音乐二维码缺少 qrsig。");
    }

    const qrBytes = Buffer.from(qrRawBytes);
    const key = crypto.randomUUID();
    this.#sessions.set(scopeKey, key, {
      channel: "qq",
      qrsig,
      completing: false,
    });

    return {
      key,
      qrImage: `data:image/png;base64,${qrBytes.toString("base64")}`,
      channel: "qq",
    };
  }

  async #startWechatQr(scopeKey: string): Promise<QrStartResult> {
    const connectParams = new URLSearchParams({
      appid: WX_OAUTH_APP_ID,
      redirect_uri: WX_OAUTH_REDIRECT_URI,
      response_type: "code",
      scope: "snsapi_login",
      state: "STATE",
      href: WX_OAUTH_HREF,
    });

    const { bytes: htmlBytes } = await this.#http.fetchBoundedBytes(
      `https://open.weixin.qq.com/connect/qrconnect?${connectParams.toString()}`,
      {
        headers: { "User-Agent": QQ_LOGIN_USER_AGENT },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 2,
        maxBytes: MAX_QR_TEXT_BYTES,
      },
    );

    const html = textDecoder.decode(htmlBytes);
    const uuid =
      /\/connect\/qrcode\/([a-zA-Z0-9_-]+)/.exec(html)?.[1] ?? /uuid=([a-zA-Z0-9_-]+)"/.exec(html)?.[1] ?? "";
    if (!uuid) {
      throw new AppError("UPSTREAM_ERROR", "未能获取微信扫码登录标识 (uuid)。");
    }

    const { bytes: qrRawBytes, contentType } = await this.#http.fetchBoundedBytes(
      `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`,
      {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: "https://open.weixin.qq.com/connect/qrconnect",
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 1,
        maxBytes: MAX_QR_IMAGE_BYTES,
      },
    );

    const mime = contentType.toLowerCase().startsWith("image/png") ? "image/png" : "image/jpeg";
    const key = crypto.randomUUID();
    this.#sessions.set(scopeKey, key, {
      channel: "wx",
      uuid,
      scanned: false,
      polling: false,
      completing: false,
    });

    return {
      key,
      qrImage: `data:${mime};base64,${Buffer.from(qrRawBytes).toString("base64")}`,
      channel: "wx",
    };
  }

  async #startMobileQr(scopeKey: string): Promise<QrStartResult> {
    // Dispose any previous in-flight mobile MQTT listener for this user before creating a new one
    for (const [id, entry] of this.#mobileListeners.entries()) {
      if (entry.scopeKey === scopeKey) {
        this.#mobileListeners.delete(id);
        clearTimeout(entry.timer);
        entry.sub.close();
      }
    }

    const createPayload = JSON.stringify({
      comm: { ct: 23, cv: 0, tmeAppID: "qqmusic" },
      req: {
        module: "music.login.LoginServer",
        method: "CreateQRCode",
        param: { tmeAppID: "qqmusic" },
      },
    });

    const { bytes: createBytes } = await this.#http.fetchBoundedBytes(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: "https://y.qq.com/",
          Origin: "https://y.qq.com",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: createPayload,
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        allowHttp: false,
        maxRedirects: 0,
        maxBytes: MAX_QR_IMAGE_BYTES,
      },
    );

    let qrcodeBase64 = "";
    let qrcodeId = "";
    try {
      const parsed = JSON.parse(textDecoder.decode(createBytes)) as {
        code?: number;
        req?: { code?: number; data?: { qrcode?: string; qrcodeID?: string } };
      };
      if (
        (parsed.code !== undefined && parsed.code !== 0) ||
        (parsed.req?.code !== undefined && parsed.req.code !== 0)
      ) {
        throw new AppError(
          "UPSTREAM_ERROR",
          `生成 QQ 音乐 App 登录二维码失败 (code ${parsed.req?.code || parsed.code})。`,
        );
      }
      const rawQr = parsed.req?.data?.qrcode?.trim() ?? "";
      qrcodeBase64 = rawQr.includes(",") ? (rawQr.split(",").pop()?.trim() ?? "") : rawQr;
      qrcodeId = parsed.req?.data?.qrcodeID?.trim() ?? "";
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("UPSTREAM_ERROR", "解析 QQ 音乐 App 二维码响应失败。", { cause: error });
    }

    if (!qrcodeBase64 || !qrcodeId) {
      throw new AppError("UPSTREAM_ERROR", "QQ 音乐未返回有效的客户端二维码数据。");
    }

    const key = crypto.randomUUID();
    const session: QqQrSession = {
      channel: "mobile",
      qrcodeId,
      state: { kind: "waiting" },
      completing: false,
    };

    const subscription = await subscribeQqMobileQrEvents({
      qrcodeId,
      userAgent: QQ_LOGIN_USER_AGENT,
      resolveHost: this.#mqttOptions.mqttResolveHost,
      socketFactory: this.#mqttOptions.mqttSocketFactory,
      onEvent: ({ eventType, payload }) => {
        if (session.channel !== "mobile") return;
        if (eventType === "scanned") {
          if (session.state.kind === "waiting") {
            session.state = { kind: "scanned" };
          }
          return;
        }
        if (eventType === "canceled") {
          session.state = { kind: "refused" };
          this.#disposeMobileListener(scopeKey, key);
          return;
        }
        if (eventType === "timeout") {
          session.state = { kind: "expired" };
          this.#disposeMobileListener(scopeKey, key);
          return;
        }
        if (eventType === "loginFailed") {
          session.state = { kind: "failed", message: "QQ 音乐客户端扫码授权失败，请重试。" };
          this.#disposeMobileListener(scopeKey, key);
          return;
        }
        if (eventType === "cookies" && payload && typeof payload === "object") {
          const cookiesObj = (payload as { cookies?: Record<string, { value?: unknown }> }).cookies;
          const uinVal = String(cookiesObj?.qqmusic_uin?.value ?? "").trim();
          const keyVal = String(cookiesObj?.qqmusic_key?.value ?? "").trim();
          if (uinVal && keyVal) {
            session.state = { kind: "cookies", uin: uinVal, token: keyVal };
          } else {
            session.state = { kind: "failed", message: "QQ 音乐扫码推送缺少有效票据。" };
          }
          this.#disposeMobileListener(scopeKey, key);
        }
      },
      onDisconnect: () => {
        if (
          session.channel === "mobile" &&
          (session.state.kind === "waiting" || session.state.kind === "scanned")
        ) {
          session.state = {
            kind: "failed",
            message: "QQ 音乐扫码实时通道已断开，请重新生成二维码。",
          };
        }
        this.#disposeMobileListener(scopeKey, key);
      },
    });

    // Enforce hard global cap on concurrent MQTT sockets
    if (this.#mobileListeners.size >= MAX_ACTIVE_MOBILE_LISTENERS) {
      const oldestKey = this.#mobileListeners.keys().next().value;
      if (oldestKey) {
        const oldest = this.#mobileListeners.get(oldestKey);
        this.#mobileListeners.delete(oldestKey);
        if (oldest) {
          clearTimeout(oldest.timer);
          oldest.sub.close();
        }
      }
    }

    const ttlTimer = setTimeout(() => {
      if (
        session.channel === "mobile" &&
        (session.state.kind === "waiting" || session.state.kind === "scanned")
      ) {
        session.state = { kind: "expired" };
      }
      this.#disposeMobileListener(scopeKey, key);
    }, QQ_MOBILE_SESSION_TTL_MS);
    ttlTimer.unref?.();

    this.#mobileListeners.set(this.#listenerId(scopeKey, key), {
      scopeKey,
      sub: subscription,
      timer: ttlTimer,
    });
    this.#sessions.set(scopeKey, key, session);

    return {
      key,
      qrImage: `data:image/png;base64,${qrcodeBase64}`,
      channel: "mobile",
    };
  }

  async #postLoginRpc(
    body: string,
    extraCookies?: ReadonlyMap<string, string>,
  ): Promise<{
    rawText: string;
    parsed: RawLoginRpcResponse;
    responseCookies: Map<string, string>;
  }> {
    const headers: Record<string, string> = {
      "User-Agent": QQ_LOGIN_USER_AGENT,
      Referer: "https://y.qq.com/",
      Origin: "https://y.qq.com",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (extraCookies && extraCookies.size > 0) {
      headers.Cookie = serializeQqCookie(Object.fromEntries(extraCookies));
    }

    const { bytes, headers: resHeaders } = await this.#http.fetchBoundedBytes(
      "https://u.y.qq.com/cgi-bin/musicu.fcg",
      {
        method: "POST",
        headers,
        body,
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        allowHttp: false,
        maxRedirects: 0,
        maxBytes: MAX_QR_TEXT_BYTES,
      },
    );

    const responseCookies = new Map<string, string>(extraCookies);
    collectNonEmptySetCookies(responseCookies, resHeaders);
    const rawText = textDecoder.decode(bytes);
    let parsed: RawLoginRpcResponse = {};
    try {
      parsed = JSON.parse(rawText) as RawLoginRpcResponse;
    } catch {
      parsed = {};
    }
    return { rawText, parsed, responseCookies };
  }

  async #exchangeQqOAuthMusicKey(
    redirectUrl: string,
  ): Promise<
    { ok: true; rawCookie: string; nickname?: string; avatarUrl?: string } | { ok: false; message: string }
  > {
    const graphCookies = new Map<string, string>();
    let nextUrl = redirectUrl;
    for (let hop = 0; hop < 4; hop += 1) {
      const { response: hopRes } = await this.#http.fetchResponse(nextUrl, {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: QQ_PTLOGIN_REFERER,
          ...(graphCookies.size > 0 ? { Cookie: serializeQqCookie(Object.fromEntries(graphCookies)) } : {}),
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        allowHttp: false,
        maxRedirects: 0,
        redirectMode: "manual",
        stripSensitiveHeadersOnHostChange: false,
      });
      collectNonEmptySetCookies(graphCookies, hopRes.headers);
      const location = hopRes.headers.get("location");
      await hopRes.body?.cancel().catch(() => undefined);
      // Stop as soon as graph.qq.com p_skey is obtained so cross-domain redirects cannot clobber it
      if (graphCookies.get("p_skey") || !location) {
        break;
      }
      nextUrl = new URL(location, nextUrl).toString();
    }

    const directKey = graphCookies.get("qm_keyst") || graphCookies.get("qqmusic_key");
    const directUin = (graphCookies.get("uin") ?? "").replace(/\D/g, "");
    if (directKey && directUin) {
      return {
        ok: true,
        rawCookie: serializeQqCookie({
          uin: directUin,
          qqmusic_uin: directUin,
          qm_keyst: directKey,
          qqmusic_key: directKey,
          tmeLoginType: "2",
          login_type: "1",
        }),
      };
    }

    const graphPskey = graphCookies.get("p_skey") ?? "";
    if (!graphPskey) {
      return {
        ok: false,
        message: "手机 QQ 扫码已确认，但未获取到 QQ 互联授权票据 (p_skey)，建议改用「QQ 音乐 App」扫码。",
      };
    }

    const authorizeBody = new URLSearchParams({
      response_type: "code",
      client_id: QQ_OAUTH_CLIENT_ID,
      redirect_uri: QQ_OAUTH_REDIRECT_URI,
      scope: "get_user_info,get_app_friends",
      state: "state",
      switch: "",
      from_ptlogin: "1",
      src: "1",
      update_auth: "1",
      openapi: "1010_1030",
      g_tk: String(hash33(graphPskey, 5381)),
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
        Cookie: serializeQqCookie(Object.fromEntries(graphCookies)),
      },
      body: authorizeBody,
      allowedHostSuffixes: QR_ALLOWED_HOSTS,
      allowHttp: false,
      maxRedirects: 0,
      redirectMode: "manual",
      stripSensitiveHeadersOnHostChange: false,
    });
    collectNonEmptySetCookies(graphCookies, authRes.headers);
    const location = authRes.headers.get("location") ?? "";
    await authRes.body?.cancel().catch(() => undefined);

    let oauthCode = "";
    if (location) {
      try {
        oauthCode = new URL(location, "https://graph.qq.com").searchParams.get("code")?.trim() ?? "";
      } catch {
        oauthCode = "";
      }
    }
    if (!oauthCode) {
      return {
        ok: false,
        message:
          "QQ 扫码已确认，但腾讯风控拦截了音乐票据 (qm_keyst) 换取，请切换至「QQ 音乐 App」扫码或使用安全 Cookie 绑定。",
      };
    }

    const rpcBody = JSON.stringify({
      comm: {
        ct: QQ_ANDROID_CT,
        cv: QQ_ANDROID_CV,
        v: QQ_ANDROID_CV,
        tmeAppID: "qqmusic",
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        tmeLoginType: "2",
      },
      req: {
        module: "QQConnectLogin.LoginServer",
        method: "QQLogin",
        param: { code: oauthCode },
      },
    });

    const { rawText, parsed, responseCookies } = await this.#postLoginRpc(rpcBody);
    return buildNormalizedCookieFromLoginRpc(rawText, parsed, "2", directUin, responseCookies);
  }

  async #exchangeWechatMusicKey(
    wxCode: string,
  ): Promise<
    { ok: true; rawCookie: string; nickname?: string; avatarUrl?: string } | { ok: false; message: string }
  > {
    const rpcBody = JSON.stringify({
      comm: {
        ct: QQ_ANDROID_CT,
        cv: QQ_ANDROID_CV,
        v: QQ_ANDROID_CV,
        tmeAppID: "qqmusic",
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        tmeLoginType: "1",
      },
      req: {
        module: "music.login.LoginServer",
        method: "Login",
        param: {
          code: wxCode,
          strAppid: WX_OAUTH_APP_ID,
        },
      },
    });

    const { rawText, parsed, responseCookies } = await this.#postLoginRpc(rpcBody);
    return buildNormalizedCookieFromLoginRpc(rawText, parsed, "1", "", responseCookies);
  }

  async #exchangeMobileMusicKey(
    qrcodeId: string,
    rawUin: string,
    token: string,
  ): Promise<
    { ok: true; rawCookie: string; nickname?: string; avatarUrl?: string } | { ok: false; message: string }
  > {
    const numericUin = rawUin.replace(/\D/g, "");
    if (!numericUin) {
      return { ok: false, message: "QQ 音乐客户端未返回有效的账号标识 (uin)。" };
    }

    // Preserve exact 64-bit integer precision for 19-digit WeChat musicid values (> Number.MAX_SAFE_INTEGER)
    const sentinel = "__TV_EXACT_QQMUSIC_ID__";
    const rpcBody = JSON.stringify({
      comm: {
        ct: QQ_ANDROID_CT,
        cv: QQ_ANDROID_CV,
        v: QQ_ANDROID_CV,
        tmeAppID: "qqmusic",
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        tmeLoginType: "6",
      },
      req: {
        module: "music.login.LoginServer",
        method: "Login",
        param: {
          musicid: sentinel,
          qrCodeID: qrcodeId,
          token,
        },
      },
    }).replace(`"${sentinel}"`, numericUin);

    const { rawText, parsed, responseCookies } = await this.#postLoginRpc(rpcBody);
    const defaultType: "1" | "2" = token.startsWith("W_X") ? "1" : "2";
    return buildNormalizedCookieFromLoginRpc(rawText, parsed, defaultType, numericUin, responseCookies);
  }

  async check(scopeKey: string, key: string): Promise<QqQrCheckExtendedResult> {
    const trimmedKey = key.trim();
    const session = this.#sessions.get(scopeKey, trimmedKey);
    if (!session) {
      this.#disposeMobileListener(scopeKey, trimmedKey);
      return { status: "expired", code: 65, message: "二维码已过期或不属于当前账号，请重新生成。" };
    }
    if (session.completing) {
      return { status: "scanned", code: 67, message: "正在完成登录票据交换，请稍候。" };
    }

    if (session.channel === "mobile") {
      return this.#checkMobileSession(scopeKey, trimmedKey, session);
    }
    if (session.channel === "wx") {
      return this.#checkWechatSession(scopeKey, trimmedKey, session);
    }
    return this.#checkQqOAuthSession(scopeKey, trimmedKey, session);
  }

  async #checkMobileSession(
    scopeKey: string,
    key: string,
    session: Extract<QqQrSession, { channel: "mobile" }>,
  ): Promise<QqQrCheckExtendedResult> {
    const state = session.state;
    if (state.kind === "waiting") {
      return { status: "waiting", code: 66, message: "请使用手机 QQ 音乐 App 扫码。" };
    }
    if (state.kind === "scanned") {
      return { status: "scanned", code: 67, message: "已扫码，请在手机 QQ 音乐 App 确认登录。" };
    }
    if (state.kind === "expired") {
      this.#disposeMobileListener(scopeKey, key);
      this.#sessions.delete(scopeKey, key);
      return { status: "expired", code: 65, message: "二维码已过期，请重新生成。" };
    }
    if (state.kind === "refused") {
      this.#disposeMobileListener(scopeKey, key);
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code: 68, message: "已取消扫码授权，请重新生成二维码。" };
    }
    if (state.kind === "failed") {
      this.#disposeMobileListener(scopeKey, key);
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code: -1, message: state.message };
    }

    session.completing = true;
    this.#disposeMobileListener(scopeKey, key);
    try {
      const exchanged = await this.#exchangeMobileMusicKey(session.qrcodeId, state.uin, state.token);
      this.#sessions.delete(scopeKey, key);
      if (!exchanged.ok) {
        return { status: "error", code: -2, message: exchanged.message };
      }
      return {
        status: "confirmed",
        code: 0,
        message: exchanged.nickname ? `QQ 音乐扫码成功：${exchanged.nickname}` : "QQ 音乐扫码成功。",
        rawCookie: exchanged.rawCookie,
        nickname: exchanged.nickname,
        avatarUrl: exchanged.avatarUrl,
      };
    } catch (error) {
      this.#sessions.delete(scopeKey, key);
      throw error;
    }
  }

  async #checkWechatSession(
    scopeKey: string,
    key: string,
    session: Extract<QqQrSession, { channel: "wx" }>,
  ): Promise<QqQrCheckExtendedResult> {
    if (session.polling) {
      return session.scanned
        ? { status: "scanned", code: 404, message: "已扫码，请在微信上确认登录。" }
        : { status: "waiting", code: 408, message: "等待手机微信扫码。" };
    }

    session.polling = true;
    let pollText = "";
    try {
      const { bytes } = await this.#http.fetchBoundedBytes(
        `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(session.uuid)}&_=${Date.now()}`,
        {
          headers: {
            "User-Agent": QQ_LOGIN_USER_AGENT,
            Referer: "https://open.weixin.qq.com/",
          },
          allowedHostSuffixes: QR_ALLOWED_HOSTS,
          maxRedirects: 0,
          maxBytes: MAX_QR_TEXT_BYTES,
          timeoutMs: WX_POLL_TIMEOUT_MS,
          idleTimeoutMs: WX_POLL_TIMEOUT_MS,
        },
      );
      pollText = textDecoder.decode(bytes);
    } catch (error) {
      // WeChat long-polling holds connections open until scan/state-change; short window timeout = still waiting
      if (error instanceof AppError && error.code === "UPSTREAM_TIMEOUT") {
        return session.scanned
          ? { status: "scanned", code: 404, message: "已扫码，请在微信上确认登录。" }
          : { status: "waiting", code: 408, message: "等待手机微信扫码。" };
      }
      throw error;
    } finally {
      session.polling = false;
    }

    const match = /window\.wx_errcode\s*=\s*(\d+)\s*;\s*window\.wx_code\s*=\s*'([^']*)'/.exec(pollText);
    if (!match) {
      return { status: "error", code: -1, message: "微信扫码状态响应异常，请重新生成二维码。" };
    }

    const wxErrcode = Number(match[1] ?? -1);
    const wxCode = (match[2] ?? "").trim();

    if (wxErrcode === 408) {
      return { status: "waiting", code: 408, message: "等待手机微信扫码。" };
    }
    if (wxErrcode === 404) {
      session.scanned = true;
      return { status: "scanned", code: 404, message: "已扫码，请在微信上确认登录。" };
    }
    if (wxErrcode === 403) {
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code: 403, message: "已取消微信扫码授权，请重新生成二维码。" };
    }
    if (wxErrcode === 402 || wxErrcode === 500) {
      this.#sessions.delete(scopeKey, key);
      return { status: "expired", code: wxErrcode, message: "微信二维码已过期，请重新生成。" };
    }
    if (wxErrcode !== 405 || !wxCode) {
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code: wxErrcode, message: `微信扫码登录失败 (code ${wxErrcode})。` };
    }

    session.completing = true;
    try {
      const exchanged = await this.#exchangeWechatMusicKey(wxCode);
      this.#sessions.delete(scopeKey, key);
      if (!exchanged.ok) {
        return { status: "error", code: -2, message: exchanged.message };
      }
      return {
        status: "confirmed",
        code: 0,
        message: exchanged.nickname
          ? `微信扫码绑定 QQ 音乐成功：${exchanged.nickname}`
          : "微信扫码绑定 QQ 音乐成功。",
        rawCookie: exchanged.rawCookie,
        nickname: exchanged.nickname,
        avatarUrl: exchanged.avatarUrl,
      };
    } catch (error) {
      this.#sessions.delete(scopeKey, key);
      throw error;
    }
  }

  async #checkQqOAuthSession(
    scopeKey: string,
    key: string,
    session: Extract<QqQrSession, { channel: "qq" }>,
  ): Promise<QqQrCheckExtendedResult> {
    const params = new URLSearchParams({
      u1: QQ_OAUTH_LOGIN_JUMP_URL,
      ptqrtoken: String(hash33(session.qrsig)),
      ptredirect: "0",
      h: "1",
      t: "1",
      g: "1",
      from_ui: "1",
      ptlang: "2052",
      action: `0-0-${Date.now()}`,
      js_ver: "24091916",
      js_type: "1",
      pt_uistyle: "40",
      aid: QQ_OAUTH_PTLOGIN_APP_ID,
      daid: QQ_OAUTH_PTLOGIN_DAID,
      pt_3rd_aid: QQ_OAUTH_CLIENT_ID,
      has_onekey: "1",
    });

    const { bytes: checkBytes } = await this.#http.fetchBoundedBytes(
      `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`,
      {
        headers: {
          "User-Agent": QQ_LOGIN_USER_AGENT,
          Referer: QQ_PTLOGIN_REFERER,
          Cookie: serializeQqCookie({ qrsig: session.qrsig }),
        },
        allowedHostSuffixes: QR_ALLOWED_HOSTS,
        maxRedirects: 0,
        maxBytes: MAX_QR_TEXT_BYTES,
      },
    );

    const parsed = parsePtuiCallback(textDecoder.decode(checkBytes));
    const code = Number(parsed.code || -1);

    if (parsed.code === "65") {
      this.#sessions.delete(scopeKey, key);
      return { status: "expired", code, message: "二维码已过期，请重新生成。" };
    }
    if (parsed.code === "66") return { status: "waiting", code, message: "等待手机 QQ 扫码。" };
    if (parsed.code === "67") return { status: "scanned", code, message: "已扫码，请在手机 QQ 确认登录。" };
    if (parsed.code === "68") {
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code, message: "已取消手机 QQ 扫码授权，请重新生成二维码。" };
    }
    if (parsed.code === "23013") {
      this.#sessions.delete(scopeKey, key);
      return {
        status: "error",
        code,
        message: "手机 QQ 扫码受到安全策略限制，请切换至「QQ 音乐 App」或「微信」通道扫码。",
      };
    }
    if (parsed.code !== "0" || !parsed.redirectUrl) {
      this.#sessions.delete(scopeKey, key);
      return { status: "error", code, message: parsed.message || "QQ 扫码登录失败。" };
    }

    session.completing = true;
    try {
      const exchanged = await this.#exchangeQqOAuthMusicKey(parsed.redirectUrl);
      this.#sessions.delete(scopeKey, key);
      if (!exchanged.ok) {
        return { status: "error", code: -2, message: exchanged.message };
      }
      const nickname = exchanged.nickname || parsed.nickname;
      return {
        status: "confirmed",
        code: 0,
        message: nickname ? `QQ 音乐扫码成功：${nickname}` : "QQ 音乐扫码成功。",
        rawCookie: exchanged.rawCookie,
        nickname,
        avatarUrl: exchanged.avatarUrl,
      };
    } catch (error) {
      this.#sessions.delete(scopeKey, key);
      throw error;
    }
  }
}
