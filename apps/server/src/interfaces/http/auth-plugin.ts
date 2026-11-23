import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../../config/env.js";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";

export const SESSION_COOKIE_NAME = "tv_session";

declare module "fastify" {
  interface FastifyRequest {
    actor: ActorContext | null;
  }
}

export function requireActor(request: FastifyRequest): ActorContext {
  if (!request.actor) {
    throw new AppError("UNAUTHORIZED", "请先登录后再继续操作。");
  }
  return request.actor;
}

export function requireAdminActor(request: FastifyRequest): ActorContext {
  const actor = requireActor(request);
  if (actor.role !== "admin") {
    throw new AppError("FORBIDDEN", "需要管理员权限。");
  }
  return actor;
}

export function setSessionCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  token: string,
  config: ServerConfig,
): void {
  const isSecure =
    config.cookieSecure === "true"
      ? true
      : config.cookieSecure === "false"
        ? false
        : request.protocol === "https";

  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecure,
    path: "/",
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
}
