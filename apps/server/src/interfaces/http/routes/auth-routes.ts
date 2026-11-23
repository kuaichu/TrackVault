import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  BindCookieInputSchema,
  CreateMemberInputSchema,
  LoginInputSchema,
  MusicPlatformSchema,
  SetupAdminInputSchema,
  UpdateMemberInputSchema,
  UpdateSystemFallbackInputSchema,
} from "#shared";
import type { AuthService } from "../../../application/auth/auth-service.js";
import type { ServerConfig } from "../../../config/env.js";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  requireActor,
  requireAdminActor,
  setSessionCookie,
} from "../auth-plugin.js";

const PlatformParamSchema = z.object({ platform: MusicPlatformSchema });
const MemberParamSchema = z.object({ id: z.string().min(1) });
const QrCheckQuerySchema = z.object({ key: z.string().trim().min(1) });

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { authService: AuthService; config: ServerConfig },
): void {
  const { authService, config } = deps;

  app.get("/api/auth/status", async (request) => {
    return authService.getAuthStatus(request.cookies[SESSION_COOKIE_NAME]);
  });

  app.post(
    "/api/auth/setup",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = SetupAdminInputSchema.parse(request.body);
      const { user, sessionToken } = authService.setupInitialAdmin(input);
      setSessionCookie(reply, request, sessionToken, config);
      return reply.code(201).send({ user });
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = LoginInputSchema.parse(request.body);
      const { user, sessionToken } = authService.login(input);
      setSessionCookie(reply, request, sessionToken, config);
      return { user };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    authService.logout(request.cookies[SESSION_COOKIE_NAME]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // --- Platform account bindings ---

  app.get("/api/bindings", async (request) => {
    const actor = requireActor(request);
    return { bindings: authService.listPlatformBindings(actor) };
  });

  app.post(
    "/api/bindings/:platform/cookie",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = requireActor(request);
      const { platform } = PlatformParamSchema.parse(request.params);
      const { cookie } = BindCookieInputSchema.parse(request.body);
      const binding = await authService.bindPlatformCookie(actor, platform, cookie);
      return { binding };
    },
  );

  app.delete("/api/bindings/:platform", async (request) => {
    const actor = requireActor(request);
    const { platform } = PlatformParamSchema.parse(request.params);
    const binding = authService.unbindPlatform(actor, platform);
    return { binding };
  });

  app.post(
    "/api/bindings/:platform/qr/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const actor = requireActor(request);
      const { platform } = PlatformParamSchema.parse(request.params);
      return authService.startPlatformQrLogin(actor, platform);
    },
  );

  app.get("/api/bindings/:platform/qr/check", async (request) => {
    const actor = requireActor(request);
    const { platform } = PlatformParamSchema.parse(request.params);
    const { key } = QrCheckQuerySchema.parse(request.query);
    return authService.checkPlatformQrLogin(actor, platform, key);
  });

  // --- Admin: Members & System Fallbacks ---

  app.get("/api/admin/members", async (request) => {
    const actor = requireAdminActor(request);
    return { members: authService.listMembers(actor) };
  });

  app.post("/api/admin/members", async (request, reply) => {
    const actor = requireAdminActor(request);
    const input = CreateMemberInputSchema.parse(request.body);
    const member = authService.createMember(actor, input);
    return reply.code(201).send({ member });
  });

  app.patch("/api/admin/members/:id", async (request) => {
    const actor = requireAdminActor(request);
    const { id } = MemberParamSchema.parse(request.params);
    const input = UpdateMemberInputSchema.parse(request.body);
    return { member: authService.updateMember(actor, id, input) };
  });

  app.delete("/api/admin/members/:id", async (request) => {
    const actor = requireAdminActor(request);
    const { id } = MemberParamSchema.parse(request.params);
    authService.deleteMember(actor, id);
    return { ok: true };
  });

  app.get("/api/admin/fallbacks", async (request) => {
    const actor = requireAdminActor(request);
    return { fallbacks: authService.listSystemFallbacks(actor) };
  });

  app.put("/api/admin/fallbacks/:platform", async (request) => {
    const actor = requireAdminActor(request);
    const { platform } = PlatformParamSchema.parse(request.params);
    const input = UpdateSystemFallbackInputSchema.parse(request.body);
    return { fallback: authService.saveSystemFallback(actor, platform, input) };
  });
}
