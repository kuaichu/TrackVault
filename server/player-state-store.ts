import { getCurrentUserKey } from "./account-store.js";
import { getDatabase, isSqliteAvailable, readJsonStore, updateJsonStore } from "./database.js";
import type { PersistedPlayerState, Song } from "./types.js";

const defaultPlayerState: PersistedPlayerState = {
  currentTrack: null,
  playQueue: [],
  playbackSeconds: 0,
  volume: 72,
  playbackMode: "sequential"
};

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

function normalizePlayerState(input: Partial<PersistedPlayerState>): PersistedPlayerState {
  const playQueue = Array.isArray(input.playQueue)
    ? input.playQueue.filter((song): song is Song => Boolean(song?.id && song?.title && song?.artist)).slice(0, 200).map(normalizeSong)
    : [];

  const currentTrack =
    input.currentTrack && input.currentTrack.id && input.currentTrack.title && input.currentTrack.artist
      ? normalizeSong(input.currentTrack)
      : null;

  return {
    currentTrack,
    playQueue,
    playbackSeconds: Number.isFinite(input.playbackSeconds) ? Math.max(0, Number(input.playbackSeconds)) : 0,
    volume: Number.isFinite(input.volume) ? Math.min(100, Math.max(0, Math.round(Number(input.volume)))) : 72,
    playbackMode: input.playbackMode === "shuffle" ? "shuffle" : "sequential"
  };
}

export async function getPlayerState() {
  const userKey = await getCurrentUserKey();

  if (!isSqliteAvailable()) {
    const row = readJsonStore().player_state?.[userKey] as Partial<PersistedPlayerState> | undefined;
    if (!row) {
      return defaultPlayerState;
    }

    return normalizePlayerState(row);
  }

  const database = getDatabase();
  const statement = database.prepare(`
    SELECT state_json
    FROM player_state
    WHERE user_key = ?
  `);
  const row = statement.get(userKey) as { state_json: string } | undefined;

  if (!row) {
    return defaultPlayerState;
  }

  return normalizePlayerState(JSON.parse(row.state_json) as Partial<PersistedPlayerState>);
}

export async function savePlayerState(input: PersistedPlayerState) {
  const userKey = await getCurrentUserKey();
  const nextState = normalizePlayerState(input);

  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.player_state ??= {};
      store.player_state[userKey] = nextState;
    });
    return nextState;
  }

  const database = getDatabase();
  const statement = database.prepare(`
    INSERT INTO player_state (user_key, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_key) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  statement.run(userKey, JSON.stringify(nextState), Date.now());
  return nextState;
}
