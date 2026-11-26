import type { MusicPlatform, PlatformBindingView, SystemFallbackView } from "#shared";
import type { CredentialVault } from "../../security/credential-vault.js";
import type { SqliteClient } from "../client.js";

interface RawBindingRow {
  user_id: string;
  platform: MusicPlatform;
  encrypted_cookie: string;
  account_uid: string | null;
  display_name: string | null;
  avatar_url: string | null;
  vip_enabled: number;
  vip_expire_at: number | null;
  verified_at: number;
}

interface RawFallbackRow {
  platform: MusicPlatform;
  encrypted_cookie: string;
  enabled: number;
  updated_at: number;
}

export interface ResolvedBindingCredential {
  readonly view: PlatformBindingView;
  readonly cookie: string | null;
}

const CORRUPTED_CREDENTIAL_MESSAGE = "已保存的平台凭据解密失败，请重新绑定。";

function emptyBindingView(platform: MusicPlatform): PlatformBindingView {
  return {
    platform,
    connected: false,
    accountUid: null,
    displayName: null,
    avatarUrl: null,
    vipEnabled: false,
    vipExpireAt: null,
    verifiedAt: null,
  };
}

export class CredentialRepository {
  readonly #sqlite: SqliteClient;
  readonly #vault: CredentialVault;

  constructor(sqlite: SqliteClient, vault: CredentialVault) {
    this.#sqlite = sqlite;
    this.#vault = vault;
  }

  #resolveRow(userId: string, platform: MusicPlatform, row?: RawBindingRow): ResolvedBindingCredential {
    if (!row) {
      return { view: emptyBindingView(platform), cookie: null };
    }

    if (!row.encrypted_cookie) {
      console.warn(`[CredentialRepository] Empty encrypted_cookie for ${platform} (user ${userId})`);
      return {
        view: {
          platform: row.platform,
          connected: false,
          accountUid: null,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          vipEnabled: false,
          vipExpireAt: null,
          verifiedAt: row.verified_at,
          credentialCorrupted: true,
          message: CORRUPTED_CREDENTIAL_MESSAGE,
        },
        cookie: null,
      };
    }

