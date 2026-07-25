import assert from "node:assert/strict";
import test from "node:test";
import type { AlbumProfile, ArtistProfile } from "../types.js";
import {
  createMusicMetadataRouter,
  type MusicMetadataRouterDependencies
} from "./music-metadata-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const artist: ArtistProfile = {
  id: "artist-1",
  name: "Artist",
  description: "Artist description",
  musicCount: 1,
  albumCount: 1,
  mvCount: 0,
  topSongs: []
};

const album: AlbumProfile = {
  id: "album-1",
  name: "Album",
  description: "Album description",
  artist: "Artist",
  trackCount: 1,
  songs: []
};

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected music metadata dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<MusicMetadataRouterDependencies> = {}
): MusicMetadataRouterDependencies {
  return {
    resolveArtistIdByName: async () => unexpectedDependency("resolveArtistIdByName"),
    getArtistProfile: async () => unexpectedDependency("getArtistProfile"),
    getAlbumProfile: async () => unexpectedDependency("getAlbumProfile"),
    ...overrides
  };
}

test("artist resolution preserves string names and falls back non-strings to empty", timeout, async () => {
  const names: string[] = [];
  const dependencies = createDependencies({
    resolveArtistIdByName: async (name) => {
      names.push(name);
      return { id: `resolved-${names.length}`, name };
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const spaced = await request("/api/artists/resolve/by-name?name=%20Artist%20");
    assert.equal(spaced.status, 200);
    assert.deepEqual(spaced.body, { id: "resolved-1", name: " Artist " });

    const missing = await request("/api/artists/resolve/by-name");
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, { id: "resolved-2", name: "" });

    const repeated = await request("/api/artists/resolve/by-name?name=first&name=second");
    assert.equal(repeated.status, 200);
    assert.deepEqual(repeated.body, { id: "resolved-3", name: "" });
  });

  assert.deepEqual(names, [" Artist ", "", ""]);
});

test("artist resolution keeps Error and non-Error failures at 404", timeout, async () => {
  const dependencies = createDependencies({
    resolveArtistIdByName: async (name) => {
      throw name === "known" ? new Error("resolution failed") : "resolution failed";
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/artists/resolve/by-name?name=known");
    assert.equal(known.status, 404);
    assert.deepEqual(known.body, { message: "resolution failed" });

    const fallback = await request("/api/artists/resolve/by-name?name=unknown");
    assert.equal(fallback.status, 404);
    assert.deepEqual(fallback.body, { message: "解析歌手失败" });
  });
});

test("artist profile preserves the decoded id and wraps the successful result", timeout, async () => {
  const ids: string[] = [];
  const dependencies = createDependencies({
    getArtistProfile: async (artistId) => {
      ids.push(artistId);
      return artist;
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/artists/%20artist-1%20");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { artist });
    assert.notDeepEqual(response.body, artist);
  });

  assert.deepEqual(ids, [" artist-1 "]);
});

test("artist profile keeps Error and non-Error failures at 502", timeout, async () => {
  const dependencies = createDependencies({
    getArtistProfile: async (artistId) => {
      throw artistId === "known" ? new Error("artist failed") : "artist failed";
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/artists/known");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "artist failed" });

    const fallback = await request("/api/artists/unknown");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取歌手信息失败" });
  });
});

test("album profile preserves the decoded id and wraps the successful result", timeout, async () => {
  const ids: string[] = [];
  const dependencies = createDependencies({
    getAlbumProfile: async (albumId) => {
      ids.push(albumId);
      return album;
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/albums/%20album-1%20");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { album });
    assert.notDeepEqual(response.body, album);
  });

  assert.deepEqual(ids, [" album-1 "]);
});

test("album profile keeps Error and non-Error failures at 502", timeout, async () => {
  const dependencies = createDependencies({
    getAlbumProfile: async (albumId) => {
      throw albumId === "known" ? new Error("album failed") : "album failed";
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/albums/known");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "album failed" });

    const fallback = await request("/api/albums/unknown");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取专辑信息失败" });
  });
});

test("metadata routes match exactly and unrelated paths fall through", timeout, async () => {
  const calls = {
    resolve: 0,
    artist: 0,
    album: 0
  };
  const dependencies = createDependencies({
    resolveArtistIdByName: async (name) => {
      calls.resolve += 1;
      return { id: "resolved-1", name };
    },
    getArtistProfile: async () => {
      calls.artist += 1;
      return artist;
    },
    getAlbumProfile: async () => {
      calls.album += 1;
      return album;
    }
  });

  await withTestRouter([createMusicMetadataRouter(dependencies)], async ({ request }) => {
    const resolution = await request("/api/artists/resolve/by-name?name=Artist");
    assert.equal(resolution.status, 200);
    assert.deepEqual(resolution.body, { id: "resolved-1", name: "Artist" });

    const artistResponse = await request("/api/artists/artist-1");
    assert.equal(artistResponse.status, 200);
    assert.deepEqual(artistResponse.body, { artist });

    const albumResponse = await request("/api/albums/album-1");
    assert.equal(albumResponse.status, 200);
    assert.deepEqual(albumResponse.body, { album });

    const fallthroughRequests: Array<[string, RequestInit | undefined]> = [
      ["/api/artists/artist-1/unknown", undefined],
      ["/api/users/user-1", undefined],
      ["/api/songs/song-1/lyrics", undefined],
      ["/api/songs/song-1/comments", undefined],
      ["/api/artists/artist-1", { method: "POST" }]
    ];

    for (const [path, init] of fallthroughRequests) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });

  assert.deepEqual(calls, { resolve: 1, artist: 1, album: 1 });
});
