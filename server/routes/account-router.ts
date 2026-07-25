import express from "express";
import type {
  NeteaseCaptchaSendResult,
  NeteaseCellphoneLoginResult,
  NeteaseQrCheckResult,
  NeteaseQrStartResult
} from "../netease-auth.js";
import type { QqMusicQrCheckResult, QqMusicQrStartResult } from "../qqmusic-auth.js";
import type {
  AccountState,
  AuthSession,
  QqMusicAccountStatus,
  QqMusicUserProfile
} from "../types.js";

export type AccountLoginInput = {
  accountName: string;
  vipEnabled: boolean;
  note: string;
};

export type AccountRouterDependencies = {
  getAccountState: (sessionOverride?: AuthSession) => Promise<AccountState>;
  loginSession: (input: AccountLoginInput) => Promise<AuthSession>;
  logoutSession: () => Promise<AuthSession>;
  getQqMusicAccountStatus: () => Promise<QqMusicAccountStatus>;
  getQqMusicUserProfile: () => Promise<QqMusicUserProfile>;
  startQqMusicQrLogin: () => Promise<QqMusicQrStartResult>;
  checkQqMusicQrLogin: (key: string) => Promise<QqMusicQrCheckResult>;
  logoutQqMusicSession: () => Promise<QqMusicAccountStatus>;
  startNeteaseQrLogin: () => Promise<NeteaseQrStartResult>;
  checkNeteaseQrLogin: (key: string) => Promise<NeteaseQrCheckResult>;
  sendNeteaseCaptcha: (phone: string, countryCode?: string) => Promise<NeteaseCaptchaSendResult>;
  loginWithNeteaseCellphone: (phone: string, captcha: string, countryCode?: string) => Promise<NeteaseCellphoneLoginResult>;
};

export function createAccountRouter(dependencies: AccountRouterDependencies) {
  const router = express.Router();

  router.get("/api/account", async (_request, response) => {
    response.json(await dependencies.getAccountState());
  });

  router.get("/api/account/qqmusic", async (_request, response) => {
    response.json(await dependencies.getQqMusicAccountStatus());
  });

  router.get("/api/account/qqmusic/profile", async (_request, response) => {
    try {
      response.json({ profile: await dependencies.getQqMusicUserProfile() });
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取 QQ 音乐个人主页失败"
      });
    }
  });

  router.post("/api/account/qqmusic/qr/start", async (_request, response) => {
    try {
      response.json(await dependencies.startQqMusicQrLogin());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "QQ 音乐二维码生成失败" });
    }
  });

  router.get("/api/account/qqmusic/qr/check", async (request, response) => {
    const key = typeof request.query.key === "string" ? request.query.key : "";

    try {
      response.json(await dependencies.checkQqMusicQrLogin(key));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "QQ 音乐扫码状态检查失败" });
    }
  });

  router.post("/api/account/login", async (request, response) => {
    const accountName = typeof request.body?.accountName === "string" ? request.body.accountName : "";
    const vipEnabled = Boolean(request.body?.vipEnabled);
    const note = typeof request.body?.note === "string" ? request.body.note : "";

    response.json(await dependencies.getAccountState(await dependencies.loginSession({ accountName, vipEnabled, note })));
  });

  router.post("/api/account/logout", async (_request, response) => {
    response.json(await dependencies.getAccountState(await dependencies.logoutSession()));
  });

  router.post("/api/account/qqmusic/logout", async (_request, response) => {
    response.json(await dependencies.logoutQqMusicSession());
  });

  router.post("/api/account/netease/qr/start", async (_request, response) => {
    try {
      response.json(await dependencies.startNeteaseQrLogin());
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "二维码登录初始化失败" });
    }
  });

  router.get("/api/account/netease/qr/check", async (request, response) => {
    const key = typeof request.query.key === "string" ? request.query.key : "";

    try {
      response.json(await dependencies.checkNeteaseQrLogin(key));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "二维码登录状态检查失败" });
    }
  });

  router.post("/api/account/netease/captcha/send", async (request, response) => {
    const phone = typeof request.body?.phone === "string" ? request.body.phone : "";
    const countryCode = typeof request.body?.countryCode === "string" ? request.body.countryCode : "86";

    try {
      response.json(await dependencies.sendNeteaseCaptcha(phone, countryCode));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "验证码发送失败" });
    }
  });

  router.post("/api/account/netease/cellphone/login", async (request, response) => {
    const phone = typeof request.body?.phone === "string" ? request.body.phone : "";
    const captcha = typeof request.body?.captcha === "string" ? request.body.captcha : "";
    const countryCode = typeof request.body?.countryCode === "string" ? request.body.countryCode : "86";

    try {
      response.json(await dependencies.loginWithNeteaseCellphone(phone, captcha, countryCode));
    } catch (error) {
      response.status(500).json({ message: error instanceof Error ? error.message : "手机号登录失败" });
    }
  });

  return router;
}
