import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import { SqliteClient } from "../../infrastructure/db/client.js";
import { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import { AesGcmCredentialVault } from "../../infrastructure/security/credential-vault.js";
import { ProviderAuthResolver } from "./provider-auth-resolver.js";

test("ProviderAuthResolver uses single SQLite query and flags credentialCorrupted on master key mismatch", () => {
  const sqlite = new SqliteClient(":memory:");
  const userId = "user-auth-1";
  const actor: ActorContext = {
    userId,
    username: "alice",
    role: "member",
    trustedFallback: false,
  };

  try {
    sqlite.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
         VALUES (?, ?, 'hash', 'member', 0, ?)`,
      )
      .run(userId, actor.username, Date.now());

    const keyA = crypto.randomBytes(32);
    const keyB = crypto.randomBytes(32);
    const repoA = new CredentialRepository(sqlite, new AesGcmCredentialVault(keyA));
    repoA.saveBinding(userId, {
      platform: "qq",
      cookie: "uin=12345; qm_keyst=SECRET",
      accountUid: "12345",
      displayName: "AliceQQ",
      avatarUrl: null,
      vipEnabled: false,
      vipExpireAt: null,
    });

    // 1. Valid master key: single SQLite query returns both view (vipEnabled=false) and cookie
    let prepareCalls = 0;
    const origPrepare = sqlite.db.prepare.bind(sqlite.db);
    sqlite.db.prepare = ((sql: string) => {
      prepareCalls += 1;
      return origPrepare(sql);
    }) as typeof sqlite.db.prepare;

    const resolverOk = new ProviderAuthResolver(repoA);
    const authOk = resolverOk.buildPersonalAuth(actor, "qq");
    assert.equal(prepareCalls, 1);
    assert.equal(authOk.cookie, "uin=12345; qm_keyst=SECRET");
    assert.equal(authOk.accountUid, "12345");
    assert.equal(authOk.vipEnabled, false);

    sqlite.db.prepare = origPrepare;

    // 2. Mismatched master key: NEVER silently reports connected:true; surfaces credentialCorrupted:true
    const repoWrongKey = new CredentialRepository(sqlite, new AesGcmCredentialVault(keyB));
    const resolverBad = new ProviderAuthResolver(repoWrongKey);

    const warnMessages: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    try {
      const resolved = resolverBad.resolveBinding(userId, "qq");
      assert.equal(resolved.cookie, null);
      assert.equal(resolved.view.connected, false);
      assert.equal(resolved.view.credentialCorrupted, true);
      assert.equal(resolved.view.message, "已保存的平台凭据解密失败，请重新绑定。");

      const listViews = resolverBad.listBindingViews(userId);
      assert.equal(listViews.qq.connected, false);
      assert.equal(listViews.qq.credentialCorrupted, true);
      assert.equal(listViews.netease.connected, false);
      assert.equal(listViews.netease.credentialCorrupted, undefined);

      assert.throws(
        () => resolverBad.buildMediaCredentialPlan(actor, "qq"),
        (err: unknown) =>
          err instanceof AppError && err.code === "CREDENTIAL_REQUIRED" && err.message.includes("解密失败"),
      );
      assert.ok(warnMessages.some((msg) => msg.includes("Failed to decrypt qq credential")));
    } finally {
      console.warn = origWarn;
    }
  } finally {
    sqlite.close();
  }
});
