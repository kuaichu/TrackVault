import crypto from "node:crypto";
import type { KugouQrLoginChannel, QrLoginChannel, QrStartResult } from "#shared";
import { AppError } from "../../../domain/errors.js";
import type { ProviderQrCheckResult } from "../../../domain/ports/music-provider.js";
import { serializeKugouCookie } from "./kugou-cookie.js";
import {
  KUGOU_EDITION_CONFIGS,
  KUGOU_LITE_T1_IV,
  KUGOU_LITE_T1_KEY,
  KUGOU_LITE_T2_IV,
  KUGOU_LITE_T2_KEY,
  KUGOU_SRC_APPID,
  type KugouEdition,
  kugouAesDecrypt,
  kugouAesEncryptFixed,
  kugouAesEncryptWithRandomKey,
  kugouRsaRawEncryptHex,
  md5Hex,
  randomAlphaNum,
  sha1Hex,
} from "./kugou-crypto.js";
import type { KugouHttpClient } from "./kugou-http-client.js";

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 100;
const WX_LONG_POLL_TIMEOUT_MS = 3_500;

export const KUGOU_QR_CHANNELS: readonly KugouQrLoginChannel[] = [
  "kg_lite",
  "kg_std",
  "kg_wx_lite",
  "kg_wx_std",
];

type KugouQrSession =
  | {
      readonly kind: "native";
      readonly scopeKey: string;
      readonly channel: "kg_lite" | "kg_std";
      readonly edition: KugouEdition;
      readonly qrCodeKey: string;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "wx";
      readonly scopeKey: string;
      readonly channel: "kg_wx_lite" | "kg_wx_std";
      readonly edition: KugouEdition;
      readonly uuid: string;
      readonly expiresAt: number;
      lastScanned: boolean;
    };

interface RawKugouQrCreateResponse {
  status?: number;
  errcode?: number;
  data?: {
    qrcode?: string;
    qrcode_img?: string;
  };
}

interface RawKugouQrCheckResponse {
  status?: number;
  errcode?: number;
  data?: {
    status?: number;
    userid?: number | string;
    token?: string;
    nickname?: string;
    pic?: string;
    vip_type?: number;
    vip_token?: string;
  };
}

interface RawWxTokenResponse {
  access_token?: string;
  errcode?: number;
  errmsg?: string;
}

interface RawWxTicketResponse {
  ticket?: string;
  errcode?: number;
  errmsg?: string;
}

interface RawWxQrConnectResponse {
  errcode?: number;
  errmsg?: string;
  uuid?: string;
  qrcode?: {
    qrcodebase64?: string;
  };
}

interface RawWxLongPollResponse {
  wx_errcode?: number;
  wx_code?: string;
}

interface RawWxOAuthTokenResponse {
  access_token?: string;
  openid?: string;
  errcode?: number;
  errmsg?: string;
}

interface RawKugouOpenplatLoginResponse {
  status?: number;
  error_code?: number;
  data?: {
    userid?: number | string;
    token?: string;
    secu_params?: string;
    nickname?: string;
    pic?: string;
    vip_type?: number;
    vip_token?: string;
    t1?: string;
  };
}

function resolveKugouChannel(raw?: QrLoginChannel): KugouQrLoginChannel {
  if (raw === "kg_lite" || raw === "kg_std" || raw === "kg_wx_lite" || raw === "kg_wx_std") {
    return raw;
  }
  return "kg_lite";
}

export class KugouQrAuthManager {
  readonly #client: KugouHttpClient;
  readonly #sessions = new Map<string, KugouQrSession>();

  constructor(client: KugouHttpClient) {
    this.#client = client;
  }

  invalidateScope(scopeKey: string): void {
    for (const [key, session] of this.#sessions.entries()) {
      if (session.scopeKey === scopeKey) {
        this.#sessions.delete(key);
      }
    }
  }

  close(): void {
    this.#sessions.clear();
  }

