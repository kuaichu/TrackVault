import fs from "node:fs";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
const databasePath = path.join(dataDir, "app.db");
const jsonStorePath = path.join(dataDir, "app-store.json");

fs.mkdirSync(dataDir, { recursive: true });

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get: (...args: unknown[]) => unknown;
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
};

type JsonStore = {
  search_history?: Record<string, string[]>;
  play_history?: Record<string, unknown[]>;
  app_settings?: Record<string, unknown>;
  player_state?: Record<string, unknown>;
  download_tasks?: Array<{
    id: string;
    user_key: string;
    task_json: unknown;
    song_json: unknown;
  }>;
};

let sqliteAvailable = false;
let database: SqliteDatabase | null = null;
let jsonStoreCache: JsonStore | null = null;

try {
  const sqliteModule = await import("node:sqlite");
  const DatabaseSync = sqliteModule.DatabaseSync as new (path: string) => SqliteDatabase;
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS search_history (
      user_key TEXT NOT NULL,
      keyword TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, keyword)
    );

    CREATE TABLE IF NOT EXISTS play_history (
      user_key TEXT NOT NULL,
      song_id TEXT NOT NULL,
      song_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, song_id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      settings_key TEXT NOT NULL PRIMARY KEY,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS player_state (
      user_key TEXT NOT NULL PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS download_tasks (
      id TEXT NOT NULL PRIMARY KEY,
      user_key TEXT NOT NULL,
      task_json TEXT NOT NULL,
      song_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_download_tasks_user_updated_at
      ON download_tasks (user_key, updated_at DESC);
  `);
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
  database = null;
}

function getDefaultJsonStore(): JsonStore {
  return {
    search_history: {},
    play_history: {},
    app_settings: {},
    player_state: {},
    download_tasks: []
  };
}

function loadJsonStore() {
  if (jsonStoreCache) {
    return jsonStoreCache;
  }

  try {
    const raw = fs.readFileSync(jsonStorePath, "utf8");
    const parsed = JSON.parse(raw) as JsonStore;
    jsonStoreCache = {
      ...getDefaultJsonStore(),
      ...parsed
    };
  } catch {
    jsonStoreCache = getDefaultJsonStore();
    fs.writeFileSync(jsonStorePath, JSON.stringify(jsonStoreCache, null, 2), "utf8");
  }

  return jsonStoreCache;
}

function persistJsonStore(store: JsonStore) {
  jsonStoreCache = store;
  fs.writeFileSync(jsonStorePath, JSON.stringify(store, null, 2), "utf8");
}

export function isSqliteAvailable() {
  return sqliteAvailable && Boolean(database);
}

export function getDatabase() {
  if (!database) {
    throw new Error("SQLite is not available in the current Node.js runtime.");
  }

  return database;
}

export function readJsonStore(): JsonStore {
  const store = loadJsonStore();
  return JSON.parse(JSON.stringify(store)) as JsonStore;
}

export function updateJsonStore(updater: (store: JsonStore) => void) {
  const store = loadJsonStore();
  updater(store);
  persistJsonStore(store);
}
