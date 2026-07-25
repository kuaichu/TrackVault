import express from "express";
import type {
  AppSettings,
  AppSettingsUpdate,
  NeteaseCookieCheckResult,
  PublicAppSettings,
  QqMusicCookieCheckResult
} from "../types.js";

export type SettingsRouterDependencies = {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (input: AppSettingsUpdate) => Promise<AppSettings>;
  toPublicSettings: (settings: AppSettings) => PublicAppSettings;
  isSettingsUpdateConflictError: (error: unknown) => boolean;
};

export type PlatformCookieRouterDependencies = {
  getSettings: () => Promise<AppSettings>;
  checkNeteaseCookie: (cookie: string) => Promise<NeteaseCookieCheckResult>;
  importNeteaseCookie: (cookie: string) => Promise<NeteaseCookieCheckResult>;
  importQqMusicCookie: (cookie: string) => Promise<QqMusicCookieCheckResult>;
};

export function createSettingsRouter(dependencies: SettingsRouterDependencies) {
  const router = express.Router();

  router.get("/api/settings", async (_request, response) => {
    response.json(dependencies.toPublicSettings(await dependencies.getSettings()));
  });

  router.put("/api/settings", async (request, response) => {
    try {
      const settings = await dependencies.saveSettings(request.body as AppSettingsUpdate);
      response.json(dependencies.toPublicSettings(settings));
    } catch (error) {
      if (dependencies.isSettingsUpdateConflictError(error)) {
        response.status(400).json({ message: error instanceof Error ? error.message : "" });
        return;
      }
      throw error;
    }
  });

  return router;
}

export function createPlatformCookieRouter(dependencies: PlatformCookieRouterDependencies) {
  const router = express.Router();

  router.post("/api/settings/netease-cookie/check", async (request, response) => {
    try {
      const submittedCookie = typeof request.body?.cookie === "string" ? request.body.cookie.trim() : "";
      if (submittedCookie) {
        response.json(await dependencies.importNeteaseCookie(submittedCookie));
        return;
      }
      response.json(await dependencies.checkNeteaseCookie((await dependencies.getSettings()).neteaseCookie));
    } catch (error) {
      response.status(409).json({ message: error instanceof Error ? error.message : "网易云 Cookie 导入失败" });
    }
  });

  router.post("/api/settings/qqmusic-cookie/check", async (request, response) => {
    try {
      const cookie = typeof request.body?.cookie === "string" ? request.body.cookie : "";
      response.json(await dependencies.importQqMusicCookie(cookie));
    } catch (error) {
      response.status(409).json({ message: error instanceof Error ? error.message : "QQ 音乐 Cookie 导入失败" });
    }
  });

  return router;
}