  #pruneSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions.entries()) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.#sessions.keys().next().value;
      if (!oldestKey) break;
      this.#sessions.delete(oldestKey);
    }
  }

  async start(scopeKey: string, requestedChannel?: QrLoginChannel): Promise<QrStartResult> {
    this.#pruneSessions();
    const channel = resolveKugouChannel(requestedChannel);
    if (channel === "kg_wx_lite" || channel === "kg_wx_std") {
      return this.#startWxQr(scopeKey, channel);
    }
    return this.#startNativeQr(scopeKey, channel);
  }

  async #startNativeQr(scopeKey: string, channel: "kg_lite" | "kg_std"): Promise<QrStartResult> {
    const edition: KugouEdition = channel === "kg_std" ? "standard" : "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const qrUrlTemplate = `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${conf.appid}&`;

    const res = await this.#client.request<RawKugouQrCreateResponse>({
      baseUrl: "https://login-user.kugou.com",
      path: "/v2/qrcode",
      method: "GET",
      params: {
        appid: 1001,
        type: 1,
        plat: 4,
        qrcode_txt: qrUrlTemplate,
        srcappid: KUGOU_SRC_APPID,
      },
      edition,
      encryptType: "web",
    });

    const qrCodeKey = res.data?.qrcode?.trim();
    const qrImgBase64 = res.data?.qrcode_img?.trim();
    if (res.status !== 1 || !qrCodeKey || !qrImgBase64) {
      throw new AppError("UPSTREAM_ERROR", `生成酷狗登录二维码失败 (errcode ${res.errcode ?? "unknown"})。`);
    }

    const sessionKey = `kg_${crypto.randomUUID()}`;
    this.#sessions.set(sessionKey, {
      kind: "native",
      scopeKey,
      channel,
      edition,
      qrCodeKey,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    const qrImage = qrImgBase64.startsWith("data:image/")
      ? qrImgBase64
      : `data:image/png;base64,${qrImgBase64}`;

    return {
      key: sessionKey,
      qrImage,
      qrUrl: `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(qrCodeKey)}`,
      channel,
    };
  }

  async #startWxQr(scopeKey: string, channel: "kg_wx_lite" | "kg_wx_std"): Promise<QrStartResult> {
    const edition: KugouEdition = channel === "kg_wx_std" ? "standard" : "lite";
    const conf = KUGOU_EDITION_CONFIGS[edition];

    const tokenRes = await this.#client.requestExternalJson<RawWxTokenResponse>(
      "https://api.weixin.qq.com/cgi-bin/token",
      {
        query: {
          appid: conf.wxAppid,
          secret: conf.wxSecret,
          grant_type: "client_credential",
        },
      },
    );
    if (!tokenRes.access_token) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `获取酷狗微信授权令牌失败 (${tokenRes.errmsg ?? tokenRes.errcode ?? "unknown"})。`,
      );
    }

    const ticketRes = await this.#client.requestExternalJson<RawWxTicketResponse>(
      "https://api.weixin.qq.com/cgi-bin/ticket/getticket",
      {
        query: {
          access_token: tokenRes.access_token,
          type: 2,
        },
      },
    );
    if (ticketRes.errcode !== 0 || !ticketRes.ticket) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `获取酷狗微信扫码票据失败 (${ticketRes.errmsg ?? ticketRes.errcode ?? "unknown"})。`,
      );
    }

    const timestamp = Date.now();
    const noncestr = md5Hex(randomAlphaNum(16, true));
    const sigRaw = `appid=${conf.wxAppid}&noncestr=${noncestr}&sdk_ticket=${ticketRes.ticket}&timestamp=${timestamp}`;
    const signature = sha1Hex(sigRaw);

    const qrRes = await this.#client.requestExternalJson<RawWxQrConnectResponse>(
      "https://open.weixin.qq.com/connect/sdk/qrconnect",
      {
        query: {
          appid: conf.wxAppid,
          noncestr,
          timestamp,
          scope: "snsapi_userinfo",
          signature,
        },
      },
    );

    const uuid = qrRes.uuid?.trim();
    const rawB64 = qrRes.qrcode?.qrcodebase64?.trim();
    if (qrRes.errcode !== 0 || !uuid || !rawB64) {
      throw new AppError(
        "UPSTREAM_ERROR",
        `生成酷狗微信二维码失败 (${qrRes.errmsg ?? qrRes.errcode ?? "unknown"})。`,
      );
    }

    const sessionKey = `kgwx_${crypto.randomUUID()}`;
    this.#sessions.set(sessionKey, {
      kind: "wx",
      scopeKey,
      channel,
      edition,
      uuid,
      expiresAt: Date.now() + SESSION_TTL_MS,
      lastScanned: false,
    });

    const qrImage = rawB64.startsWith("data:image/") ? rawB64 : `data:image/jpeg;base64,${rawB64}`;
    return {
      key: sessionKey,
      qrImage,
      qrUrl: `https://open.weixin.qq.com/connect/confirm?uuid=${encodeURIComponent(uuid)}`,
      channel,
    };
  }

  async check(scopeKey: string, key: string): Promise<ProviderQrCheckResult> {
    const session = this.#sessions.get(key);
    if (!session || session.scopeKey !== scopeKey || session.expiresAt <= Date.now()) {
      if (session && session.expiresAt <= Date.now()) {
        this.#sessions.delete(key);
      }
      return {
        status: "expired",
        code: 0,
        message: "二维码已过期，请点击重新生成。",
      };
    }

    if (session.kind === "wx") {
      return this.#checkWxQr(key, session);
    }
    return this.#checkNativeQr(key, session);
  }

  async #checkNativeQr(
    key: string,
    session: Extract<KugouQrSession, { kind: "native" }>,
  ): Promise<ProviderQrCheckResult> {
    const conf = KUGOU_EDITION_CONFIGS[session.edition];
    const res = await this.#client.request<RawKugouQrCheckResponse>({
      baseUrl: "https://login-user.kugou.com",
      path: "/v2/get_userinfo_qrcode",
      method: "GET",
      params: {
        plat: 4,
        appid: conf.appid,
        srcappid: KUGOU_SRC_APPID,
        qrcode: session.qrCodeKey,
        dev: this.#client.deviceDev,
      },
      edition: session.edition,
      encryptType: "web",
    });

    const qrStatus = Number(res.data?.status ?? -1);
    if (qrStatus === 0) {
      this.#sessions.delete(key);
      return { status: "expired", code: 0, message: "二维码已失效，请重新生成。" };
    }
    if (qrStatus === 1) {
      return {
        status: "waiting",
        code: 1,
        message:
          session.edition === "lite"
            ? "请打开手机「酷狗概念版」App 扫一扫"
            : "请打开手机「酷狗音乐」App 扫一扫",
      };
    }
    if (qrStatus === 2) {
      return { status: "scanned", code: 2, message: "已扫码，请在手机端点击确认登录" };
    }
    if (qrStatus === 4) {
      this.#sessions.delete(key);
      const userid = String(res.data?.userid ?? "").replace(/\D/g, "");
      const token = res.data?.token?.trim() ?? "";
      if (!userid || userid === "0" || !token) {
        return {
          status: "error",
          code: 4,
          message: "酷狗授权成功但未返回有效 token，请重试。",
        };
      }

      const dfid = await this.#client.ensureDfid(session.edition);
      const rawCookie = serializeKugouCookie({
        userid,
        token,
        kg_edition: session.edition,
        dfid,
        ...(res.data?.vip_type !== undefined ? { vip_type: String(res.data.vip_type) } : {}),
        ...(res.data?.vip_token ? { vip_token: res.data.vip_token } : {}),
      });

      return {
        status: "confirmed",
        code: 4,
        message: `酷狗${session.edition === "lite" ? "概念版" : "音乐"}扫码登录成功`,
        rawCookie,
        nickname: res.data?.nickname?.trim() || undefined,
        avatarUrl: res.data?.pic?.trim() || undefined,
      };
    }

    return {
      status: "waiting",
      code: qrStatus,
      message: "等待扫码中...",
    };
  }

  async #checkWxQr(
    key: string,
    session: Extract<KugouQrSession, { kind: "wx" }>,
  ): Promise<ProviderQrCheckResult> {
    let pollRes: RawWxLongPollResponse;
    try {
      pollRes = await this.#client.requestExternalJson<RawWxLongPollResponse>(
        "https://long.open.weixin.qq.com/connect/l/qrconnect",
        {
          query: { f: "json", uuid: session.uuid },
          timeoutMs: WX_LONG_POLL_TIMEOUT_MS,
        },
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "UPSTREAM_TIMEOUT") {
        return session.lastScanned
          ? { status: "scanned", code: 404, message: "微信已扫码，请在手机端确认授权" }
          : { status: "waiting", code: 408, message: "请打开手机微信扫一扫" };
      }
      throw error;
    }

    const wxCode = Number(pollRes.wx_errcode ?? 408);
    if (wxCode === 408) {
      return session.lastScanned
        ? { status: "scanned", code: 404, message: "微信已扫码，请在手机端确认授权" }
        : { status: "waiting", code: 408, message: "请打开手机微信扫一扫" };
    }
    if (wxCode === 404) {
      session.lastScanned = true;
      return { status: "scanned", code: 404, message: "微信已扫码，请在手机端确认授权" };
    }
    if (wxCode === 402 || wxCode === 403 || wxCode === 500) {
      this.#sessions.delete(key);
      return {
        status: "expired",
        code: wxCode,
        message: wxCode === 403 ? "已取消微信授权，请重新生成二维码。" : "微信二维码已过期，请重新生成。",
      };
    }
    if (wxCode === 405 && pollRes.wx_code) {
      this.#sessions.delete(key);
      return this.#completeWxOpenplatLogin(pollRes.wx_code, session.edition);
    }

    return { status: "waiting", code: wxCode, message: "等待微信扫码确认..." };
  }

  async #completeWxOpenplatLogin(wxCode: string, edition: KugouEdition): Promise<ProviderQrCheckResult> {
    const conf = KUGOU_EDITION_CONFIGS[edition];
    const oauthRes = await this.#client.requestExternalJson<RawWxOAuthTokenResponse>(
      "https://api.weixin.qq.com/sns/oauth2/access_token",
      {
        method: "POST",
        query: {
          appid: conf.wxAppid,
          secret: conf.wxSecret,
          code: wxCode,
          grant_type: "authorization_code",
        },
      },
    );

    if (!oauthRes.access_token || !oauthRes.openid) {
      return {
        status: "error",
        code: oauthRes.errcode ?? 502,
        message: `微信授权换取令牌失败 (${oauthRes.errmsg ?? "未返回 openid"})。`,
      };
    }

    const nowMs = Date.now();
    const dfid = await this.#client.ensureDfid(edition);
    const encryptedToken = kugouAesEncryptWithRandomKey({ access_token: oauthRes.access_token });
    const pk = kugouRsaRawEncryptHex(
      { clienttime_ms: nowMs, key: encryptedToken.key },
      edition,
    ).toUpperCase();

    const isLite = edition === "lite";
    const t1 = isLite ? kugouAesEncryptFixed(`|${nowMs}`, KUGOU_LITE_T1_KEY, KUGOU_LITE_T1_IV) : 0;
    const t2 = isLite
      ? kugouAesEncryptFixed(
          `${this.#client.deviceGuid}|0f607264fc6318a92b9e13c65db7cd3c|${this.#client.deviceMac}|${this.#client.deviceDev}|${nowMs}`,
          KUGOU_LITE_T2_KEY,
          KUGOU_LITE_T2_IV,
        )
      : 0;

    const loginRes = await this.#client.request<RawKugouOpenplatLoginResponse>({
      path: "/v6/login_by_openplat",
      method: "POST",
      data: {
        dev: this.#client.deviceDev,
        force_login: 1,
        partnerid: 36,
        clienttime_ms: nowMs,
        t1,
        t2,
        t3: "MCwwLDAsMCwwLDAsMCwwLDA=",
        openid: oauthRes.openid,
        params: encryptedToken.str,
        pk,
      },
      headers: { "x-router": "login.user.kugou.com" },
      cookieMap: { dfid, kg_edition: edition },
      edition,
    });

    if (loginRes.status !== 1 || !loginRes.data) {
      return {
        status: "error",
        code: loginRes.error_code ?? 502,
        message: `酷狗开放平台登录失败 (code ${loginRes.error_code ?? "unknown"})。`,
      };
    }

    let token = loginRes.data.token?.trim() ?? "";
    if (loginRes.data.secu_params) {
      const decrypted = kugouAesDecrypt(loginRes.data.secu_params, encryptedToken.key);
      if (typeof decrypted === "string" && decrypted.trim()) {
        token = decrypted.trim();
      } else if (decrypted && typeof decrypted === "object" && typeof decrypted.token === "string") {
        token = decrypted.token.trim();
      }
    }

    const userid = String(loginRes.data.userid ?? "").replace(/\D/g, "");
    if (!userid || userid === "0" || !token) {
      return {
        status: "error",
        code: 502,
        message: "微信授权成功但未解析出有效酷狗账号凭证。",
      };
    }

    const rawCookie = serializeKugouCookie({
      userid,
      token,
      kg_edition: edition,
      dfid,
      ...(loginRes.data.vip_type !== undefined ? { vip_type: String(loginRes.data.vip_type) } : {}),
      ...(loginRes.data.vip_token ? { vip_token: loginRes.data.vip_token } : {}),
      ...(loginRes.data.t1 ? { t1: String(loginRes.data.t1) } : {}),
    });

    return {
      status: "confirmed",
      code: 200,
      message: `微信授权登录酷狗${isLite ? "概念版" : "标准版"}成功`,
      rawCookie,
      nickname: loginRes.data.nickname?.trim() || undefined,
      avatarUrl: loginRes.data.pic?.trim() || undefined,
    };
  }
}
