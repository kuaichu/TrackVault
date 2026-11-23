import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { AppError } from "../../domain/errors.js";
import { AesGcmCredentialVault } from "./credential-vault.js";
import { hashPassword, verifyPassword, verifyPasswordTimingSafe } from "./password.js";
import { SafeHttpClient, isPrivateOrReservedIp } from "./safe-http-client.js";
import { ScopedLruCache } from "./scoped-lru-cache.js";

test("AesGcmCredentialVault encrypts with random IV, handles empty strings, and detects tampering/short tags", () => {
  const vault = new AesGcmCredentialVault(crypto.randomBytes(32));
  const c1 = vault.encrypt("MUSIC_U=secret_token_123");
  const c2 = vault.encrypt("MUSIC_U=secret_token_123");

  assert.notEqual(c1, c2);
  assert.equal(c1.includes("secret_token_123"), false);
  assert.equal(vault.decrypt(c1), "MUSIC_U=secret_token_123");

  // Empty plaintext must round-trip cleanly (C011)
  const emptyCipher = vault.encrypt("");
  assert.equal(vault.decrypt(emptyCipher), "");

  // Tampered payload rejected
  const tampered = `${c1.slice(0, -4)}AAAA`;
  assert.throws(() => vault.decrypt(tampered));

  // Truncated auth tag rejected (C011)
  const parts = c1.slice(3).split(".");
  const shortTag = `v1:${parts[0]}.${Buffer.alloc(8).toString("base64url")}.${parts[2]}`;
  assert.throws(() => vault.decrypt(shortTag));
});

test("password hashing uses async scrypt and verifies timing-safely", async () => {
  const hash = await hashPassword("StrongPass!2026");
  assert.equal(await verifyPassword("StrongPass!2026", hash), true);
  assert.equal(await verifyPassword("wrong-pass", hash), false);
  assert.equal(await verifyPasswordTimingSafe("anything", null), false);
  assert.equal(await verifyPasswordTimingSafe("StrongPass!2026", hash), true);
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

test("isPrivateOrReservedIp blocks IPv4, expanded IPv6, IPv4-mapped, link-local, NAT64, 6to4, and multicast", () => {
  // IPv4 private/reserved
  assert.equal(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("169.254.169.254"), true);
  assert.equal(isPrivateOrReservedIp("10.0.0.5"), true);
  assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
  assert.equal(isPrivateOrReservedIp("8.8.8.8"), false);

  // IPv6 edge cases (C006)
  assert.equal(isPrivateOrReservedIp("::1"), true);
  assert.equal(isPrivateOrReservedIp("[::1]"), true);
  assert.equal(isPrivateOrReservedIp("0:0:0:0:0:0:0:1"), true);
  assert.equal(isPrivateOrReservedIp("0:0:0:0:0:0:0:0"), true);
  assert.equal(isPrivateOrReservedIp("0:0:0:0:0:ffff:127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("0:0:0:0:0:ffff:7f00:1"), true);
  assert.equal(isPrivateOrReservedIp("fe90::1"), true);
  assert.equal(isPrivateOrReservedIp("febf::1"), true);
  assert.equal(isPrivateOrReservedIp("fc00::1"), true);
  assert.equal(isPrivateOrReservedIp("fd12:3456::1"), true);
  assert.equal(isPrivateOrReservedIp("64:ff9b::127.0.0.1"), true);
  assert.equal(isPrivateOrReservedIp("2002:7f00:0001::"), true);
  assert.equal(isPrivateOrReservedIp("ff02::1"), true);

  // Legitimate public IPv6 & IPv4-mapped public
  assert.equal(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946"), false);
  assert.equal(isPrivateOrReservedIp("::ffff:93.184.216.34"), false);
});

test("SafeHttpClient blocks redirect SSRF, bracketed IPv6 literals, private DNS, and streaming overflow", async () => {
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
  redirectClient.close();

  // 2) Bracketed IPv6 literal must be rejected as IP literal (C006)
  const ipLiteralClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () => new Response("ok"),
  });
  await assert.rejects(
    () =>
      ipLiteralClient.fetchResponse("https://[::1]/secret", {
        allowedHostSuffixes: ["music.126.net"],
      }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_URL",
  );
  ipLiteralClient.close();

  // 3) DNS resolving to private IP or expanded IPv6 loopback must be rejected
  const privateDnsClient = new SafeHttpClient({
    resolveHost: async () => [{ address: "0:0:0:0:0:ffff:7f00:1" }],
    fetchImpl: async () => new Response("ok"),
  });

  await assert.rejects(
    () =>
      privateDnsClient.fetchResponse("https://p1.music.126.net/cover.jpg", {
        allowedHostSuffixes: ["music.126.net"],
      }),
    (err: unknown) => err instanceof AppError && err.code === "UNSAFE_URL",
  );
  privateDnsClient.close();

  // 4) Chunked response exceeding maxBytes without Content-Length must abort
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
  oversizeClient.close();
});
