import fs from "node:fs/promises";
import path from "node:path";
import { getClientSessionId } from "./request-context.js";
import type { AccountProfile, AuthSession } from "./types.js";

const dataDir = path.resolve(process.env.TRACKVAULT_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
const emptySession: AuthSession = { loggedIn: false, profile: null };

function getSessionPath() {
  return path.join(dataDir, `account-session.${getClientSessionId()}.json`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAccountProfile(value: unknown): value is AccountProfile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const profile = value as Partial<AccountProfile>;
  return typeof profile.id === "string"
    && profile.id.trim().length > 0
    && typeof profile.displayName === "string"
    && typeof profile.level === "number"
    && typeof profile.vipEnabled === "boolean"
    && typeof profile.avatarSeed === "string"
    && (profile.provider === "demo" || profile.provider === "netease")
    && typeof profile.bio === "string"
    && isStringArray(profile.favoriteGenres)
    && typeof profile.lastLoginAt === "string";
}

function parseStoredSession(value: unknown): AuthSession {
  if (!value || typeof value !== "object") {
    return emptySession;
  }
  const session = value as Partial<AuthSession>;
  if (session.loggedIn === false && session.profile === null) {
    return emptySession;
  }
  if (session.loggedIn === true && isAccountProfile(session.profile)) {
    return { loggedIn: true, profile: session.profile };
  }
  return emptySession;
}

export async function readStoredAccountSession(): Promise<AuthSession> {
  try {
    return parseStoredSession(JSON.parse(await fs.readFile(getSessionPath(), "utf8")) as unknown);
  } catch {
    return emptySession;
  }
}

export async function writeStoredAccountSession(session: AuthSession): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getSessionPath(), JSON.stringify(session, null, 2), "utf8");
}

export async function clearStoredAccountSession(): Promise<void> {
  await writeStoredAccountSession(emptySession);
}
