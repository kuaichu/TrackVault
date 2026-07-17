import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const ADMIN_TOKEN_HEADER = "x-trackvault-admin-token";

export type AdminAuthResult =
  | { ok: true }
  | {
      ok: false;
      status: 403 | 503;
      code: "ADMIN_TOKEN_INVALID" | "ADMIN_TOKEN_NOT_CONFIGURED";
      message: string;
    };

export function authenticateAdminToken(providedToken: string | undefined, configuredToken: string | undefined): AdminAuthResult {
  if (!configuredToken?.trim()) {
    return {
      ok: false,
      status: 503,
      code: "ADMIN_TOKEN_NOT_CONFIGURED",
      message: "服务端未配置管理员令牌，管理接口已禁用。"
    };
  }

  if (!providedToken) {
    return {
      ok: false,
      status: 403,
      code: "ADMIN_TOKEN_INVALID",
      message: "管理员令牌缺失或错误。"
    };
  }

  const expectedDigest = createHash("sha256").update(configuredToken).digest();
  const providedDigest = createHash("sha256").update(providedToken).digest();
  if (!timingSafeEqual(expectedDigest, providedDigest)) {
    return {
      ok: false,
      status: 403,
      code: "ADMIN_TOKEN_INVALID",
      message: "管理员令牌缺失或错误。"
    };
  }

  return { ok: true };
}

export function requireAdminAuth(request: Request, response: Response, next: NextFunction) {
  const result = authenticateAdminToken(request.get(ADMIN_TOKEN_HEADER), process.env.TRACKVAULT_ADMIN_TOKEN);
  if (!result.ok) {
    response.status(result.status).json({ code: result.code, message: result.message });
    return;
  }

  next();
}
