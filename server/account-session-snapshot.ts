import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getClientSessionId } from "./request-context.js";
import type { AccountProfile, AuthSession } from "./types.js";

const dataDir = path.resolve(process.env.TRACKVAULT_DATA_DIR?.trim() || path.join(process.cwd(), "data"));
const SNAPSHOT_VERSION = 1;
const emptySession: AuthSession = { loggedIn: false, profile: null };

export type VerifiedCredentialIdentity = {
  provider: "netease" | "qqmusic";
  accountId: string;
  credentialFingerprint: string;
  verified: true;
};

type VerifiedDemoIdentity = {
  provider: "demo";
  accountId: string;
  verified: true;
};

export type StoredAccountIdentitySnapshot = {
  version: typeof SNAPSHOT_VERSION;
  session: AuthSession;
  sessionIdentity: VerifiedCredentialIdentity | VerifiedDemoIdentity | null;
  qqMusicIdentity: VerifiedCredentialIdentity | null;
};

export type VerifiedIdentityState = {
  session: AuthSession;
  qqMusicUin: string | null;
};

const emptySnapshot: StoredAccountIdentitySnapshot = {
  version: SNAPSHOT_VERSION,
  session: emptySession,
  sessionIdentity: null,
  qqMusicIdentity: null
};

const snapshotWriteQueues = new Map<string, Promise<void>>();

function getSessionPath(clientSessionId = getClientSessionId()) {
  return path.join(dataDir, `account-session.${clientSessionId}.json`);
}

function getCredentialFingerprint(credential: string) {
  const normalized = credential.trim();
  return normalized ? crypto.createHash("sha256").update(normalized).digest("hex") : null;
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

function parseSession(value: unknown): AuthSession {
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

function isCredentialIdentity(value: unknown, provider: "netease" | "qqmusic"): value is VerifiedCredentialIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<VerifiedCredentialIdentity>;
  return identity.provider === provider
    && identity.verified === true
    && typeof identity.accountId === "string"
    && identity.accountId.trim().length > 0
    && typeof identity.credentialFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(identity.credentialFingerprint);
}

function isDemoIdentity(value: unknown): value is VerifiedDemoIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<VerifiedDemoIdentity>;
  return identity.provider === "demo"
    && identity.verified === true
    && typeof identity.accountId === "string"
    && identity.accountId.trim().length > 0;
}

function parseStoredSnapshot(value: unknown): StoredAccountIdentitySnapshot {
  if (!value || typeof value !== "object") {
    return emptySnapshot;
  }
  const snapshot = value as Partial<StoredAccountIdentitySnapshot>;
  if (snapshot.version !== SNAPSHOT_VERSION) {
    return emptySnapshot;
  }

  const session = parseSession(snapshot.session);
  const profile = session.profile;
  const sessionIdentity = profile?.provider === "netease" && isCredentialIdentity(snapshot.sessionIdentity, "netease")
    && snapshot.sessionIdentity.accountId === profile.id
      ? snapshot.sessionIdentity
      : profile?.provider === "demo" && isDemoIdentity(snapshot.sessionIdentity)
        && snapshot.sessionIdentity.accountId === profile.id
        ? snapshot.sessionIdentity
        : null;
  const qqMusicIdentity = isCredentialIdentity(snapshot.qqMusicIdentity, "qqmusic")
    && /^\d+$/.test(snapshot.qqMusicIdentity.accountId)
      ? snapshot.qqMusicIdentity
      : null;

  return {
    version: SNAPSHOT_VERSION,
    session: sessionIdentity ? session : emptySession,
    sessionIdentity,
    qqMusicIdentity
  };
}

async function readSnapshotForClient(clientSessionId: string) {
  try {
    return parseStoredSnapshot(JSON.parse(await fs.readFile(getSessionPath(clientSessionId), "utf8")) as unknown);
  } catch {
    return emptySnapshot;
  }
}

async function writeSnapshotForClient(clientSessionId: string, snapshot: StoredAccountIdentitySnapshot) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getSessionPath(clientSessionId), JSON.stringify(snapshot, null, 2), "utf8");
}

