import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  QualityOptionSchema,
  type Song,
  SongAvailabilitySchema,
  SongSchema,
  parseSafeHttpUrl,
} from "#shared";
import { loadServerConfig } from "../config/env.js";
import { SqliteClient } from "../infrastructure/db/client.js";
import { UserRepository } from "../infrastructure/db/repositories/user-repository.js";
import { UserStateRepository } from "../infrastructure/db/repositories/user-state-repository.js";

export interface LegacyUserSummary {
  userKey: string;
  playCount: number;
  searchCount: number;
}

export interface LegacyImportResult {
  targetUsername: string;
  sourceUserKey: string | null;
  importedPlay: number;
  skippedPlay: number;
  importedSearch: number;
  skippedSearch: number;
}

interface ParsedCliArgs {
  legacyDbPath: string;
  targetUsername?: string;
  fromUserKey?: string;
  allUsers: boolean;
  listUsers: boolean;
}

export function parseDurationToSeconds(rawDuration: unknown, rawDurationSeconds?: unknown): number {
  if (
    typeof rawDurationSeconds === "number" &&
    Number.isFinite(rawDurationSeconds) &&
    rawDurationSeconds > 0
  ) {
    return Math.floor(rawDurationSeconds);
  }
  if (typeof rawDuration !== "string") return 0;
  const trimmed = rawDuration.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map((segment) => Number(segment));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) {
    const [m = 0, s = 0] = parts;
    return Math.floor(m * 60 + s);
  }
  if (parts.length === 3) {
    const [h = 0, m = 0, s = 0] = parts;
    return Math.floor(h * 3600 + m * 60 + s);
  }
  return 0;
}

function formatDurationSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function mapLegacySong(raw: Record<string, unknown>): Song | null {
  const sourceVal = String(raw.source ?? raw.platform ?? "").toLowerCase();
  const platform =
    sourceVal === "qqmusic" || sourceVal === "qq" ? "qq" : sourceVal === "kugou" ? "kugou" : "netease";

  const durationSeconds = parseDurationToSeconds(raw.duration, raw.durationSeconds);
  const duration =
    typeof raw.duration === "string" && raw.duration.trim()
      ? raw.duration.trim()
      : formatDurationSeconds(durationSeconds);

  const primaryArtistId =
    typeof raw.primaryArtistId === "string" && raw.primaryArtistId.trim()
      ? raw.primaryArtistId.trim()
      : undefined;

  const albumId = typeof raw.albumId === "string" && raw.albumId.trim() ? raw.albumId.trim() : undefined;

  let artists: Array<{ id?: string; name: string }> | undefined;
  if (Array.isArray(raw.artists)) {
    const mapped = raw.artists
      .slice(0, 100)
      .map((entry): { id?: string; name: string } | null => {
        if (typeof entry === "string" && entry.trim()) {
          return { name: entry.trim() };
        }
        if (entry && typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          const name = typeof obj.name === "string" ? obj.name.trim() : "";
          if (!name) return null;
          const id =
            typeof obj.id === "string" || typeof obj.id === "number"
              ? String(obj.id).trim() || undefined
              : undefined;
          return id ? { id, name } : { name };
        }
        return null;
      })
      .filter((item): item is { id?: string; name: string } => item !== null);
    if (mapped.length > 0) {
      artists = mapped;
    }
  }

  const availableQualities = Array.isArray(raw.availableQualities)
    ? raw.availableQualities
        .map((q) => QualityOptionSchema.safeParse(q))
        .filter((res) => res.success)
        .map((res) => res.data)
    : [];

  const availabilityParsed = raw.availability ? SongAvailabilitySchema.safeParse(raw.availability) : null;

  const rawCover = typeof raw.coverUrl === "string" ? raw.coverUrl.trim() : undefined;
  const coverUrl = rawCover && parseSafeHttpUrl(rawCover) ? rawCover : undefined;

  const parsed = SongSchema.safeParse({
    id: String(raw.id ?? "").trim(),
    platform,
    providerSongId:
      typeof raw.providerSongId === "string" && raw.providerSongId.trim()
        ? raw.providerSongId.trim()
        : undefined,
    mediaId: typeof raw.mediaId === "string" && raw.mediaId.trim() ? raw.mediaId.trim() : undefined,
    title: String(raw.title ?? "").trim(),
    artist: String(raw.artist ?? "未知歌手").trim() || "未知歌手",
    primaryArtistId,
    artists,
    album: String(raw.album ?? "未知专辑"),
    albumId,
    coverUrl,
    durationSeconds,
    duration,
    quality: typeof raw.quality === "string" && raw.quality.trim() ? raw.quality.trim() : "128K",
    availableQualities,
    isCloud: typeof raw.isCloud === "boolean" ? raw.isCloud : undefined,
    availability: availabilityParsed?.success ? availabilityParsed.data : undefined,
  });

  return parsed.success ? parsed.data : null;
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name ?? "")).filter(Boolean));
}

