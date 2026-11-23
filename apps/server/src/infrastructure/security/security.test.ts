import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { AppError } from "../../domain/errors.js";
import { AesGcmCredentialVault } from "./credential-vault.js";
import { hashPassword, verifyPassword } from "./password.js";
import { SafeHttpClient, isPrivateOrReservedIp } from "./safe-http-client.js";
import { ScopedLruCache } from "./scoped-lru-cache.js";

test("AesGcmCredentialVault encrypts with random IV and detects tampering", () => {
  const vault = new AesGcmCredentialVault(crypto.randomBytes(32));
  const c1 = vault.encrypt("MUSIC_U=secret_token_123");
  const c2 = vault.encrypt("MUSIC_U=secret_token_123");

  assert.notEqual(c1, c2);
  assert.equal(c1.includes("secret_token_123"), false);
  assert.equal(vault.decrypt(c1), "MUSIC_U=secret_token_123");

  const tampered = `${c1.slice(0, -4)}AAAA`;
  assert.throws(() => vault.decrypt(tampered));
});

test("password hashing uses scrypt and verifies safely", () => {
  const hash = hashPassword("StrongPass!2026");
  assert.equal(verifyPassword("StrongPass!2026", hash), true);
  assert.equal(verifyPassword("wrong-pass", hash), false);
});

test("ScopedLruCache enforces scope isolation and bounded eviction", () => {
  const cache = new ScopedLruCache<string>({ maxEntries: 2, defaultTtlMs: 5000 });
  cache.set("user-a", "playlist:1", "private-a");
  assert.equal(cache.get("user-b", "playlist:1"), undefined);
  assert.equal(cache.get("user-a", "playlist:1"), "private-a");

  cache.set("user-b", "playlist:2", "private-b");
  cache.set("user-c", "playlist:3", "private-c");
  assert.equal(cache.size, 2);
  assert.equal(cache.get("user-a", "playlist:1"), undefined);
});

test("SafeHttpClient blocks redirect SSRF, private IPs, and streaming size overflow", async () => {
  assert.equal(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedIp("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);

  // 1) Redirect to evil host must be rejected
  const redirectClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "1.2.3.4" }],
    fetchImpl: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://internal.evil.local/secret" },
      }),
  });

  await assert.rejects(
    () =>
      redirectClient.fetchResponse("https://p1.music.126.net/cover.jpg", {
        allowedHostSuffixes: ["music.126.net"],
      }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_URL",
  );

  // 2) DNS resolving to private IP (DNS rebinding) must be rejected
  const privateDnsClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "169.254.169.254" }],
    fetchImpl: async () => new Response("ok"),
  });

  await assert.rejects(
    () =>
      privateDnsClient.fetchResponse("https://p1.music.126.net/cover.jpg", {
        allowedHostSuffixes: ["music.126.net"],
      }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_URL",
  );

  // 3) Chunked response exceeding maxBytes without Content-Length must abort
  const oversizeClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(600));
            controller.enqueue(new Uint8Array(600));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "image/jpeg" } },
      ),
  });

  await assert.rejects(
    () =>
      oversizeClient.fetchBoundedBytes("https://p1.music.126.net/cover.jpg", {
        allowedHostSuffixes: ["music.126.net"],
        maxBytes: 1000,
        requireContentTypePrefix: "image/",
      }),
    (err: unknown) => err instanceof AppError && err.code === "PAYLOAD_TOO_LARGE",
  );
});
