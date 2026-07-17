import { getClientSessionId } from "./request-context.js";

export type CredentialPlatform = "netease" | "qqmusic";

export type CredentialWriteGuard = {
  platform: CredentialPlatform;
  clientSessionId: string;
  revision: number;
};

export class CredentialWriteCancelledError extends Error {
  constructor() {
    super("登录状态已在本次操作期间退出，请重新发起登录。");
    this.name = "CredentialWriteCancelledError";
  }
}

export function createCredentialWriteGuardRegistry() {
  const revisions = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const getKey = (platform: CredentialPlatform, clientSessionId: string) => `${platform}:${clientSessionId}`;
  const getRevision = (platform: CredentialPlatform, clientSessionId: string) => revisions.get(getKey(platform, clientSessionId)) ?? 0;

  async function enqueue<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(key, settled);
    try {
      return await result;
    } finally {
      if (queues.get(key) === settled) {
        queues.delete(key);
      }
    }
  }

  return {
    capture(platform: CredentialPlatform, clientSessionId: string): CredentialWriteGuard {
      return {
        platform,
        clientSessionId,
        revision: getRevision(platform, clientSessionId)
      };
    },
    isCurrent(guard: CredentialWriteGuard) {
      return guard.revision === getRevision(guard.platform, guard.clientSessionId);
    },
    runIfCurrent<T>(guard: CredentialWriteGuard, operation: () => Promise<T> | T) {
      const key = getKey(guard.platform, guard.clientSessionId);
      return enqueue(key, () => {
        if (guard.revision !== getRevision(guard.platform, guard.clientSessionId)) {
          throw new CredentialWriteCancelledError();
        }
        return operation();
      });
    },
    invalidate<T>(platform: CredentialPlatform, clientSessionId: string, operation: () => Promise<T> | T) {
      const key = getKey(platform, clientSessionId);
      return enqueue(key, () => {
        revisions.set(key, getRevision(platform, clientSessionId) + 1);
        return operation();
      });
    }
  };
}

const credentialWriteGuards = createCredentialWriteGuardRegistry();

export function captureCredentialWriteGuard(platform: CredentialPlatform): CredentialWriteGuard {
  return credentialWriteGuards.capture(platform, getClientSessionId());
}

export function isCredentialWriteGuardCurrent(guard: CredentialWriteGuard) {
  return credentialWriteGuards.isCurrent(guard);
}

export function runCredentialWriteIfCurrent<T>(guard: CredentialWriteGuard, operation: () => Promise<T> | T) {
  return credentialWriteGuards.runIfCurrent(guard, operation);
}

export function invalidateCredentialWrites<T>(platform: CredentialPlatform, operation: () => Promise<T> | T) {
  return credentialWriteGuards.invalidate(platform, getClientSessionId(), operation);
}
