import assert from "node:assert/strict";
import test from "node:test";
import type { Song } from "#shared";
import { SqliteClient } from "../client.js";
import { UserRepository } from "./user-repository.js";
import { UserStateRepository } from "./user-state-repository.js";

test("UserRepository.findValidSessionUser throttles sessions.last_seen_at writes to 5 minutes", () => {
  const sqlite = new SqliteClient(":memory:");
  try {
    const userRepo = new UserRepository(sqlite);
    const user = userRepo.createUser({
      username: "throttle-user",
      passwordHash: "hash",
      role: "member",
      trustedFallback: false,
    });

    const tokenHash = "session-token-hash-1";
    userRepo.createSession(tokenHash, user.id, 60 * 60 * 1000);

    const initial = sqlite.db
      .prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as { last_seen_at: number };

    // Simulate last_seen_at updated 2 minutes ago (< 5 minutes) -> MUST NOT write
    const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
    sqlite.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(twoMinutesAgo, tokenHash);

    const foundWithinWindow = userRepo.findValidSessionUser(tokenHash);
    assert.equal(foundWithinWindow?.id, user.id);

    const afterReadWithinWindow = sqlite.db
      .prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as { last_seen_at: number };
    assert.equal(afterReadWithinWindow.last_seen_at, twoMinutesAgo);

    // Simulate last_seen_at 6 minutes ago (>= 5 minutes) -> MUST update last_seen_at
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    sqlite.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(sixMinutesAgo, tokenHash);

    const foundStale = userRepo.findValidSessionUser(tokenHash);
    assert.equal(foundStale?.id, user.id);

    const afterReadStale = sqlite.db
      .prepare("SELECT last_seen_at FROM sessions WHERE token_hash = ?")
      .get(tokenHash) as { last_seen_at: number };
    assert.ok(afterReadStale.last_seen_at >= initial.last_seen_at);
    assert.ok(afterReadStale.last_seen_at > sixMinutesAgo);
  } finally {
    sqlite.close();
  }
});

test("UserStateRepository batch import writes play/search history in one transaction and trims to caps", () => {
  const sqlite = new SqliteClient(":memory:");
  try {
    const userRepo = new UserRepository(sqlite);
    const stateRepo = new UserStateRepository(sqlite);
    const user = userRepo.createUser({
      username: "batch-user",
      passwordHash: "hash",
      role: "member",
      trustedFallback: false,
    });

    const playEntries: Array<{ song: Song; playedAt: number }> = Array.from({ length: 120 }, (_, i) => ({
      playedAt: 1_700_000_000_000 + i * 1000,
      song: {
        id: String(i + 1),
        platform: "netease",
        title: `Track ${i + 1}`,
        artist: "Artist",
        album: "Album",
        durationSeconds: 180,
        duration: "03:00",
        quality: "320K",
        availableQualities: [{ level: "exhigh", label: "320K" }],
      },
    }));

    const importedPlays = stateRepo.importPlayHistoryBatch(user.id, playEntries);
    assert.equal(importedPlays, 120);

    const plays = stateRepo.getPlayHistory(user.id);
    assert.equal(plays.length, 100);
    assert.equal(plays[0]?.id, "120");
    assert.equal(plays[99]?.id, "21");

    const searchEntries = Array.from({ length: 40 }, (_, i) => ({
      keyword: `kw-${i + 1}`,
      updatedAt: 1_700_000_000_000 + i * 1000,
    }));
    const importedSearches = stateRepo.importSearchHistoryBatch(user.id, searchEntries);
    assert.equal(importedSearches, 40);

    const searches = stateRepo.getSearchHistory(user.id);
    assert.equal(searches.length, 30);
    assert.equal(searches[0], "kw-40");
    assert.equal(searches[29], "kw-11");
  } finally {
    sqlite.close();
  }
});
