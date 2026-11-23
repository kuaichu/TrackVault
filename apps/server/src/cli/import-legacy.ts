import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SongSchema } from "#shared";
import { loadServerConfig } from "../config/env.js";
import { SqliteClient } from "../infrastructure/db/client.js";
import { UserRepository } from "../infrastructure/db/repositories/user-repository.js";
import { UserStateRepository } from "../infrastructure/db/repositories/user-state-repository.js";

/**
 * Optional read-only migration utility: imports play history & search history
 * from legacy v1 `data/app.db` into a target v2 user without modifying v1 files.
 * NOTE: Legacy plaintext platform cookies are intentionally NOT migrated — re-bind in v2 UI.
 */
function run(): void {
  const legacyDbArg = process.argv[2] ?? path.resolve(process.cwd(), "../data/app.db");
  const targetUsername = process.argv[3];

  if (!targetUsername) {
    console.error("Usage: npm run import:legacy -- <path-to-legacy-app.db> <v2-username>");
    process.exit(1);
  }

  const legacyDbPath = path.resolve(legacyDbArg);
  if (!fs.existsSync(legacyDbPath)) {
    console.error(`Legacy database not found: ${legacyDbPath}`);
    process.exit(1);
  }

  const config = loadServerConfig();
  const v2Sqlite = new SqliteClient(config.dbPath);
  const userRepo = new UserRepository(v2Sqlite);
  const userStateRepo = new UserStateRepository(v2Sqlite);

  const user = userRepo.findByUsername(targetUsername);
  if (!user) {
    console.error(`Target v2 user not found: ${targetUsername}. Create the user in v2 first.`);
    v2Sqlite.close();
    process.exit(1);
  }

  const legacyDb = new DatabaseSync(legacyDbPath, { readOnly: true });
  let importedSearch = 0;
  let importedPlay = 0;

  try {
    const searchRows = legacyDb
      .prepare("SELECT keyword FROM search_history ORDER BY updated_at ASC")
      .all() as Array<{ keyword: string }>;

    for (const row of searchRows) {
      if (row.keyword?.trim()) {
        userStateRepo.addSearchHistory(user.id, row.keyword);
        importedSearch += 1;
      }
    }

    const playRows = legacyDb
      .prepare("SELECT song_json FROM play_history ORDER BY updated_at ASC")
      .all() as Array<{ song_json: string }>;

    for (const row of playRows) {
      try {
        const raw = JSON.parse(row.song_json) as Record<string, unknown>;
        const platform = raw.source === "qqmusic" ? "qq" : "netease";
        const parsed = SongSchema.safeParse({
          id: String(raw.id ?? ""),
          platform,
          providerSongId: typeof raw.providerSongId === "string" ? raw.providerSongId : undefined,
          mediaId: typeof raw.mediaId === "string" ? raw.mediaId : undefined,
          title: String(raw.title ?? ""),
          artist: String(raw.artist ?? "未知歌手"),
          album: String(raw.album ?? "未知专辑"),
          coverUrl: typeof raw.coverUrl === "string" ? raw.coverUrl : undefined,
          durationSeconds: 0,
          duration: typeof raw.duration === "string" ? raw.duration : "00:00",
          quality: typeof raw.quality === "string" ? raw.quality : "128K",
          availableQualities: Array.isArray(raw.availableQualities) ? raw.availableQualities : [],
        });
        if (parsed.success) {
          userStateRepo.recordPlayHistory(user.id, parsed.data);
          importedPlay += 1;
        }
      } catch {
        // Ignore malformed legacy entry
      }
    }

    console.log(
      `[import:legacy] Completed for '${user.username}': ${importedPlay} play history items, ${importedSearch} search keywords.`,
    );
    console.log(
      "[import:legacy] Note: Legacy plaintext cookies were intentionally skipped. Re-bind platforms inside TrackVault v2.",
    );
  } finally {
    legacyDb.close();
    v2Sqlite.close();
  }
}

run();
