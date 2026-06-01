import { createRequire } from "node:module";
import { getSession } from "./account-store.js";
import { getSettings, saveSettings } from "./settings-store.js";
import type { AuthSession } from "./types.js";

const require = createRequire(import.meta.url);
const { captcha_sent, login_cellphone, login_qr_check, login_qr_create, login_qr_key } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

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
  const keyResponse = await login_qr_key({ timestamp: Date.now() } as any);
  const keyBody = keyResponse.body as QrKeyBody;
  const key = keyBody.data?.unikey;

  if (!key) {
    throw new Error("二维码登录初始化失败，未获取到登录 key。");
  }

  const qrResponse = await login_qr_create({
    key,
    qrimg: true,
    timestamp: Date.now()
  } as any);
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

  const response = await login_qr_check({
    key: trimmedKey,
    timestamp: Date.now()
  } as any);
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

  const response = await captcha_sent({
    phone: trimmedPhone,
    ctcode: trimmedCountryCode,
    timestamp: Date.now()
  } as any);
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

  const response = await login_cellphone({
    phone: trimmedPhone,
    captcha: trimmedCaptcha,
    countrycode: trimmedCountryCode,
    timestamp: Date.now()
  } as any);
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
