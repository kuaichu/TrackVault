import { randomUUID } from "node:crypto";
import {
  getDatabase,
  isSqliteAvailable,
  readJsonStore,
  updateJsonStore,
  type JsonCloudVirtualPlaylistScope
} from "./database.js";

export const CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION = 1 as const;
const CLOUD_SONG_KEY_PREFIX = "netease-cloud:";
const MAX_PLAYLIST_NAME_LENGTH = 80;
const MAX_SONG_ID_LENGTH = 160;

export type CloudVirtualPlaylist = {
  id: string;
  name: string;
};

export type CloudVirtualPlaylistState = {
  version: typeof CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION;
  playlists: CloudVirtualPlaylist[];
  assignments: Record<string, string>;
};

export class CloudVirtualPlaylistValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudVirtualPlaylistValidationError";
  }
}

export class CloudVirtualPlaylistNotFoundError extends Error {
  constructor() {
    super("云盘虚拟歌单不存在。");
    this.name = "CloudVirtualPlaylistNotFoundError";
  }
}

function emptyState(): CloudVirtualPlaylistState {
  return {
    version: CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION,
    playlists: [],
    assignments: {}
  };
}

function normalizeDataScopeId(dataScopeId: string) {
  if (typeof dataScopeId !== "string" || !dataScopeId.trim()) {
    throw new CloudVirtualPlaylistValidationError("缺少有效的账号数据作用域。");
  }

  return dataScopeId.trim();
}

function normalizePlaylistId(playlistId: string) {
  if (typeof playlistId !== "string" || !playlistId.trim() || playlistId.length > 160) {
    throw new CloudVirtualPlaylistValidationError("歌单引用无效。");
  }

  return playlistId.trim();
}

export function normalizeCloudVirtualPlaylistName(value: unknown) {
  if (typeof value !== "string") {
    throw new CloudVirtualPlaylistValidationError("歌单名称必须是文本。");
  }

  const name = value.trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
  if (!name) {
    throw new CloudVirtualPlaylistValidationError("歌单名称不能为空。");
  }
  if (name.length > MAX_PLAYLIST_NAME_LENGTH) {
    throw new CloudVirtualPlaylistValidationError(`歌单名称不能超过 ${MAX_PLAYLIST_NAME_LENGTH} 个字符。`);
  }

  return name;
}

export function normalizeCloudSongKey(songId: unknown) {
  if (typeof songId !== "string") {
    throw new CloudVirtualPlaylistValidationError("云盘歌曲 ID 必须是文本。");
  }

  const normalizedSongId = songId.trim();
  if (!normalizedSongId || normalizedSongId.length > MAX_SONG_ID_LENGTH || !/^[a-zA-Z0-9._:-]+$/.test(normalizedSongId)) {
    throw new CloudVirtualPlaylistValidationError("云盘歌曲引用无效。");
  }

  return `${CLOUD_SONG_KEY_PREFIX}${normalizedSongId}`;
}

function normalizeStoredState(value: unknown): CloudVirtualPlaylistState {
  const raw = value as Partial<JsonCloudVirtualPlaylistScope> | null;
  if (raw?.version !== CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION) {
    return emptyState();
  }

  const playlists = Array.isArray(raw?.playlists)
    ? raw.playlists
        .filter((playlist): playlist is { id: string; name: string } =>
          typeof playlist?.id === "string" && typeof playlist.name === "string"
        )
        .map((playlist) => ({ id: playlist.id.trim(), name: playlist.name.trim() }))
        .filter((playlist) => playlist.id && playlist.name)
    : [];
  const playlistIds = new Set(playlists.map((playlist) => playlist.id));
  const assignments = Object.fromEntries(
    Object.entries(raw?.assignments ?? {}).filter(([songKey, playlistId]) =>
      songKey.startsWith(CLOUD_SONG_KEY_PREFIX) && typeof playlistId === "string" && playlistIds.has(playlistId)
    )
  );

  return {
    version: CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION,
    playlists,
    assignments
  };
}

