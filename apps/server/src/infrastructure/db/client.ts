import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "init_schema",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        trusted_fallback INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS platform_credentials (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq')),
        encrypted_cookie TEXT NOT NULL,
        account_uid TEXT,
        display_name TEXT,
        avatar_url TEXT,
        vip_enabled INTEGER NOT NULL DEFAULT 0,
        vip_expire_at INTEGER,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, platform)
      );

      CREATE TABLE IF NOT EXISTS system_fallback_credentials (
        platform TEXT PRIMARY KEY CHECK (platform IN ('netease', 'qq')),
        encrypted_cookie TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        provider_mode TEXT NOT NULL DEFAULT 'netease',
        default_playback_quality TEXT NOT NULL DEFAULT 'exhigh',
        default_download_quality TEXT NOT NULL DEFAULT 'lossless',
        max_concurrent_downloads INTEGER NOT NULL DEFAULT 2,
        startup_view TEXT NOT NULL DEFAULT 'discover',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS player_states (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS play_history (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        song_key TEXT NOT NULL,
        song_json TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, song_key)
      );
      CREATE INDEX IF NOT EXISTS idx_play_history_user_time ON play_history(user_id, played_at DESC);

      CREATE TABLE IF NOT EXISTS search_history (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, keyword)
      );
      CREATE INDEX IF NOT EXISTS idx_search_history_user_time ON search_history(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('download', 'transfer', 'import_audit', 'compare')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        progress INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        subtitle TEXT,
        metadata_json TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        artifact_filename TEXT,
        direct_url TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_user_kind_updated ON background_jobs(user_id, kind, updated_at DESC);
    `,
  },
];

export class SqliteClient {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.#runMigrations();
  }

  #runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const appliedRows = this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  immediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
