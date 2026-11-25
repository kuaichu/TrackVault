import type {
  AuthStatus,
  CreateMemberInput,
  LoginInput,
  MusicPlatform,
  PlatformBindingView,
  QrCheckResult,
  QrStartResult,
  SetupAdminInput,
  SystemFallbackView,
  UpdateMemberInput,
  UpdateSystemFallbackInput,
  UserSummary,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type { ProviderRegistry } from "../../domain/ports/music-provider.js";
import type { SqliteClient } from "../../infrastructure/db/client.js";
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { UserRepository } from "../../infrastructure/db/repositories/user-repository.js";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPasswordTimingSafe,
} from "../../infrastructure/security/password.js";
import { ProviderAuthResolver } from "./provider-auth-resolver.js";

export class AuthService {
  readonly #sqlite: SqliteClient;
  readonly #users: UserRepository;
  readonly #credentials: CredentialRepository;
  readonly #authResolver: ProviderAuthResolver;
  readonly #providers: ProviderRegistry;
  readonly #sessionTtlMs: number;
  readonly #onSessionRevoked?: (sessionTokenHash: string) => void;
  readonly #onUserRevoked?: (userId: string) => void;
  readonly #onUserDeleted?: (userId: string) => void;

  constructor(deps: {
    sqlite: SqliteClient;
    users: UserRepository;
    credentials: CredentialRepository;
    authResolver?: ProviderAuthResolver;
    providers: ProviderRegistry;
    sessionTtlMs: number;
    onSessionRevoked?: (sessionTokenHash: string) => void;
    onUserRevoked?: (userId: string) => void;
    onUserDeleted?: (userId: string) => void;
  }) {
    this.#sqlite = deps.sqlite;
    this.#users = deps.users;
    this.#credentials = deps.credentials;
    this.#authResolver = deps.authResolver ?? new ProviderAuthResolver(deps.credentials);
    this.#providers = deps.providers;
    this.#sessionTtlMs = deps.sessionTtlMs;
    this.#onSessionRevoked = deps.onSessionRevoked;
    this.#onUserRevoked = deps.onUserRevoked;
    this.#onUserDeleted = deps.onUserDeleted;
  }

  getAuthStatus(sessionToken: string | undefined): AuthStatus {
    const initialized = this.#users.countUsers() > 0;
    if (!initialized || !sessionToken) {
      return { initialized, authenticated: false, user: null };
    }
    const user = this.#users.findValidSessionUser(hashSessionToken(sessionToken));
    return {
      initialized,
      authenticated: Boolean(user),
      user,
    };
  }