function getJsonScopeState(dataScopeId: string) {
  const store = readJsonStore();
  const layout = store.cloud_virtual_playlists;
  if (!layout || layout.version !== CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION || !layout.scopes) {
    return emptyState();
  }

  return normalizeStoredState(layout.scopes[dataScopeId]);
}

function updateJsonScopeState(dataScopeId: string, nextState: CloudVirtualPlaylistState) {
  updateJsonStore((store) => {
    if (!store.cloud_virtual_playlists || store.cloud_virtual_playlists.version !== CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION) {
      store.cloud_virtual_playlists = {
        version: CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION,
        scopes: {}
      };
    }

    store.cloud_virtual_playlists.scopes[dataScopeId] = {
      version: CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION,
      playlists: nextState.playlists,
      assignments: nextState.assignments
    };
  });
}

function getSqliteState(dataScopeId: string) {
  const database = getDatabase();
  const playlistRows = database.prepare(`
    SELECT playlist_id, name
    FROM cloud_virtual_playlists
    WHERE data_scope_id = ?
    ORDER BY created_at ASC, playlist_id ASC
  `).all(dataScopeId) as Array<{ playlist_id?: unknown; name?: unknown }>;
  const playlists = playlistRows
    .filter((row) => typeof row.playlist_id === "string" && typeof row.name === "string")
    .map((row) => ({ id: String(row.playlist_id), name: String(row.name) }));
  const playlistIds = new Set(playlists.map((playlist) => playlist.id));
  const assignmentRows = database.prepare(`
    SELECT song_key, playlist_id
    FROM cloud_virtual_assignments
    WHERE data_scope_id = ?
  `).all(dataScopeId) as Array<{ song_key?: unknown; playlist_id?: unknown }>;
  const assignments = Object.fromEntries(
    assignmentRows.filter((row) =>
      typeof row.song_key === "string" && row.song_key.startsWith(CLOUD_SONG_KEY_PREFIX) && typeof row.playlist_id === "string" && playlistIds.has(row.playlist_id)
    ).map((row) => [String(row.song_key), String(row.playlist_id)])
  );

  return {
    version: CLOUD_VIRTUAL_PLAYLIST_LAYOUT_VERSION,
    playlists,
    assignments
  } satisfies CloudVirtualPlaylistState;
}

function findPlaylist(state: CloudVirtualPlaylistState, playlistId: string) {
  const normalizedId = normalizePlaylistId(playlistId);
  const playlist = state.playlists.find((item) => item.id === normalizedId);
  if (!playlist) {
    throw new CloudVirtualPlaylistNotFoundError();
  }

  return playlist;
}

export function getCloudVirtualPlaylistState(dataScopeId: string): CloudVirtualPlaylistState {
  const normalizedScope = normalizeDataScopeId(dataScopeId);
  return isSqliteAvailable() ? getSqliteState(normalizedScope) : getJsonScopeState(normalizedScope);
}