export function listLegacyUsers(legacyDb: DatabaseSync): LegacyUserSummary[] {
  const counts = new Map<string, { playCount: number; searchCount: number }>();

  const playCols = getTableColumns(legacyDb, "play_history");
  if (playCols.has("user_key")) {
    const rows = legacyDb
      .prepare("SELECT user_key, COUNT(*) AS cnt FROM play_history GROUP BY user_key")
      .all() as Array<{ user_key: string; cnt: number }>;
    for (const row of rows) {
      const entry = counts.get(row.user_key) ?? { playCount: 0, searchCount: 0 };
      entry.playCount = Number(row.cnt) || 0;
      counts.set(row.user_key, entry);
    }
  }

  const searchCols = getTableColumns(legacyDb, "search_history");
  if (searchCols.has("user_key")) {
    const rows = legacyDb
      .prepare("SELECT user_key, COUNT(*) AS cnt FROM search_history GROUP BY user_key")
      .all() as Array<{ user_key: string; cnt: number }>;
    for (const row of rows) {
      const entry = counts.get(row.user_key) ?? { playCount: 0, searchCount: 0 };
      entry.searchCount = Number(row.cnt) || 0;
      counts.set(row.user_key, entry);
    }
  }

  return [...counts.entries()]
    .map(([userKey, stats]) => ({ userKey, ...stats }))
    .sort((a, b) => a.userKey.localeCompare(b.userKey));
}