  resolveActorFromToken(sessionToken: string | undefined): ActorContext | null {
    if (!sessionToken) return null;
    const user = this.#users.findValidSessionUser(hashSessionToken(sessionToken));
    if (!user) return null;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      trustedFallback: user.trustedFallback,
    };
  }

  async setupInitialAdmin(input: SetupAdminInput): Promise<{ user: UserSummary; sessionToken: string }> {
    if (this.#users.countUsers() > 0) {
      throw new AppError("CONFLICT", "系统已完成初始化，请直接登录。");
    }

    const passwordHash = await hashPassword(input.password);
    const { token, tokenHash } = generateSessionToken();

    // Re-check inside an IMMEDIATE write transaction so concurrent async setup requests cannot race
    const user = this.#sqlite.immediateTransaction(() => {
      if (this.#users.countUsers() > 0) {
        throw new AppError("CONFLICT", "系统已完成初始化，请直接登录。");
      }
      const created = this.#users.createUser({
        username: input.username,
        passwordHash,
        role: "admin",
        trustedFallback: true,
      });
      this.#users.createSession(tokenHash, created.id, this.#sessionTtlMs);
      return created;
    });

    return { user, sessionToken: token };
  }

  async login(input: LoginInput): Promise<{ user: UserSummary; sessionToken: string }> {
    if (this.#users.countUsers() === 0) {
      throw new AppError("SETUP_REQUIRED", "系统尚未初始化，请先创建管理员账号。");
    }

    const record = this.#users.findByUsername(input.username);
    const valid = await verifyPasswordTimingSafe(input.password, record?.passwordHash);
    if (!record || !valid) {
      throw new AppError("UNAUTHORIZED", "用户名或密码错误。");
    }

    const { token, tokenHash } = generateSessionToken();
    this.#users.createSession(tokenHash, record.id, this.#sessionTtlMs);
    this.#users.purgeExpiredSessions();

    return {
      user: {
        id: record.id,
        username: record.username,
        role: record.role,
        trustedFallback: record.trustedFallback,
        createdAt: record.createdAt,
      },
      sessionToken: token,
    };
  }

  logout(sessionToken: string | undefined): void {
    if (!sessionToken) return;
    const tokenHash = hashSessionToken(sessionToken);
    this.#users.deleteSession(tokenHash);
    this.#onSessionRevoked?.(tokenHash);
  }

  // --- Admin member management ---

  listMembers(actor: ActorContext): UserSummary[] {
    this.#assertAdmin(actor);
    return this.#users.listUsers();
  }

  async createMember(actor: ActorContext, input: CreateMemberInput): Promise<UserSummary> {
    this.#assertAdmin(actor);
    if (this.#users.findByUsername(input.username)) {
      throw new AppError("CONFLICT", `用户名已存在：${input.username}`);
    }
    const passwordHash = await hashPassword(input.password);
    return this.#sqlite.immediateTransaction(() => {
      if (this.#users.findByUsername(input.username)) {
        throw new AppError("CONFLICT", `用户名已存在：${input.username}`);
      }
      return this.#users.createUser({
        username: input.username,
        passwordHash,
        role: input.role,
        trustedFallback: input.trustedFallback,
      });
    });
  }

  async updateMember(actor: ActorContext, memberId: string, input: UpdateMemberInput): Promise<UserSummary> {
    this.#assertAdmin(actor);
    if (memberId === actor.userId && input.role && input.role !== "admin") {
      throw new AppError("VALIDATION_ERROR", "不能撤销当前登录管理员自身的管理员权限。");
    }

    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    const updated = this.#users.updateUser(memberId, {
      role: input.role,
      trustedFallback: input.trustedFallback,
      passwordHash,
    });
    if (!updated) {
      throw new AppError("NOT_FOUND", "成员账号不存在。");
    }

    if (input.password) {
      this.#users.deleteUserSessions(memberId);
    }
    if (input.password || input.trustedFallback === false || input.role === "member") {
      this.#onUserRevoked?.(memberId);
    }
    return updated;
  }

  deleteMember(actor: ActorContext, memberId: string): void {
    this.#assertAdmin(actor);
    if (memberId === actor.userId) {
      throw new AppError("VALIDATION_ERROR", "不能删除当前登录账号。");
    }
    this.#users.deleteUserSessions(memberId);
    if (!this.#users.deleteUser(memberId)) {
      throw new AppError("NOT_FOUND", "成员账号不存在。");
    }
    this.#invalidateAllProviderScopes(memberId);
    this.#onUserDeleted?.(memberId);
  }

  // --- Platform credential bindings (never exposes raw cookies to frontend) ---

  listPlatformBindings(actor: ActorContext): Record<MusicPlatform, PlatformBindingView> {
    return this.#authResolver.listBindingViews(actor.userId);
  }

  async bindPlatformCookie(
    actor: ActorContext,
    platform: MusicPlatform,
    rawCookie: string,
  ): Promise<PlatformBindingView> {
    const adapter = this.#providers.get(platform);
    const verification = await adapter.verifyCredential(rawCookie);
    if (!verification.ok) {
      throw new AppError("CREDENTIAL_INVALID", verification.message);
    }

    const saved = this.#credentials.saveBinding(actor.userId, {
      platform,
      cookie: verification.normalizedCookie ?? rawCookie,
      accountUid: verification.accountUid,
      displayName: verification.displayName,
      avatarUrl: verification.avatarUrl,
      vipEnabled: verification.vipEnabled,
      vipExpireAt: verification.vipExpireAt,
    });
    adapter.invalidateScope?.(actor.userId);
    return { ...saved, message: verification.message };
  }

  unbindPlatform(actor: ActorContext, platform: MusicPlatform): PlatformBindingView {
    this.#credentials.deleteBinding(actor.userId, platform);
    this.#providers.get(platform).invalidateScope?.(actor.userId);
    return this.#authResolver.getBindingView(actor.userId, platform);
  }

  async startPlatformQrLogin(actor: ActorContext, platform: MusicPlatform): Promise<QrStartResult> {
    const adapter = this.#providers.get(platform);
    if (!adapter.startQrLogin) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持二维码登录。`);
    }
    return adapter.startQrLogin(actor.userId);
  }

  async checkPlatformQrLogin(
    actor: ActorContext,
    platform: MusicPlatform,
    key: string,
  ): Promise<QrCheckResult> {
    const adapter = this.#providers.get(platform);
    if (!adapter.checkQrLogin) {
      throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持二维码登录。`);
    }

    const check = await adapter.checkQrLogin(actor.userId, key);
    if (check.status === "confirmed" && check.rawCookie) {
      const verification = check.verification ?? (await adapter.verifyCredential(check.rawCookie));
      if (!verification.ok) {
        return { status: "error", code: check.code, message: verification.message };
      }

      const binding = this.#credentials.saveBinding(actor.userId, {
        platform,
        cookie: verification.normalizedCookie ?? check.rawCookie,
        accountUid: verification.accountUid,
        displayName: verification.displayName,
        avatarUrl: verification.avatarUrl,
        vipEnabled: verification.vipEnabled,
        vipExpireAt: verification.vipExpireAt,
      });
      adapter.invalidateScope?.(actor.userId);

      // Return ONLY desensitized binding view — rawCookie is never sent over HTTP
      return {
        status: "confirmed",
        code: check.code,
        message: check.message,
        binding,
      };
    }

    return {
      status: check.status,
      code: check.code,
      message: check.message,
    };
  }

  // --- Admin system fallback credentials ---

  listSystemFallbacks(actor: ActorContext): Record<MusicPlatform, SystemFallbackView> {
    this.#assertAdmin(actor);
    return {
      netease: this.#credentials.getSystemFallbackView("netease"),
      qq: this.#credentials.getSystemFallbackView("qq"),
    };
  }

  async saveSystemFallback(
    actor: ActorContext,
    platform: MusicPlatform,
    input: UpdateSystemFallbackInput,
  ): Promise<SystemFallbackView> {
    this.#assertAdmin(actor);
    const adapter = this.#providers.get(platform);

    if (input.clearCookie) {
      const cleared = this.#credentials.saveSystemFallback(platform, { enabled: false, clearCookie: true });
      adapter.invalidateScope?.("system-fallback");
      return cleared;
    }

    const rawCookie = input.cookie?.trim();
    let normalizedCookie: string | undefined;
    if (rawCookie) {
      const verification = await adapter.verifyCredential(rawCookie);
      if (!verification.ok) {
        throw new AppError("CREDENTIAL_INVALID", verification.message);
      }
      normalizedCookie = verification.normalizedCookie ?? rawCookie;
    } else {
      const existing = this.#credentials.getSystemFallbackView(platform);
      if (!existing.configured && input.enabled) {
        throw new AppError("VALIDATION_ERROR", "请先提供有效的保底 Cookie 后再启用。");
      }
    }

    const saved = this.#credentials.saveSystemFallback(platform, {
      cookie: normalizedCookie,
      enabled: input.enabled,
    });
    adapter.invalidateScope?.("system-fallback");
    return saved;
  }

  #invalidateAllProviderScopes(scopeKey: string): void {
    for (const platform of ["netease", "qq"] as const) {
      try {
        this.#providers.get(platform).invalidateScope?.(scopeKey);
      } catch {
        // Ignore unregistered platform in isolated unit tests
      }
    }
  }

  #assertAdmin(actor: ActorContext): void {
    if (actor.role !== "admin") {
      throw new AppError("FORBIDDEN", "需要管理员权限才能执行该操作。");
    }
  }
}
