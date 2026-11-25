interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Bounded LRU cache that enforces explicit scope isolation (userId or "public") on every key,
 * preventing both cross-session data leaks, stale in-flight backfill after rebind, and unbounded memory growth.
 */
export class ScopedLruCache<T> {
  readonly #store = new Map<string, CacheEntry<T>>();
  readonly #scopeEpochs = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #maxScopeEpochs: number;
  readonly #defaultTtlMs: number;

  constructor(options: { maxEntries: number; defaultTtlMs: number; maxScopeEpochs?: number }) {
    this.#maxEntries = Math.max(1, options.maxEntries);
    this.#maxScopeEpochs = Math.max(1, options.maxScopeEpochs ?? Math.max(64, this.#maxEntries * 4));
    this.#defaultTtlMs = Math.max(100, options.defaultTtlMs);
  }

  #validateScopeKey(scopeKey: string): string {
    if (!scopeKey.trim()) {
      throw new Error("ScopedLruCache requires a non-empty scopeKey");
    }
    return scopeKey;
  }

  #composeKey(scopeKey: string, key: string): string {
    return `${this.#validateScopeKey(scopeKey)}\u0000${key}`;
  }

  getEpoch(scopeKey: string): number {
    const validScope = this.#validateScopeKey(scopeKey);
    const epoch = this.#scopeEpochs.get(validScope);
    if (epoch === undefined) return 0;
    // Refresh LRU order
    this.#scopeEpochs.delete(validScope);
    this.#scopeEpochs.set(validScope, epoch);
    return epoch;
  }

  #bumpScopeEpoch(scopeKey: string): number {
    const validScope = this.#validateScopeKey(scopeKey);
    const next = (this.#scopeEpochs.get(validScope) ?? 0) + 1;
    this.#scopeEpochs.delete(validScope);
    this.#scopeEpochs.set(validScope, next);

    while (this.#scopeEpochs.size > this.#maxScopeEpochs) {
      const oldestScope = this.#scopeEpochs.keys().next().value;
      if (oldestScope === undefined) break;
      this.#scopeEpochs.delete(oldestScope);
    }
    return next;
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

  setIfEpoch(
    scopeKey: string,
    key: string,
    value: T,
    expectedEpoch: number,
    ttlMs = this.#defaultTtlMs,
  ): boolean {
    if (this.getEpoch(scopeKey) !== expectedEpoch) {
      return false;
    }
    this.set(scopeKey, key, value, ttlMs);
    return true;
  }

  invalidateScope(scopeKey: string, keyPrefix = ""): void {
    const validScope = this.#validateScopeKey(scopeKey);
    const prefix = `${validScope}\u0000${keyPrefix}`;
    for (const fullKey of this.#store.keys()) {
      if (fullKey.startsWith(prefix)) {
        this.#store.delete(fullKey);
      }
    }
    if (!keyPrefix) {
      this.#bumpScopeEpoch(validScope);
    }
  }

  get size(): number {
    return this.#store.size;
  }

  get epochCount(): number {
    return this.#scopeEpochs.size;
  }
}
