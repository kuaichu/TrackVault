import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

// Precomputed dummy scrypt hash used to equalize login response timing when username does not exist
const DUMMY_SALT = "00112233445566778899aabbccddeeff";
const DUMMY_HASH_HEX = "00".repeat(SCRYPT_KEYLEN);
const DUMMY_PASSWORD_HASH = `scrypt$${DUMMY_SALT}$${DUMMY_HASH_HEX}`;

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = parts[1];
  const expectedHex = parts[2];
  if (!salt || !expectedHex) return false;

  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length === 0) return false;
  const derived = await scryptAsync(password, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Constant-work password check: still executes scrypt when `storedHash` is absent so
 * attackers cannot enumerate usernames via response-time differences.
 */
export async function verifyPasswordTimingSafe(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH).catch(() => false);
    return false;
  }
  return verifyPassword(password, storedHash);
}

export function generateSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
