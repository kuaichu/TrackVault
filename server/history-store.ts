import { getCurrentUserKey } from "./account-store.js";
import { getDatabase, isSqliteAvailable, readJsonStore, updateJsonStore } from "./database.js";
import type { Song } from "./types.js";

const SEARCH_HISTORY_LIMIT = 10;
const PLAY_HISTORY_LIMIT = 30;

function normalizeSong(song: Song): Song {
  return {
    ...song,
    title: song.title.trim(),
    artist: song.artist.trim(),
    album: song.album.trim(),
    artists: Array.isArray(song.artists)
      ? song.artists
          .map((artist) => ({
            id: artist.id?.trim() || undefined,
            name: artist.name.trim()
          }))
          .filter((artist) => artist.name)
      : undefined
  };
}

export async function getSearchHistory() {
  const userKey = await getCurrentUserKey();

  if (!isSqliteAvailable()) {
    const store = readJsonStore();
    return (store.search_history?.[userKey] ?? []).slice(0, SEARCH_HISTORY_LIMIT);
  }

  const database = getDatabase();
  const statement = database.prepare(`
    SELECT keyword
    FROM search_history
    WHERE user_key = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `);

  return statement.all(userKey, SEARCH_HISTORY_LIMIT).map((row) => String((row as { keyword: string }).keyword));
}

export async function saveSearchHistory(items: string[]) {
  const userKey = await getCurrentUserKey();
  const nextItems = [...new Set(items.map((item) => item.trim()).filter(Boolean))].slice(0, SEARCH_HISTORY_LIMIT);

  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.search_history ??= {};
      store.search_history[userKey] = nextItems;
    });
    return nextItems;
  }

  const database = getDatabase();
  const deleteStatement = database.prepare("DELETE FROM search_history WHERE user_key = ?");
  const insertStatement = database.prepare(`
    INSERT INTO search_history (user_key, keyword, updated_at)
    VALUES (?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    deleteStatement.run(userKey);
    nextItems.forEach((keyword, index) => {
      insertStatement.run(userKey, keyword, Date.now() - index);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return nextItems;
}

export async function removeSearchHistory(keyword: string) {
  const userKey = await getCurrentUserKey();

  if (!isSqliteAvailable()) {
    const nextItems = (readJsonStore().search_history?.[userKey] ?? []).filter((item) => item !== keyword.trim());
    updateJsonStore((store) => {
      store.search_history ??= {};
      store.search_history[userKey] = nextItems;
    });
    return nextItems;
  }

  const database = getDatabase();
  const deleteStatement = database.prepare(`
    DELETE FROM search_history
    WHERE user_key = ? AND keyword = ?
  `);

  deleteStatement.run(userKey, keyword.trim());
  return getSearchHistory();
}

export async function getPlayHistory() {
  const userKey = await getCurrentUserKey();

  if (!isSqliteAvailable()) {
    const store = readJsonStore();
    return ((store.play_history?.[userKey] ?? []) as Song[]).slice(0, PLAY_HISTORY_LIMIT);
  }

  const database = getDatabase();
  const statement = database.prepare(`
    SELECT song_json
    FROM play_history
    WHERE user_key = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `);

  return statement
    .all(userKey, PLAY_HISTORY_LIMIT)
    .map((row) => JSON.parse(String((row as { song_json: string }).song_json)) as Song);
}

export async function savePlayHistory(items: Song[]) {
  const userKey = await getCurrentUserKey();
  const uniqueSongs = new Map<string, Song>();

  for (const song of items) {
    if (!song?.id || !song.title || !song.artist) {
      continue;
    }

    uniqueSongs.set(song.id, normalizeSong(song));
    if (uniqueSongs.size >= PLAY_HISTORY_LIMIT) {
      break;
    }
  }

  const nextItems = [...uniqueSongs.values()];

  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.play_history ??= {};
      store.play_history[userKey] = nextItems;
    });
    return nextItems;
  }

  const database = getDatabase();
  const deleteStatement = database.prepare("DELETE FROM play_history WHERE user_key = ?");
  const insertStatement = database.prepare(`
    INSERT INTO play_history (user_key, song_id, song_json, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    deleteStatement.run(userKey);
    nextItems.forEach((song, index) => {
      insertStatement.run(userKey, song.id, JSON.stringify(song), Date.now() - index);
    });
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return nextItems;
}