async function updateStoredSnapshot(
  update: (snapshot: StoredAccountIdentitySnapshot) => StoredAccountIdentitySnapshot
) {
  const clientSessionId = getClientSessionId();
  const previous = snapshotWriteQueues.get(clientSessionId) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(async () => {
    const current = await readSnapshotForClient(clientSessionId);
    await writeSnapshotForClient(clientSessionId, update(current));
  });
  const settled = result.then(() => undefined, () => undefined);
  snapshotWriteQueues.set(clientSessionId, settled);
  try {
    await result;
  } finally {
    if (snapshotWriteQueues.get(clientSessionId) === settled) {
      snapshotWriteQueues.delete(clientSessionId);
    }
  }
}

function isCredentialIdentityCurrent(identity: VerifiedCredentialIdentity | null, credential: string) {
  const fingerprint = getCredentialFingerprint(credential);
  return Boolean(identity && fingerprint && identity.credentialFingerprint === fingerprint);
}

export async function readStoredAccountIdentitySnapshot(): Promise<StoredAccountIdentitySnapshot> {
  return readSnapshotForClient(getClientSessionId());
}

export async function readStoredVerifiedIdentityState(input: {
  neteaseCookie: string;
  qqMusicCookie: string;
}): Promise<VerifiedIdentityState> {
  const snapshot = await readStoredAccountIdentitySnapshot();
  const session = snapshot.sessionIdentity?.provider === "demo"
    || snapshot.sessionIdentity?.provider === "netease" && isCredentialIdentityCurrent(snapshot.sessionIdentity, input.neteaseCookie)
      ? snapshot.session
      : emptySession;
  const qqMusicUin = snapshot.qqMusicIdentity?.provider === "qqmusic"
    && isCredentialIdentityCurrent(snapshot.qqMusicIdentity, input.qqMusicCookie)
      ? snapshot.qqMusicIdentity.accountId
      : null;
  return { session, qqMusicUin };
}

export async function readStoredAccountSession(neteaseCookie = ""): Promise<AuthSession> {
  return (await readStoredVerifiedIdentityState({ neteaseCookie, qqMusicCookie: "" })).session;
}

export async function writeStoredDemoAccountSession(session: AuthSession): Promise<void> {
  const profile = session.loggedIn ? session.profile : null;
  if (!profile || profile.provider !== "demo") {
    throw new Error("本地身份快照缺少有效 demo profile");
  }
  await updateStoredSnapshot((snapshot) => ({
    ...snapshot,
    session,
    sessionIdentity: { provider: "demo", accountId: profile.id, verified: true }
  }));
}

export async function writeStoredNeteaseAccountSession(session: AuthSession, credential: string): Promise<void> {
  const profile = session.loggedIn ? session.profile : null;
  const credentialFingerprint = getCredentialFingerprint(credential);
  if (!profile || profile.provider !== "netease" || !credentialFingerprint) {
    throw new Error("网易身份快照缺少已验证 profile 或凭证绑定");
  }
  await updateStoredSnapshot((snapshot) => ({
    ...snapshot,
    session,
    sessionIdentity: {
      provider: "netease",
      accountId: profile.id,
      credentialFingerprint,
      verified: true
    }
  }));
}

export async function writeStoredQqMusicIdentity(accountId: string, credential: string): Promise<void> {
  const normalizedAccountId = accountId.trim();
  const credentialFingerprint = getCredentialFingerprint(credential);
  if (!/^\d+$/.test(normalizedAccountId) || !credentialFingerprint) {
    throw new Error("QQ 音乐身份快照缺少已验证 UIN 或凭证绑定");
  }
  await updateStoredSnapshot((snapshot) => ({
    ...snapshot,
    qqMusicIdentity: {
      provider: "qqmusic",
      accountId: normalizedAccountId,
      credentialFingerprint,
      verified: true
    }
  }));
}

export async function clearStoredAccountSession(): Promise<void> {
  await updateStoredSnapshot((snapshot) => ({
    ...snapshot,
    session: emptySession,
    sessionIdentity: null
  }));
}

export async function clearStoredQqMusicIdentity(): Promise<void> {
  await updateStoredSnapshot((snapshot) => ({
    ...snapshot,
    qqMusicIdentity: null
  }));
}
