import { createRequire } from "node:module";
import { getSession } from "./account-store.js";
import { getSettings, saveSettings } from "./settings-store.js";
import type { AuthSession } from "./types.js";

const require = createRequire(import.meta.url);
const { captcha_sent, login_cellphone, login_qr_check, login_qr_create, login_qr_key } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type NeteaseApiParams = Record<string, unknown>;

type NeteaseApiErrorBody = {
  code?: number;
  message?: string;
  msg?: string;
};

type NeteaseApiErrorLike = {
  status?: number;
  body?: NeteaseApiErrorBody;
  message?: string;
};

export type NeteaseQrStartResult = {
  key: string;
  qrImage: string;
  qrUrl: string;
};

export type NeteaseQrCheckResult = {
  code: number;
  message: string;
  cookie?: string;
  session?: AuthSession;
};

export type NeteaseCaptchaSendResult = {
  code: number;
  message: string;
  sent: boolean;
};

export type NeteaseCellphoneLoginResult = {
  code: number;
  message: string;
  cookie?: string;
  session?: AuthSession;
};

type QrKeyBody = {
  data?: {
    unikey?: string;
  };
};

type QrCreateBody = {
  data?: {
    qrimg?: string;
    qrurl?: string;
  };
};

type QrCheckBody = {
  code?: number;
  message?: string;
  cookie?: string;
};

type CaptchaBody = {
  code?: number;
  message?: string;
};

type CellphoneLoginBody = {
  code?: number;
  message?: string;
  cookie?: string;
};

function withNeteaseRequestOptions(params: NeteaseApiParams = {}) {
  const realIP = process.env.NETEASE_REAL_IP?.trim();
  return {
    ...params,
    ...(realIP ? { realIP } : {}),
    timestamp: Date.now()
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getNeteaseApiError(error: unknown): NeteaseApiErrorLike {
  if (!isObject(error)) {
    return {};
  }

  return {
    status: typeof error.status === "number" ? error.status : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
    body: isObject(error.body)
      ? {
          code: typeof error.body.code === "number" ? error.body.code : undefined,
          message: typeof error.body.message === "string" ? error.body.message : undefined,
          msg: typeof error.body.msg === "string" ? error.body.msg : undefined
        }
      : undefined
  };
}

function getNeteaseApiErrorCode(error: unknown) {
  const apiError = getNeteaseApiError(error);
  return apiError.body?.code ?? apiError.status ?? 0;
}

function getNeteaseApiErrorMessage(error: unknown, fallback: string) {
  const apiError = getNeteaseApiError(error);
  const message = apiError.body?.message ?? apiError.body?.msg ?? apiError.message;
  if (!message) {
    return fallback;
  }

  if (apiError.body?.code === 10004) {
    return `${message}。网易云已触发登录风控，请稍后再试；如果仍失败，可在服务端配置 NETEASE_REAL_IP 后重启。`;
  }

  return message;
}

async function persistNeteaseCookie(cookie: string) {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    providerMode: "netease",
    neteaseCookie: cookie
  });

  return getSession();
}

export async function startNeteaseQrLogin(): Promise<NeteaseQrStartResult> {
  let keyResponse;
  try {
    keyResponse = await login_qr_key(withNeteaseRequestOptions() as any);
  } catch (error) {
    throw new Error(getNeteaseApiErrorMessage(error, "二维码登录初始化失败，未获取到登录 key。"));
  }

  const keyBody = keyResponse.body as QrKeyBody;
  const key = keyBody.data?.unikey;

  if (!key) {
    throw new Error("二维码登录初始化失败，未获取到登录 key。");
  }

  let qrResponse;
  try {
    qrResponse = await login_qr_create({
      ...withNeteaseRequestOptions({ key }),
      platform: "web",
      qrimg: true
    } as any);
  } catch (error) {
    throw new Error(getNeteaseApiErrorMessage(error, "二维码生成失败，请稍后重试。"));
  }

  const qrBody = qrResponse.body as QrCreateBody;
  const qrImage = qrBody.data?.qrimg;
  const qrUrl = qrBody.data?.qrurl;

  if (!qrImage || !qrUrl) {
    throw new Error("二维码生成失败，请稍后重试。");
  }

  return {
    key,
    qrImage,
    qrUrl
  };
}

export async function checkNeteaseQrLogin(key: string): Promise<NeteaseQrCheckResult> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new Error("缺少二维码登录 key。");
  }

  let response;
  try {
    response = await login_qr_check({
      ...withNeteaseRequestOptions({ key: trimmedKey }),
      noCookie: true
    } as any);
  } catch (error) {
    const code = getNeteaseApiErrorCode(error);
    return {
      code,
      message: getNeteaseApiErrorMessage(error, "二维码登录状态检查失败。")
    };
  }

  const body = response.body as QrCheckBody;
  const code = body.code ?? 0;
  const message = body.message ?? getQrMessage(code);

  if (code !== 803 || !body.cookie) {
    return { code, message };
  }

  return {
    code,
    message,
    cookie: body.cookie,
    session: await persistNeteaseCookie(body.cookie)
  };
}

export async function sendNeteaseCaptcha(phone: string, countryCode = "86"): Promise<NeteaseCaptchaSendResult> {
  const trimmedPhone = phone.trim();
  const trimmedCountryCode = countryCode.trim() || "86";

  if (!trimmedPhone) {
    throw new Error("请输入手机号。");
  }

  let response;
  try {
    response = await captcha_sent(
      withNeteaseRequestOptions({
        phone: trimmedPhone,
        ctcode: trimmedCountryCode
      }) as any
    );
  } catch (error) {
    const code = getNeteaseApiErrorCode(error);
    return {
      code,
      sent: false,
      message: getNeteaseApiErrorMessage(error, "验证码发送失败。")
    };
  }

  const body = response.body as CaptchaBody;
  const code = body.code ?? 0;

  return {
    code,
    sent: code === 200,
    message: body.message ?? (code === 200 ? "验证码已发送，请留意短信。" : "验证码发送失败。")
  };
}

export async function loginWithNeteaseCellphone(phone: string, captcha: string, countryCode = "86"): Promise<NeteaseCellphoneLoginResult> {
  const trimmedPhone = phone.trim();
  const trimmedCaptcha = captcha.trim();
  const trimmedCountryCode = countryCode.trim() || "86";

  if (!trimmedPhone) {
    throw new Error("请输入手机号。");
  }

  if (!trimmedCaptcha) {
    throw new Error("请输入短信验证码。");
  }

  let response;
  try {
    response = await login_cellphone(
      withNeteaseRequestOptions({
        phone: trimmedPhone,
        captcha: trimmedCaptcha,
        countrycode: trimmedCountryCode
      }) as any
    );
  } catch (error) {
    const code = getNeteaseApiErrorCode(error);
    return {
      code,
      message: getNeteaseApiErrorMessage(error, "手机号验证码登录失败。")
    };
  }

  const body = response.body as CellphoneLoginBody;
  const code = body.code ?? 0;
  const cookie = body.cookie;

  if (code !== 200 || !cookie) {
    return {
      code,
      message: body.message ?? "手机号验证码登录失败。"
    };
  }

  return {
    code,
    message: body.message ?? "登录成功。",
    cookie,
    session: await persistNeteaseCookie(cookie)
  };
}

function getQrMessage(code: number) {
  switch (code) {
    case 800:
      return "二维码已过期，请重新生成。";
    case 801:
      return "等待网易云 App 扫码。";
    case 802:
      return "已扫码，请在手机上确认登录。";
    case 803:
      return "登录成功。";
    default:
      return "正在等待扫码确认。";
  }
}
