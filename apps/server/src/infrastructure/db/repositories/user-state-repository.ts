import {
  type PlayerState,
  PlayerStateSchema,
  type Song,
  SongSchema,
  type UpdateUserSettingsInput,
  type UserSettings,
  UserSettingsSchema,
  getSongKey,
} from "#shared";
import type { SqliteClient } from "../client.js";

const MAX_PLAY_HISTORY = 100;
const MAX_SEARCH_HISTORY = 30;

function createDefaultSettings(): UserSettings {
  return {
    providerMode: "netease",
    defaultPlaybackQuality: "exhigh",
    defaultDownloadQuality: "lossless",
    maxConcurrentDownloads: 2,
    startupView: "discover",
  };
}

function createDefaultPlayerState(): PlayerState {
  return {
    currentTrack: null,
    playQueue: [],
    playbackSeconds: 0,
    volume: 0.85,
    playbackMode: "sequential",
  };
}

export class UserStateRepository {
  readonly #sqlite: SqliteClient;

  constructor(sqlite: SqliteClient) {
    this.#sqlite = sqlite;
  }

  getSettings(userId: string): UserSettings {
    const row = this.#sqlite.db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as
      | {
          provider_mode: string;
          default_playback_quality: string;
          default_download_quality: string;
          max_concurrent_downloads: number;
          startup_view: string;
          updated_at: number;
        }
      | undefined;

    if (!row) return createDefaultSettings();

    const parsed = UserSettingsSchema.safeParse({
      providerMode: row.provider_mode,
      defaultPlaybackQuality: row.default_playback_quality,
      defaultDownloadQuality: row.default_download_quality,
      maxConcurrentDownloads: row.max_concurrent_downloads,
      startupView: row.startup_view,
      updatedAt: row.updated_at,
    });
    return parsed.success ? parsed.data : createDefaultSettings();
  }

  updateSettings(userId: string, patch: UpdateUserSettingsInput): UserSettings {
    const current = this.getSettings(userId);
    const merged = UserSettingsSchema.parse({
      ...current,
      ...patch,
      updatedAt: Date.now(),
    });

    this.#sqlite.db
      .prepare(
        `INSERT INTO user_settings (
          user_id, provider_mode, default_playback_quality, default_download_quality,
          max_concurrent_downloads, startup_view, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          provider_mode = excluded.provider_mode,
          default_playback_quality = excluded.default_playback_quality,
          default_download_quality = excluded.default_download_quality,
          max_concurrent_downloads = excluded.max_concurrent_downloads,
          startup_view = excluded.startup_view,
          updated_at = excluded.updated_at`,
      )
      .run(
        userId,
        merged.providerMode,
        merged.defaultPlaybackQuality,
        merged.defaultDownloadQuality,
        merged.maxConcurrentDownloads,
        merged.startupView,
        merged.updatedAt ?? Date.now(),
      );

    return merged;
  }

  getPlayerState(userId: string): PlayerState {
    const row = this.#sqlite.db
      .prepare("SELECT state_json FROM player_states WHERE user_id = ?")
      .get(userId) as { state_json: string } | undefined;

    if (!row) return createDefaultPlayerState();

    try {
      const parsed = PlayerStateSchema.safeParse(JSON.parse(row.state_json));
      return parsed.success ? parsed.data : createDefaultPlayerState();
    } catch {
      return createDefaultPlayerState();
    }
  }

  savePlayerState(userId: string, input: PlayerState): PlayerState {
    const sanitized = PlayerStateSchema.parse(input);
    const now = Date.now();
    this.#sqlite.db
      .prepare(
        `INSERT INTO player_states (user_id, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(userId, JSON.stringify(sanitized), now);
    return sanitized;
  }

  getPlayHistory(userId: string): Song[] {
    const rows = this.#sqlite.db
      .prepare("SELECT song_json FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?")
      .all(userId, MAX_PLAY_HISTORY) as Array<{ song_json: string }>;

    const songs: Song[] = [];
    for (const row of rows) {
      try {
        const parsed = SongSchema.safeParse(JSON.parse(row.song_json));
        if (parsed.success) songs.push(parsed.data);
      } catch {
        // Skip corrupted row without failing the whole response
      }
    }
    return songs;
  }

  recordPlayHistory(userId: string, song: Song, playedAt?: number): Song[] {
    const sanitized = SongSchema.parse(song);
    const songKey = getSongKey(sanitized);
    const now =
      typeof playedAt === "number" && Number.isFinite(playedAt) && playedAt > 0
        ? Math.floor(playedAt)
        : Date.now();

    this.#sqlite.transaction(() => {
      this.#sqlite.db
        .prepare(
          `INSERT INTO play_history (user_id, song_key, song_json, played_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, song_key) DO UPDATE SET
             song_json = excluded.song_json,
             played_at = excluded.played_at`,
        )
        .run(userId, songKey, JSON.stringify(sanitized), now);

      this.#sqlite.db
        .prepare(
          `DELETE FROM play_history
           WHERE user_id = ? AND song_key NOT IN (
             SELECT song_key FROM play_history WHERE user_id = ? ORDER BY played_at DESC LIMIT ?
           )`,
        )
        .run(userId, userId, MAX_PLAY_HISTORY);
    });

    return this.getPlayHistory(userId);
  }

  clearPlayHistory(userId: string): void {
    this.#sqlite.db.prepare("DELETE FROM play_history WHERE user_id = ?").run(userId);
  }

  getSearchHistory(userId: string): string[] {
    const rows = this.#sqlite.db
      .prepare("SELECT keyword FROM search_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(userId, MAX_SEARCH_HISTORY) as Array<{ keyword: string }>;
    return rows.map((row) => row.keyword);
  }

  addSearchHistory(userId: string, keyword: string, updatedAt?: number): string[] {
    const trimmed = keyword.trim().slice(0, 120);
    if (!trimmed) return this.getSearchHistory(userId);

    const now =
      typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
        ? Math.floor(updatedAt)
        : Date.now();
    this.#sqlite.transaction(() => {
      this.#sqlite.db
        .prepare(
          `INSERT INTO search_history (user_id, keyword, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id, keyword) DO UPDATE SET
             updated_at = excluded.updated_at`,
        )
        .run(userId, trimmed, now);

      this.#sqlite.db
        .prepare(
          `DELETE FROM search_history
           WHERE user_id = ? AND keyword NOT IN (
             SELECT keyword FROM search_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?
           )`,
        )
        .run(userId, userId, MAX_SEARCH_HISTORY);
    });

    return this.getSearchHistory(userId);
  }

  removeSearchHistory(userId: string, keyword: string): string[] {
    this.#sqlite.db
      .prepare("DELETE FROM search_history WHERE user_id = ? AND keyword = ?")
      .run(userId, keyword.trim());
    return this.getSearchHistory(userId);
  }

  clearSearchHistory(userId: string): void {
    this.#sqlite.db.prepare("DELETE FROM search_history WHERE user_id = ?").run(userId);
  }
}
