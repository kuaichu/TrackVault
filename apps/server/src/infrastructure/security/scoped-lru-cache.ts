interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Bounded LRU cache that enforces explicit scope isolation (userId or "public") on every key,
 * preventing both cross-session data leaks and unbounded memory growth.
 */
export class ScopedLruCache<T> {
  readonly #store = new Map<string, CacheEntry<T>>();
  readonly #maxEntries: number;
  readonly #defaultTtlMs: number;

  constructor(options: { maxEntries: number; defaultTtlMs: number }) {
    this.#maxEntries = Math.max(1, options.maxEntries);
    this.#defaultTtlMs = Math.max(100, options.defaultTtlMs);
  }

  #composeKey(scopeKey: string, key: string): string {
    if (!scopeKey.trim()) {
      throw new Error("ScopedLruCache requires a non-empty scopeKey");
    }
    return `${scopeKey}\u0000${key}`;
  }

  get(scopeKey: string, key: string): T | undefined {
    const fullKey = this.#composeKey(scopeKey, key);
    const entry = this.#store.get(fullKey);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.#store.delete(fullKey);
      return undefined;
    }

    // Refresh LRU order
    this.#store.delete(fullKey);
    this.#store.set(fullKey, entry);
    return entry.value;
  }

  set(scopeKey: string, key: string, value: T, ttlMs = this.#defaultTtlMs): void {
    const fullKey = this.#composeKey(scopeKey, key);
    if (this.#store.has(fullKey)) {
      this.#store.delete(fullKey);
    }
    this.#store.set(fullKey, {
      value,
      expiresAt: Date.now() + ttlMs,
    });

    while (this.#store.size > this.#maxEntries) {
      const oldestKey = this.#store.keys().next().value;
      if (oldestKey === undefined) break;
      this.#store.delete(oldestKey);
    }
  }

  invalidateScope(scopeKey: string, keyPrefix = ""): void {
    const prefix = `${scopeKey}\u0000${keyPrefix}`;
    for (const fullKey of this.#store.keys()) {
      if (fullKey.startsWith(prefix)) {
        this.#store.delete(fullKey);
      }
    }
  }

  get size(): number {
    return this.#store.size;
  }
}