export function importLegacyHistory(options: {
  legacyDbPath: string;
  v2DbPath: string;
  targetUsername: string;
  fromUserKey?: string;
  allUsers?: boolean;
}): LegacyImportResult {
  const legacyDbPath = path.resolve(options.legacyDbPath);
  if (!fs.existsSync(legacyDbPath)) {
    throw new Error(`Legacy database not found: ${legacyDbPath}`);
  }

  const v2Sqlite = new SqliteClient(options.v2DbPath);
  const userRepo = new UserRepository(v2Sqlite);
  const userStateRepo = new UserStateRepository(v2Sqlite);

  const user = userRepo.findByUsername(options.targetUsername);
  if (!user) {
    v2Sqlite.close();
    throw new Error(`Target v2 user not found: ${options.targetUsername}. Create the user in v2 first.`);
  }

  const legacyDb = new DatabaseSync(legacyDbPath, { readOnly: true });
  try {
    const searchCols = getTableColumns(legacyDb, "search_history");
    const playCols = getTableColumns(legacyDb, "play_history");

    const legacyUsers = listLegacyUsers(legacyDb);
    let selectedUserKey: string | null = null;

    if (options.allUsers) {
      selectedUserKey = null;
    } else if (options.fromUserKey) {
      if (legacyUsers.length > 0 && !legacyUsers.some((u) => u.userKey === options.fromUserKey)) {
        const available = legacyUsers.map((u) => u.userKey).join(", ");
        throw new Error(
          `Source user_key '${options.fromUserKey}' not found in legacy DB. Available: ${available}`,
        );
      }
      selectedUserKey = options.fromUserKey;
    } else if (legacyUsers.length > 1) {
      const list = legacyUsers
        .map((u) => `  - ${u.userKey} (play=${u.playCount}, search=${u.searchCount})`)
        .join("\n");
      throw new Error(
        `Multiple user_key entries found in legacy DB. Specify --from-user-key <key> (or --all-users to merge intentionally):\n${list}`,
      );
    } else if (legacyUsers.length === 1) {
      selectedUserKey = legacyUsers[0]?.userKey ?? null;
    }

    let importedSearch = 0;
    let skippedSearch = 0;
    if (searchCols.has("keyword")) {
      const searchTimeCol = searchCols.has("updated_at")
        ? "updated_at"
        : searchCols.has("created_at")
          ? "created_at"
          : null;
      const whereClause = selectedUserKey !== null && searchCols.has("user_key") ? "WHERE user_key = ?" : "";
      const orderClause = searchTimeCol ? `ORDER BY ${searchTimeCol} ASC` : "";
      const selectCols = searchTimeCol ? `keyword, ${searchTimeCol} AS ts` : "keyword, NULL AS ts";
      const stmt = legacyDb.prepare(`SELECT ${selectCols} FROM search_history ${whereClause} ${orderClause}`);
      const searchRows = (whereClause ? stmt.all(selectedUserKey) : stmt.all()) as Array<{
        keyword: string;
        ts: number | null;
      }>;

      const searchEntries: Array<{ keyword: string; updatedAt?: number }> = [];
      for (const row of searchRows) {
        if (typeof row.keyword === "string" && row.keyword.trim()) {
          searchEntries.push({
            keyword: row.keyword,
            updatedAt: typeof row.ts === "number" && row.ts > 0 ? row.ts : undefined,
          });
        } else {
          skippedSearch += 1;
        }
      }
      importedSearch = userStateRepo.importSearchHistoryBatch(user.id, searchEntries);
    }

    let importedPlay = 0;
    let skippedPlay = 0;
    if (playCols.has("song_json")) {
      const playTimeCol = playCols.has("updated_at")
        ? "updated_at"
        : playCols.has("played_at")
          ? "played_at"
          : null;
      const whereClause = selectedUserKey !== null && playCols.has("user_key") ? "WHERE user_key = ?" : "";
      const orderClause = playTimeCol ? `ORDER BY ${playTimeCol} ASC` : "";
      const selectCols = playTimeCol ? `song_json, ${playTimeCol} AS ts` : "song_json, NULL AS ts";
      const stmt = legacyDb.prepare(`SELECT ${selectCols} FROM play_history ${whereClause} ${orderClause}`);
      const playRows = (whereClause ? stmt.all(selectedUserKey) : stmt.all()) as Array<{
        song_json: string;
        ts: number | null;
      }>;

      const playEntries: Array<{ song: Song; playedAt?: number }> = [];
      for (const row of playRows) {
        try {
          const raw = JSON.parse(row.song_json) as Record<string, unknown>;
          const mapped = mapLegacySong(raw);
          if (mapped) {
            playEntries.push({
              song: mapped,
              playedAt: typeof row.ts === "number" && row.ts > 0 ? row.ts : undefined,
            });
          } else {
            skippedPlay += 1;
          }
        } catch {
          skippedPlay += 1;
        }
      }
      importedPlay = userStateRepo.importPlayHistoryBatch(user.id, playEntries);
    }

    return {
      targetUsername: user.username,
      sourceUserKey: selectedUserKey,
      importedPlay,
      skippedPlay,
      importedSearch,
      skippedSearch,
    };
  } finally {
    legacyDb.close();
    v2Sqlite.close();
  }
}

