import assert from "node:assert/strict";
import test from "node:test";
import type { CloudVirtualPlaylistState } from "../cloud-virtual-playlist-store.js";
import {
  createCloudVirtualPlaylistRouter,
  type CloudVirtualPlaylistRouterDependencies
} from "./cloud-virtual-playlist-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };
const scopeHeader = { "x-data-scope-id": "account:netease:1" };

function createState(): CloudVirtualPlaylistState {
  return {
    version: 1,
    playlists: [{ id: "playlist-a", name: "通勤" }],
    assignments: {}
  };
}

function jsonRequest(request: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>, method: string, path: string, body: unknown, headers: HeadersInit = {}) {
  return request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

test("virtual playlist routes validate server scope and keep all mutations local", timeout, async () => {
  let currentScope = "account:netease:1";
  let state = createState();
  const seenScopes: string[] = [];
  let deleteCalls = 0;
  const dependencies: CloudVirtualPlaylistRouterDependencies = {
    getDataScopeId: async () => currentScope,
    getState: (scope) => {
      seenScopes.push(scope);
      return state;
    },
    createPlaylist: (name, scope) => {
      seenScopes.push(scope);
      const playlist = { id: "playlist-b", name: String(name) };
      state = { ...state, playlists: [...state.playlists, playlist] };
      return playlist;
    },
    renamePlaylist: (playlistId, name, scope) => {
      seenScopes.push(scope);
      const playlist = { id: playlistId, name: String(name) };
      state = { ...state, playlists: state.playlists.map((item) => item.id === playlistId ? playlist : item) };
      return playlist;
    },
    deletePlaylist: (playlistId, scope) => {
      seenScopes.push(scope);
      deleteCalls += 1;
      state = {
        ...state,
        playlists: state.playlists.filter((playlist) => playlist.id !== playlistId),
        assignments: Object.fromEntries(Object.entries(state.assignments).filter(([, assignedId]) => assignedId !== playlistId))
      };
      return { deletedPlaylistId: playlistId };
    },
    moveSongs: (songIds, playlistId, scope) => {
      seenScopes.push(scope);
      const assignments = { ...state.assignments };
      for (const songId of songIds as string[]) {
        if (playlistId === null) {
          delete assignments[`netease-cloud:${songId}`];
        } else {
          assignments[`netease-cloud:${songId}`] = String(playlistId);
        }
      }
      state = { ...state, assignments };
      return state;
    }
  };

  await withTestRouter([createCloudVirtualPlaylistRouter(dependencies)], async ({ request }) => {
    const missingHeader = await request("/api/cloud/virtual-playlists");
    assert.equal(missingHeader.status, 409);

    const first = await request("/api/cloud/virtual-playlists", { headers: scopeHeader });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, createState());

    const created = await jsonRequest(request, "POST", "/api/cloud/virtual-playlists", { name: "夜间", owner: "forged-owner" }, scopeHeader);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { playlist: { id: "playlist-b", name: "夜间" } });

    const moved = await jsonRequest(request, "PATCH", "/api/cloud/virtual-playlists/assignments", { songIds: ["101", "102"], playlistId: "playlist-a", owner: "forged-owner" }, scopeHeader);
    assert.equal(moved.status, 200);
    assert.deepEqual((moved.body as CloudVirtualPlaylistState).assignments, {
      "netease-cloud:101": "playlist-a",
      "netease-cloud:102": "playlist-a"
    });

    const unclassified = await jsonRequest(request, "PATCH", "/api/cloud/virtual-playlists/assignments", { songIds: ["101"], playlistId: null }, scopeHeader);
    assert.equal(unclassified.status, 200);
    assert.deepEqual((unclassified.body as CloudVirtualPlaylistState).assignments, {
      "netease-cloud:102": "playlist-a"
    });

    const renamed = await jsonRequest(request, "PATCH", "/api/cloud/virtual-playlists/playlist-a", { name: "晚间" }, scopeHeader);
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.body, { playlist: { id: "playlist-a", name: "晚间" } });

    const deleted = await request("/api/cloud/virtual-playlists/playlist-a", { method: "DELETE", headers: scopeHeader });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { deletedPlaylistId: "playlist-a" });

    currentScope = "account:netease:2";
    const stale = await request("/api/cloud/virtual-playlists", { headers: scopeHeader });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { message: "账号数据作用域已变化，请重试。" });
  });

  assert.equal(deleteCalls, 1);
  assert.ok(seenScopes.every((scope) => scope === "account:netease:1"));
});
