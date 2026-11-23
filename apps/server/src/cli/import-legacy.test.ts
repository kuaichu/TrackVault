import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteClient } from "../infrastructure/db/client.js";
import { UserRepository } from "../infrastructure/db/repositories/user-repository.js";
import { UserStateRepository } from "../infrastructure/db/repositories/user-state-repository.js";
import { hashPassword } from "../infrastructure/security/password.js";
import { importLegacyHistory, parseLegacyCliArgs } from "./import-legacy.js";

test("importLegacyHistory enforces per-user isolation (T01) and preserves full song metadata & timestamps (T02/C081)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tv2-legacy-test-"));
  const legacyPath = path.join(tmpDir, "legacy.db");
  const v2Path = path.join(tmpDir, "v2.db");

  try {
    // Seed a multi-user legacy v1 DB
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE search_history (
        user_key TEXT NOT NULL,
        keyword TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_key, keyword)
      );
      CREATE TABLE play_history (
        user_key TEXT NOT NULL,
        song_id TEXT NOT NULL,
        song_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_key, song_id)
      );
    `);

    const aliceSong1 = {
      id: "186016",
      source: "netease",
      title: "晴天",
      artist: "周杰伦",
      primaryArtistId: "6452",
      artists: [{ id: "6452", name: "周杰伦" }],
      album: "叶惠美",
      albumId: "18918",
      duration: "04:29",
      quality: "320K",
      availableQualities: [{ level: "exhigh", label: "320K" }],
    };
    const aliceSong2 = {
      id: "0039MnYb0qxYhV",
      source: "qq",
      title: "七里香",
      artist: "周杰伦",
      primaryArtistId: "0025NhlN2yWrP4",
      album: "七里香",
      albumId: "000MkMni19ClKG",
      duration: "03:42",
      quality: "FLAC",
    };
    const bobSong = {
      id: "99999",
      source: "netease",
      title: "Bob Secret Track",
      artist: "Other",
      album: "Private",
      duration: "02:10",
    };

    legacy
      .prepare("INSERT INTO play_history (user_key, song_id, song_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("session:alice:netease:1", "netease:186016", JSON.stringify(aliceSong1), 1_700_000_100_000);
    legacy
      .prepare("INSERT INTO play_history (user_key, song_id, song_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("session:alice:netease:1", "qq:0039MnYb0qxYhV", JSON.stringify(aliceSong2), 1_700_000_200_000);
    legacy
      .prepare("INSERT INTO play_history (user_key, song_id, song_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("session:bob:netease:2", "netease:99999", JSON.stringify(bobSong), 1_700_000_300_000);

    legacy
      .prepare("INSERT INTO search_history (user_key, keyword, updated_at) VALUES (?, ?, ?)")
      .run("session:alice:netease:1", "周杰伦", 1_700_000_100_000);
    legacy
      .prepare("INSERT INTO search_history (user_key, keyword, updated_at) VALUES (?, ?, ?)")
      .run("session:bob:netease:2", "BobPrivateQuery", 1_700_000_200_000);
    legacy.close();

    // Seed target v2 user
    const v2 = new SqliteClient(v2Path);
    const userRepo = new UserRepository(v2);
    const alice = userRepo.createUser({
      username: "alice",
      passwordHash: await hashPassword("Password123!"),
      role: "admin",
      trustedFallback: true,
    });
    v2.close();

    // 1) Multi-user legacy DB MUST refuse migration without explicit --from-user-key (T01)
    assert.throws(
      () =>
        importLegacyHistory({
          legacyDbPath: legacyPath,
          v2DbPath: v2Path,
          targetUsername: "alice",
        }),
      /Multiple user_key entries found/,
    );

    // 2) Importing only Alice's user_key must NOT leak Bob's history and must preserve metadata (T01/T02/C081)
    const result = importLegacyHistory({
      legacyDbPath: legacyPath,
      v2DbPath: v2Path,
      targetUsername: "alice",
      fromUserKey: "session:alice:netease:1",
    });

    assert.equal(result.importedPlay, 2);
    assert.equal(result.importedSearch, 1);
    assert.equal(result.skippedPlay, 0);

    const v2Verify = new SqliteClient(v2Path);
    const stateRepo = new UserStateRepository(v2Verify);
    const plays = stateRepo.getPlayHistory(alice.id);
    const searches = stateRepo.getSearchHistory(alice.id);
    v2Verify.close();

    assert.deepEqual(searches, ["周杰伦"]);
    assert.equal(plays.length, 2);
    // Newer timestamp (七里香 at 200_000) comes first
    assert.equal(plays[0]?.title, "七里香");
    assert.equal(plays[0]?.platform, "qq");
    assert.equal(plays[0]?.durationSeconds, 222);
    assert.equal(plays[0]?.primaryArtistId, "0025NhlN2yWrP4");
    assert.equal(plays[0]?.albumId, "000MkMni19ClKG");

    assert.equal(plays[1]?.title, "晴天");
    assert.equal(plays[1]?.durationSeconds, 269);
    assert.equal(plays[1]?.primaryArtistId, "6452");
    assert.equal(plays[1]?.albumId, "18918");
    assert.equal(plays[1]?.artists?.[0]?.id, "6452");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("parseLegacyCliArgs supports shorthand username and flags", () => {
  const shorthand = parseLegacyCliArgs(["alice", "--from-user-key=session:1"]);
  assert.equal(shorthand.targetUsername, "alice");
  assert.equal(shorthand.fromUserKey, "session:1");

  const list = parseLegacyCliArgs(["./old.db", "--list-users"]);
  assert.equal(list.listUsers, true);
});