export function parseLegacyCliArgs(argv: readonly string[]): ParsedCliArgs {
  let fromUserKey: string | undefined;
  let allUsers = false;
  let listUsers = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--list-users") {
      listUsers = true;
    } else if (arg === "--all-users") {
      allUsers = true;
    } else if (arg === "--from-user-key") {
      fromUserKey = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--from-user-key=")) {
      fromUserKey = arg.slice("--from-user-key=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const defaultDb = path.resolve(process.cwd(), "../data/app.db");

  if (listUsers) {
    return {
      legacyDbPath: positional[0] ? path.resolve(positional[0]) : defaultDb,
      listUsers: true,
      allUsers: false,
    };
  }

  if (positional.length >= 2) {
    return {
      legacyDbPath: path.resolve(positional[0] ?? defaultDb),
      targetUsername: positional[1],
      fromUserKey,
      allUsers,
      listUsers: false,
    };
  }

  if (positional.length === 1) {
    const single = positional[0] ?? "";
    // Allow shorthand `import:legacy -- <v2-username>` when single arg is not a DB file path
    const looksLikeDb = single.endsWith(".db") || single.includes("/") || single.includes("\\");
    if (!looksLikeDb) {
      return {
        legacyDbPath: defaultDb,
        targetUsername: single,
        fromUserKey,
        allUsers,
        listUsers: false,
      };
    }
  }

  return {
    legacyDbPath: defaultDb,
    targetUsername: undefined,
    fromUserKey,
    allUsers,
    listUsers: false,
  };
}

/**
 * Optional read-only migration utility: imports play history & search history
 * from legacy v1 `data/app.db` into a target v2 user without modifying v1 files.
 * NOTE: Legacy plaintext platform cookies are intentionally NOT migrated — re-bind in v2 UI.
 */
function runCli(): void {
  try {
    const args = parseLegacyCliArgs(process.argv.slice(2));

    if (args.listUsers) {
      if (!fs.existsSync(args.legacyDbPath)) {
        console.error(`Legacy database not found: ${args.legacyDbPath}`);
        process.exit(1);
      }
      const legacyDb = new DatabaseSync(args.legacyDbPath, { readOnly: true });
      try {
        const users = listLegacyUsers(legacyDb);
        if (users.length === 0) {
          console.log("[import:legacy] No user_key entries found in legacy database.");
          return;
        }
        console.log(`[import:legacy] Found ${users.length} user_key entries in ${args.legacyDbPath}:`);
        for (const u of users) {
          console.log(`  - ${u.userKey} (play=${u.playCount}, search=${u.searchCount})`);
        }
      } finally {
        legacyDb.close();
      }
      return;
    }

    if (!args.targetUsername) {
      console.error(
        "Usage:\n" +
          "  npm run import:legacy -- [path-to-legacy-app.db] --list-users\n" +
          "  npm run import:legacy -- [path-to-legacy-app.db] <v2-username> [--from-user-key <key> | --all-users]",
      );
      process.exit(1);
    }

    const config = loadServerConfig();
    const result = importLegacyHistory({
      legacyDbPath: args.legacyDbPath,
      v2DbPath: config.dbPath,
      targetUsername: args.targetUsername,
      fromUserKey: args.fromUserKey,
      allUsers: args.allUsers,
    });

    console.log(
      `[import:legacy] Completed for '${result.targetUsername}' (source user_key=${result.sourceUserKey ?? "ALL"}): ` +
        `${result.importedPlay} play items (${result.skippedPlay} skipped), ` +
        `${result.importedSearch} search keywords (${result.skippedSearch} skipped).`,
    );
    console.log(
      "[import:legacy] Note: Legacy plaintext cookies were intentionally skipped. Re-bind platforms inside TrackVault v2.",
    );
  } catch (error) {
    console.error(`[import:legacy] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  runCli();
}