    try {
      const cookie = this.#vault.decrypt(row.encrypted_cookie);
      return {
        view: {
          platform: row.platform,
          connected: true,
          accountUid: row.account_uid,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          vipEnabled: Boolean(row.vip_enabled),
          vipExpireAt: row.vip_expire_at,
          verifiedAt: row.verified_at,
        },
        cookie,
      };
    } catch (error) {
      console.warn(
        `[CredentialRepository] Failed to decrypt ${platform} credential for user ${userId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return {
        view: {
          platform: row.platform,
          connected: false,
          accountUid: null,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          vipEnabled: false,
          vipExpireAt: null,
          verifiedAt: row.verified_at,
          credentialCorrupted: true,
          message: CORRUPTED_CREDENTIAL_MESSAGE,
        },
        cookie: null,
      };
    }
  }

  saveBinding(
    userId: string,
    input: {
      platform: MusicPlatform;
      cookie: string;
      accountUid: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      vipEnabled: boolean;
      vipExpireAt: number | null;
    },
  ): PlatformBindingView {
    const encrypted = this.#vault.encrypt(input.cookie.trim());
    const verifiedAt = Date.now();

    this.#sqlite.db
      .prepare(
        `INSERT INTO platform_credentials (
          user_id, platform, encrypted_cookie, account_uid, display_name, avatar_url,
          vip_enabled, vip_expire_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, platform) DO UPDATE SET
          encrypted_cookie = excluded.encrypted_cookie,
          account_uid = excluded.account_uid,
          display_name = excluded.display_name,
          avatar_url = excluded.avatar_url,
          vip_enabled = excluded.vip_enabled,
          vip_expire_at = excluded.vip_expire_at,
          verified_at = excluded.verified_at`,
      )
      .run(
        userId,
        input.platform,
        encrypted,
        input.accountUid,
        input.displayName,
        input.avatarUrl,
        input.vipEnabled ? 1 : 0,
        input.vipExpireAt,
        verifiedAt,
      );

    return {
      platform: input.platform,
      connected: true,
      accountUid: input.accountUid,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      vipEnabled: input.vipEnabled,
      vipExpireAt: input.vipExpireAt,
      verifiedAt,
    };
  }

  deleteBinding(userId: string, platform: MusicPlatform): void {
    this.#sqlite.db
      .prepare("DELETE FROM platform_credentials WHERE user_id = ? AND platform = ?")
      .run(userId, platform);
  }

  /**
   * Single-query reader returning both the desensitized binding view and the decrypted cookie
   * (or flagging `credentialCorrupted: true` when master-key decryption fails).
   */
  resolveBindingWithCookie(userId: string, platform: MusicPlatform): ResolvedBindingCredential {
    const row = this.#sqlite.db
      .prepare("SELECT * FROM platform_credentials WHERE user_id = ? AND platform = ?")
      .get(userId, platform) as RawBindingRow | undefined;
    return this.#resolveRow(userId, platform, row);
  }

  getBindingView(userId: string, platform: MusicPlatform): PlatformBindingView {
    return this.resolveBindingWithCookie(userId, platform).view;
  }

  listBindingViews(userId: string): Record<MusicPlatform, PlatformBindingView> {
    const rows = this.#sqlite.db
      .prepare("SELECT * FROM platform_credentials WHERE user_id = ?")
      .all(userId) as unknown as RawBindingRow[];

    const byPlatform = new Map<MusicPlatform, RawBindingRow>();
    for (const row of rows) {
      byPlatform.set(row.platform, row);
    }

    return {
      netease: this.#resolveRow(userId, "netease", byPlatform.get("netease")).view,
      qq: this.#resolveRow(userId, "qq", byPlatform.get("qq")).view,
      kugou: this.#resolveRow(userId, "kugou", byPlatform.get("kugou")).view,
    };
  }

  /**
   * Server-internal only: decrypts the stored platform cookie for outbound API calls.
   */
  getDecryptedCookie(userId: string, platform: MusicPlatform): string | null {
    return this.resolveBindingWithCookie(userId, platform).cookie;
  }

  getSystemFallbackView(platform: MusicPlatform): SystemFallbackView {
    const row = this.#sqlite.db
      .prepare("SELECT * FROM system_fallback_credentials WHERE platform = ?")
      .get(platform) as RawFallbackRow | undefined;

    if (!row) {
      return { platform, configured: false, enabled: false, updatedAt: null };
    }
    return {
      platform: row.platform,
      configured: Boolean(row.encrypted_cookie),
      enabled: Boolean(row.enabled) && Boolean(row.encrypted_cookie),
      updatedAt: row.updated_at,
    };
  }

  saveSystemFallback(
    platform: MusicPlatform,
    input: { cookie?: string; enabled: boolean; clearCookie?: boolean },
  ): SystemFallbackView {
    if (input.clearCookie) {
      this.#sqlite.db.prepare("DELETE FROM system_fallback_credentials WHERE platform = ?").run(platform);
      return { platform, configured: false, enabled: false, updatedAt: null };
    }

    const existing = this.#sqlite.db
      .prepare("SELECT encrypted_cookie FROM system_fallback_credentials WHERE platform = ?")
      .get(platform) as { encrypted_cookie: string } | undefined;

    const encrypted = input.cookie?.trim()
      ? this.#vault.encrypt(input.cookie.trim())
      : (existing?.encrypted_cookie ?? "");

    if (!encrypted) {
      this.#sqlite.db.prepare("DELETE FROM system_fallback_credentials WHERE platform = ?").run(platform);
      return { platform, configured: false, enabled: false, updatedAt: null };
    }

    const updatedAt = Date.now();
    const effectiveEnabled = Boolean(input.enabled);

    this.#sqlite.db
      .prepare(
        `INSERT INTO system_fallback_credentials (platform, encrypted_cookie, enabled, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(platform) DO UPDATE SET
           encrypted_cookie = excluded.encrypted_cookie,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(platform, encrypted, effectiveEnabled ? 1 : 0, updatedAt);

    return {
      platform,
      configured: Boolean(encrypted),
      enabled: effectiveEnabled,
      updatedAt,
    };
  }

  getDecryptedSystemFallbackCookie(platform: MusicPlatform): string | null {
    const row = this.#sqlite.db
      .prepare("SELECT encrypted_cookie, enabled FROM system_fallback_credentials WHERE platform = ?")
      .get(platform) as { encrypted_cookie: string; enabled: number } | undefined;

    if (!row || !row.enabled || !row.encrypted_cookie) return null;
    try {
      return this.#vault.decrypt(row.encrypted_cookie);
    } catch (error) {
      console.warn(
        `[CredentialRepository] Failed to decrypt system fallback credential for ${platform}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
}
