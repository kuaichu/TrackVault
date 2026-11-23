import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CredentialVault {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const PREFIX = "v1:";

function deriveKeyFromMaterial(material: string): Buffer {
  const trimmed = material.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const asBase64 = Buffer.from(trimmed, "base64");
  if (asBase64.length === 32 && asBase64.toString("base64") === trimmed) {
    return asBase64;
  }
  return crypto.createHash("sha256").update(trimmed).digest();
}

export function loadOrCreateMasterKey(dataDir: string, configuredKey?: string): Buffer {
  if (configuredKey) {
    return deriveKeyFromMaterial(configuredKey);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const keyFile = path.join(dataDir, ".master.key");
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, "utf8").trim();
    if (raw) {
      return deriveKeyFromMaterial(raw);
    }
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return generated;
}

export class AesGcmCredentialVault implements CredentialVault {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("AES-256-GCM master key must be 32 bytes");
    }
    this.#key = Buffer.from(key);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64url")}.${authTag.toString("base64url")}.${encrypted.toString("base64url")}`;
  }

  decrypt(ciphertext: string): string {
    if (!ciphertext.startsWith(PREFIX)) {
      throw new Error("Invalid encrypted credential format");
    }
    const body = ciphertext.slice(PREFIX.length);
    const parts = body.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed encrypted credential payload");
    }
    const [ivB64, tagB64, dataB64] = parts;
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new Error("Incomplete encrypted credential payload");
    }
    const iv = Buffer.from(ivB64, "base64url");
    const authTag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");

    const decipher = crypto.createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  }
}
