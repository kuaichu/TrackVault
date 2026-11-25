import assert from "node:assert/strict";
import test from "node:test";
import { ScopedLruCache } from "./scoped-lru-cache.js";

test("ScopedLruCache tracks per-scope epoch on full invalidation, blocks stale setIfEpoch writes, and bounds epoch map size", () => {
  const cache = new ScopedLruCache<string>({
    maxEntries: 10,
    defaultTtlMs: 60_000,
    maxScopeEpochs: 3,
  });

  const epoch0 = cache.getEpoch("user-1");
  assert.equal(epoch0, 0);

  // Partial keyPrefix invalidation preserves whole-scope epoch
  cache.set("user-1", "playlist:1", "v1");
  cache.set("user-1", "likes:1", "old-likes");
  cache.invalidateScope("user-1", "playlist:");
  assert.equal(cache.getEpoch("user-1"), 0);
  assert.equal(cache.get("user-1", "playlist:1"), undefined);
  assert.equal(cache.get("user-1", "likes:1"), "old-likes");

  // Full scope invalidation clears entries and bumps epoch
  cache.invalidateScope("user-1");
  const epoch1 = cache.getEpoch("user-1");
  assert.equal(epoch1, 1);
  assert.equal(cache.get("user-1", "likes:1"), undefined);

  // Stale writer from epoch0 cannot backfill after invalidation
  assert.equal(cache.setIfEpoch("user-1", "likes:1", "stale-from-A", epoch0), false);
  assert.equal(cache.get("user-1", "likes:1"), undefined);

  // Current epoch1 writer succeeds
  assert.equal(cache.setIfEpoch("user-1", "likes:1", "fresh-from-B", epoch1), true);
  assert.equal(cache.get("user-1", "likes:1"), "fresh-from-B");

  // Bounded epoch map evicts oldest scopes beyond maxScopeEpochs
  cache.invalidateScope("user-2");
  cache.invalidateScope("user-3");
  cache.invalidateScope("user-4");
  assert.equal(cache.epochCount, 3);
  assert.equal(cache.getEpoch("user-1"), 0);
  assert.equal(cache.getEpoch("user-4"), 1);
});
