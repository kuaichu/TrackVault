const MAX_SSE_CONNECTIONS_PER_USER = 8;

export interface SseConnectionRegistry {
  register(params: { userId: string; sessionTokenHash?: string | null; close: () => void }): () => void;
  closeSessionConnections(sessionTokenHash: string): void;
  closeUserConnections(userId: string): void;
  closeAllConnections(): void;
}

interface SseConnectionEntry {
  readonly userId: string;
  readonly sessionTokenHash: string | null;
  readonly close: () => void;
}

/**
 * Session-scoped SSE connection registry indexed by both `userId` and `sessionTokenHash`,
 * ensuring logout immediately terminates only the revoked session's SSE streams while
 * user revocation/deletion terminates all streams belonging to that user.
 */
export class SessionEventHub implements SseConnectionRegistry {
  readonly #byUser = new Map<string, Set<SseConnectionEntry>>();
  readonly #bySession = new Map<string, Set<SseConnectionEntry>>();

  #removeEntry(entry: SseConnectionEntry): void {
    const userSet = this.#byUser.get(entry.userId);
    if (userSet) {
      userSet.delete(entry);
      if (userSet.size === 0) {
        this.#byUser.delete(entry.userId);
      }
    }
    if (entry.sessionTokenHash) {
      const sessionSet = this.#bySession.get(entry.sessionTokenHash);
      if (sessionSet) {
        sessionSet.delete(entry);
        if (sessionSet.size === 0) {
          this.#bySession.delete(entry.sessionTokenHash);
        }
      }
    }
  }

  register(params: { userId: string; sessionTokenHash?: string | null; close: () => void }): () => void {
    const userSet = this.#byUser.get(params.userId) ?? new Set<SseConnectionEntry>();
    this.#byUser.set(params.userId, userSet);

    while (userSet.size >= MAX_SSE_CONNECTIONS_PER_USER) {
      const oldest = userSet.values().next().value;
      if (!oldest) break;
      this.#removeEntry(oldest);
      oldest.close();
    }

    const tokenHash = params.sessionTokenHash?.trim() || null;
    const entry: SseConnectionEntry = {
      userId: params.userId,
      sessionTokenHash: tokenHash,
      close: params.close,
    };

    userSet.add(entry);
    if (tokenHash) {
      const sessionSet = this.#bySession.get(tokenHash) ?? new Set<SseConnectionEntry>();
      this.#bySession.set(tokenHash, sessionSet);
      sessionSet.add(entry);
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#removeEntry(entry);
    };
  }

  closeSessionConnections(sessionTokenHash: string): void {
    const tokenHash = sessionTokenHash.trim();
    if (!tokenHash) return;
    const set = this.#bySession.get(tokenHash);
    if (!set) return;
    for (const entry of [...set]) {
      this.#removeEntry(entry);
      entry.close();
    }
  }

  closeUserConnections(userId: string): void {
    const set = this.#byUser.get(userId);
    if (!set) return;
    for (const entry of [...set]) {
      this.#removeEntry(entry);
      entry.close();
    }
  }

  closeAllConnections(): void {
    for (const userId of [...this.#byUser.keys()]) {
      this.closeUserConnections(userId);
    }
  }
}