export function createCloudVirtualPlaylist(name: unknown, dataScopeId: string) {
  const normalizedScope = normalizeDataScopeId(dataScopeId);
  const playlist = {
    id: randomUUID(),
    name: normalizeCloudVirtualPlaylistName(name)
  } satisfies CloudVirtualPlaylist;

  if (!isSqliteAvailable()) {
    const state = getJsonScopeState(normalizedScope);
    updateJsonScopeState(normalizedScope, {
      ...state,
      playlists: [...state.playlists, playlist]
    });
    return playlist;
  }

  const now = Date.now();
  getDatabase().prepare(`
    INSERT INTO cloud_virtual_playlists (data_scope_id, playlist_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(normalizedScope, playlist.id, playlist.name, now, now);
  return playlist;
}

export function renameCloudVirtualPlaylist(playlistId: string, name: unknown, dataScopeId: string) {
  const normalizedScope = normalizeDataScopeId(dataScopeId);
  const normalizedName = normalizeCloudVirtualPlaylistName(name);
  const state = getCloudVirtualPlaylistState(normalizedScope);
  const playlist = findPlaylist(state, playlistId);
  const nextPlaylist = { ...playlist, name: normalizedName };

  if (!isSqliteAvailable()) {
    updateJsonScopeState(normalizedScope, {
      ...state,
      playlists: state.playlists.map((item) => item.id === playlist.id ? nextPlaylist : item)
    });
    return nextPlaylist;
  }

  getDatabase().prepare(`
    UPDATE cloud_virtual_playlists
    SET name = ?, updated_at = ?
    WHERE data_scope_id = ? AND playlist_id = ?
  `).run(normalizedName, Date.now(), normalizedScope, playlist.id);
  return nextPlaylist;
}

export function deleteCloudVirtualPlaylist(playlistId: string, dataScopeId: string) {
  const normalizedScope = normalizeDataScopeId(dataScopeId);
  const state = getCloudVirtualPlaylistState(normalizedScope);
  const playlist = findPlaylist(state, playlistId);

  if (!isSqliteAvailable()) {
    const assignments = Object.fromEntries(
      Object.entries(state.assignments).filter(([, assignedPlaylistId]) => assignedPlaylistId !== playlist.id)
    );
    updateJsonScopeState(normalizedScope, {
      ...state,
      playlists: state.playlists.filter((item) => item.id !== playlist.id),
      assignments
    });
    return { deletedPlaylistId: playlist.id };
  }

  const database = getDatabase();
  database.exec("BEGIN");
  try {
    database.prepare("DELETE FROM cloud_virtual_assignments WHERE data_scope_id = ? AND playlist_id = ?").run(normalizedScope, playlist.id);
    database.prepare("DELETE FROM cloud_virtual_playlists WHERE data_scope_id = ? AND playlist_id = ?").run(normalizedScope, playlist.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return { deletedPlaylistId: playlist.id };
}

export function moveCloudVirtualPlaylistSongs(songIds: unknown, playlistId: unknown, dataScopeId: string) {
  const normalizedScope = normalizeDataScopeId(dataScopeId);
  if (!Array.isArray(songIds) || songIds.length === 0) {
    throw new CloudVirtualPlaylistValidationError("至少选择一首云盘歌曲。");
  }

  const songKeys = [...new Set(songIds.map((songId) => normalizeCloudSongKey(songId)))];
  const targetPlaylistId = playlistId === null ? null : normalizePlaylistId(playlistId as string);
  if (targetPlaylistId) {
    findPlaylist(getCloudVirtualPlaylistState(normalizedScope), targetPlaylistId);
  }

  if (!isSqliteAvailable()) {
    const state = getCloudVirtualPlaylistState(normalizedScope);
    const assignments = { ...state.assignments };
    for (const songKey of songKeys) {
      if (targetPlaylistId) {
        assignments[songKey] = targetPlaylistId;
      } else {
        delete assignments[songKey];
      }
    }
    updateJsonScopeState(normalizedScope, {
      ...state,
      assignments
    });
    return getCloudVirtualPlaylistState(normalizedScope);
  }

  const database = getDatabase();
  const deleteStatement = database.prepare(`
    DELETE FROM cloud_virtual_assignments
    WHERE data_scope_id = ? AND song_key = ?
  `);
  const insertStatement = database.prepare(`
    INSERT INTO cloud_virtual_assignments (data_scope_id, song_key, playlist_id, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    for (const songKey of songKeys) {
      deleteStatement.run(normalizedScope, songKey);
      if (targetPlaylistId) {
        insertStatement.run(normalizedScope, songKey, targetPlaylistId, Date.now());
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return getCloudVirtualPlaylistState(normalizedScope);
}
