import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const timeout = { timeout: 30_000 };
const dataScopeId = "account:netease:persistence-test";
const otherDataScopeId = "account:qqmusic:other-scope";

const childScript = `
import { createCloudVirtualPlaylist, getCloudVirtualPlaylistState, moveCloudVirtualPlaylistSongs } from "./server/cloud-virtual-playlist-store.ts";

const mode = process.env.TRACKVAULT_PERSISTENCE_MODE;
if (mode === "write") {
  const playlist = createCloudVirtualPlaylist("持久化歌单", "${dataScopeId}");
  moveCloudVirtualPlaylistSongs(["101", "999"], playlist.id, "${dataScopeId}");
  console.log(playlist.id);
} else if (mode === "read") {
  const state = getCloudVirtualPlaylistState("${dataScopeId}");
  const otherState = getCloudVirtualPlaylistState("${otherDataScopeId}");
  if (state.playlists.length !== 1 || state.playlists[0].name !== "持久化歌单") {
    throw new Error("playlist did not survive the process boundary");
  }
  const playlistId = state.playlists[0].id;
  if (state.assignments["netease-cloud:101"] !== playlistId || state.assignments["netease-cloud:999"] !== playlistId) {
    throw new Error("assignments did not survive the process boundary");
  }
  if (otherState.playlists.length !== 0 || Object.keys(otherState.assignments).length !== 0) {
    throw new Error("data scopes are not isolated");
  }
} else {
  throw new Error("unknown persistence test mode");
}
`;

function runPersistenceChild(dataDir: string, mode: "write" | "read", disableSqlite: boolean) {
  const environment = {
    ...process.env,
    TRACKVAULT_DATA_DIR: dataDir,
    TRACKVAULT_PERSISTENCE_MODE: mode
  };
  if (disableSqlite) {
    environment.TRACKVAULT_DISABLE_SQLITE = "1";
  } else {
    delete environment.TRACKVAULT_DISABLE_SQLITE;
  }

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childScript],
    {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("cloud virtual playlist state survives a process restart in SQLite and JSON fallback", timeout, () => {
  for (const mode of ["sqlite", "json"] as const) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), `trackvault-cloud-playlist-${mode}-`));
    try {
      const playlistId = runPersistenceChild(dataDir, "write", mode === "json");
      assert.match(playlistId, /^[0-9a-f-]{36}$/);

      if (mode === "json") {
        const rawStore = JSON.parse(readFileSync(path.join(dataDir, "app-store.json"), "utf8")) as {
          cloud_virtual_playlists?: {
            version?: number;
            scopes?: Record<string, { playlists?: Array<Record<string, unknown>>; assignments?: Record<string, string> }>;
          };
        };
        const scopeState = rawStore.cloud_virtual_playlists?.scopes?.[dataScopeId];
        assert.equal(rawStore.cloud_virtual_playlists?.version, 1);
        assert.deepEqual(Object.keys(scopeState?.playlists?.[0] ?? {}).sort(), ["id", "name"]);
        assert.deepEqual(scopeState?.assignments, {
          "netease-cloud:101": playlistId,
          "netease-cloud:999": playlistId
        });
      }

      runPersistenceChild(dataDir, "read", mode === "json");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
