import type { MusicPlatform, PlatformBindingView } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type { ProviderAuthContext } from "../../domain/ports/music-provider.js";
import type {
  CredentialRepository,
  ResolvedBindingCredential,
} from "../../infrastructure/db/repositories/credential-repository.js";

export interface MediaCredentialPlan {
  readonly primary: ProviderAuthContext | null;
  readonly fallback: ProviderAuthContext | null;
}

/**
 * Single authoritative application-layer resolver for provider credentials & binding views.
 * - Eliminates duplicated auth context assembly across CatalogService, MediaService, and TransferService.
 * - Uses single-query `resolveBindingWithCookie` instead of two SQLite queries per operation.
 * - Surfaces master-key decryption failures (`credentialCorrupted: true`) instead of silently showing connected.
 */
export class ProviderAuthResolver {
  readonly #credentials: CredentialRepository;

  constructor(credentials: CredentialRepository) {
    this.#credentials = credentials;
  }

  resolveBinding(userId: string, platform: MusicPlatform): ResolvedBindingCredential {
    if (typeof this.#credentials.resolveBindingWithCookie === "function") {
      return this.#credentials.resolveBindingWithCookie(userId, platform);
    }

    // Compatibility fallback for minimal unit-test stubs that only implement getDecryptedCookie / getBindingView
    const cookie =
      typeof this.#credentials.getDecryptedCookie === "function"
        ? this.#credentials.getDecryptedCookie(userId, platform)
        : null;
    const rawView =
      typeof this.#credentials.getBindingView === "function"
        ? this.#credentials.getBindingView(userId, platform)
        : null;

    return {
      view: rawView ?? {
        platform,
        connected: Boolean(cookie),
        accountUid: null,
        displayName: null,
        avatarUrl: null,
        vipEnabled: false,
        vipExpireAt: null,
        verifiedAt: null,
      },
      cookie,
    };
  }

  getBindingView(userId: string, platform: MusicPlatform): PlatformBindingView {
    if (typeof this.#credentials.resolveBindingWithCookie === "function") {
      return this.#credentials.resolveBindingWithCookie(userId, platform).view;
    }
    return this.#credentials.getBindingView(userId, platform);
  }

  listBindingViews(userId: string): Record<MusicPlatform, PlatformBindingView> {
    if (typeof this.#credentials.listBindingViews === "function") {
      return this.#credentials.listBindingViews(userId);
    }
    return {
      netease: this.getBindingView(userId, "netease"),
      qq: this.getBindingView(userId, "qq"),
    };
  }

  /**
   * Strictly personal auth context — NEVER falls back to admin/system credentials.
   * Used for private reads (user playlists, cloud disk, FM, daily recommend, likes) and all write operations.
   */
  buildPersonalAuth(actor: ActorContext, platform: MusicPlatform, signal?: AbortSignal): ProviderAuthContext {
    const resolved = this.resolveBinding(actor.userId, platform);
    return {
      platform,
      cookie: resolved.cookie,
      scopeKey: actor.userId,
      accountUid: resolved.view.accountUid ?? null,
      ...(resolved.view.connected ? { vipEnabled: resolved.view.vipEnabled } : {}),
      signal,
    };
  }

  /**
   * C015: Read-only public catalog/search auth context.
   * Allows trustedFallback members without their own binding to use system fallback ONLY for public reads.
   */
  buildPublicReadAuth(
    actor: ActorContext,
    platform: MusicPlatform,
    signal?: AbortSignal,
  ): ProviderAuthContext {
    const personal = this.buildPersonalAuth(actor, platform, signal);
    if (personal.cookie) {
      return personal;
    }
    if (actor.trustedFallback && typeof this.#credentials.getDecryptedSystemFallbackCookie === "function") {
      const fallbackCookie = this.#credentials.getDecryptedSystemFallbackCookie(platform);
      if (fallbackCookie) {
        return {
          platform,
          cookie: fallbackCookie,
          scopeKey: "system-fallback",
          accountUid: null,
          signal,
        };
      }
    }
    return personal;
  }

  buildMediaCredentialPlan(
    actor: ActorContext,
    platform: MusicPlatform,
    signal?: AbortSignal,
  ): MediaCredentialPlan {
    const resolved = this.resolveBinding(actor.userId, platform);
    const primaryCookie = resolved.cookie;
    const fallbackCookie =
      actor.trustedFallback && typeof this.#credentials.getDecryptedSystemFallbackCookie === "function"
        ? this.#credentials.getDecryptedSystemFallbackCookie(platform)
        : null;

    if (!primaryCookie && !fallbackCookie) {
      if (resolved.view.credentialCorrupted) {
        throw new AppError(
          "CREDENTIAL_REQUIRED",
          resolved.view.message ?? "已保存的平台凭据解密失败，请重新绑定。",
        );
      }
      throw new AppError(
        "CREDENTIAL_REQUIRED",
        `请先在「账号绑定」中绑定你的 ${platform === "netease" ? "网易云音乐" : "QQ 音乐"} 账号后再播放或下载。`,
      );
    }

    const effectiveFallback = fallbackCookie && fallbackCookie !== primaryCookie ? fallbackCookie : null;

    return {
      primary: primaryCookie
        ? {
            platform,
            cookie: primaryCookie,
            scopeKey: actor.userId,
            accountUid: resolved.view.accountUid ?? null,
            ...(resolved.view.connected ? { vipEnabled: resolved.view.vipEnabled } : {}),
            signal,
          }
        : null,
      fallback: effectiveFallback
        ? {
            platform,
            cookie: effectiveFallback,
            scopeKey: "system-fallback",
            accountUid: null,
            signal,
          }
        : null,
    };
  }
}
