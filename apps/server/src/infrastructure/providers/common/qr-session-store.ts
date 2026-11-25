import { ScopedLruCache } from "../../security/scoped-lru-cache.js";

const DEFAULT_QR_SESSION_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_QR_SESSIONS = 100;

/**
 * Scope-bound, bounded-memory QR login session store backed by ScopedLruCache.
 */
export class QrSessionStore<T> {
  readonly #cache: ScopedLruCache<T>;
  readonly #ttlMs: number;

  constructor(options?: { maxSessions?: number; ttlMs?: number }) {
    this.#ttlMs = Math.max(1000, options?.ttlMs ?? DEFAULT_QR_SESSION_TTL_MS);
    this.#cache = new ScopedLruCache<T>({
      maxEntries: Math.max(1, options?.maxSessions ?? DEFAULT_MAX_QR_SESSIONS),
      defaultTtlMs: this.#ttlMs,
    });
  }

  #entryKey(key: string): string {
    return `qr:${key}\u0000`;
  }

  set(scopeKey: string, key: string, session: T): void {
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    this.#cache.set(scopeKey, this.#entryKey(trimmedKey), session, this.#ttlMs);
  }

  get(scopeKey: string, key: string): T | undefined {
    const trimmedKey = key.trim();
    if (!trimmedKey) return undefined;
    return this.#cache.get(scopeKey, this.#entryKey(trimmedKey));
  }

  delete(scopeKey: string, key: string): void {
    const trimmedKey = key.trim();
    if (!trimmedKey) return;
    this.#cache.invalidateScope(scopeKey, this.#entryKey(trimmedKey));
  }

  invalidateScope(scopeKey: string): void {
    this.#cache.invalidateScope(scopeKey);
  }
}
