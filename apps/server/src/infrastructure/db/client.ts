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
  {
    version: 2,
    name: "p1_revisions_and_job_columns",
    sql: `
      ALTER TABLE background_jobs ADD COLUMN artifact_expired INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE background_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS user_revisions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        job_revision INTEGER NOT NULL DEFAULT 0,
        job_cleared_before_revision INTEGER NOT NULL DEFAULT 0,
        download_cleared_before_revision INTEGER NOT NULL DEFAULT 0,
        transfer_cleared_before_revision INTEGER NOT NULL DEFAULT 0,
        import_audit_cleared_before_revision INTEGER NOT NULL DEFAULT 0,
        compare_cleared_before_revision INTEGER NOT NULL DEFAULT 0,
        history_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lower_username ON users(lower(username));
    `,
  },
  {
    version: 3,
    name: "add_kugou_platform_credentials",
    sql: `
      CREATE TABLE platform_credentials_v3 (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        platform TEXT NOT NULL CHECK (platform IN ('netease', 'qq', 'kugou')),
        encrypted_cookie TEXT NOT NULL,
        account_uid TEXT,
        display_name TEXT,
        avatar_url TEXT,
        vip_enabled INTEGER NOT NULL DEFAULT 0,
        vip_expire_at INTEGER,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, platform)
      );
      INSERT INTO platform_credentials_v3 (
        user_id, platform, encrypted_cookie, account_uid, display_name, avatar_url,
        vip_enabled, vip_expire_at, verified_at
      )
      SELECT
        user_id, platform, encrypted_cookie, account_uid, display_name, avatar_url,
        vip_enabled, vip_expire_at, verified_at
      FROM platform_credentials;
      DROP TABLE platform_credentials;
      ALTER TABLE platform_credentials_v3 RENAME TO platform_credentials;

      CREATE TABLE system_fallback_credentials_v3 (
        platform TEXT PRIMARY KEY CHECK (platform IN ('netease', 'qq', 'kugou')),
        encrypted_cookie TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO system_fallback_credentials_v3 (platform, encrypted_cookie, enabled, updated_at)
      SELECT platform, encrypted_cookie, enabled, updated_at
      FROM system_fallback_credentials;
      DROP TABLE system_fallback_credentials;
      ALTER TABLE system_fallback_credentials_v3 RENAME TO system_fallback_credentials;
    `,
  },
];

export type SqliteJournalMode = "WAL" | "TRUNCATE" | "DELETE";

const ALLOWED_JOURNAL_MODES = new Set<SqliteJournalMode>(["WAL", "TRUNCATE", "DELETE"]);

export class SqliteClient {
  readonly db: DatabaseSync;
  #txDepth = 0;

  constructor(dbPath: string, options?: { journalMode?: SqliteJournalMode }) {
    const journalMode: SqliteJournalMode = options?.journalMode ?? "WAL";
    if (!ALLOWED_JOURNAL_MODES.has(journalMode)) {
      throw new Error(`Unsupported SQLite journal_mode: ${String(journalMode)}`);
    }
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = ${journalMode};
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
    return this.#runInTransaction("DEFERRED", fn);
  }

  immediateTransaction<T>(fn: () => T): T {
    return this.#runInTransaction("IMMEDIATE", fn);
  }

  #runInTransaction<T>(mode: "DEFERRED" | "IMMEDIATE", fn: () => T): T {
    if (this.#txDepth === 0) {
      this.db.exec(mode === "IMMEDIATE" ? "BEGIN IMMEDIATE" : "BEGIN");
      this.#txDepth = 1;
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Ignore rollback error if transaction was already closed
        }
        throw error;
      } finally {
        this.#txDepth = 0;
      }
    }

    const spName = `sp_${this.#txDepth}`;
    this.db.exec(`SAVEPOINT ${spName}`);
    this.#txDepth += 1;
    try {
      const result = fn();
      this.db.exec(`RELEASE SAVEPOINT ${spName}`);
      return result;
    } catch (error) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
        this.db.exec(`RELEASE SAVEPOINT ${spName}`);
      } catch {
        // Ignore savepoint rollback error
      }
      throw error;
    } finally {
      this.#txDepth -= 1;
    }
  }

  close(): void {
    this.db.close();
  }
}
