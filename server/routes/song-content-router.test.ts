import assert from "node:assert/strict";
import test from "node:test";
import type {
  DownloadQualityLevel,
  Song,
  SongAudioProbe,
  SongAudioProbeMode,
  SongInsight,
  SongLyrics
} from "../types.js";
import {
  createSongContentRouter,
  type SongContentRouterDependencies
} from "./song-content-router.js";
import { withTestRouter } from "./router-test-http.js";

const timeout = { timeout: 5_000 };

const song: Song = {
  id: "song-1",
  providerSongId: "provider-song-1",
  title: "Track",
  artist: "Artist",
  primaryArtistId: "artist-1",
  artists: [{ id: "artist-1", name: "Artist" }],
  album: "Album",
  albumId: "album-1",
  mediaId: "media-1",
  coverUrl: "https://example.test/cover.jpg",
  duration: "03:00",
  quality: "无损",
  availableQualities: [{ level: "lossless", label: "无损" }],
  source: "netease"
};

const lyrics: SongLyrics = {
  songId: song.id,
  lines: [{ time: 1.25, text: "Line", translation: "译文" }],
  source: "lyric_new"
};

const probe: SongAudioProbe = {
  songId: song.id,
  mode: "playback",
  requestedLevel: "standard",
  requestedLabel: "标准",
  actualLabel: "标准",
  actualLevel: "standard",
  actualBitrate: 128000,
  actualType: "mp3",
  actualDuration: "03:00",
  trial: false
};

const insight: SongInsight = {
  songId: song.id,
  listening: { playCount: 12, playCountText: "12次" },
  encyclopedia: { tags: [{ label: "风格", values: ["流行"] }] }
};

class FakeMediaAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function unexpectedDependency(name: string): never {
  throw new Error(`Unexpected song content dependency call: ${name}`);
}

function createDependencies(
  overrides: Partial<SongContentRouterDependencies> = {}
): SongContentRouterDependencies {
  return {
    getSongLyrics: async () => unexpectedDependency("getSongLyrics"),
    getQqSongLyrics: async () => unexpectedDependency("getQqSongLyrics"),
    isQqMusicSong: () => unexpectedDependency("isQqMusicSong"),
    probeQqSongAudio: async () => unexpectedDependency("probeQqSongAudio"),
    probeSongAudio: async () => unexpectedDependency("probeSongAudio"),
    getNeteaseSongInsight: async () => unexpectedDependency("getNeteaseSongInsight"),
    isSongLiked: async () => unexpectedDependency("isSongLiked"),
    toggleSongLike: async () => unexpectedDependency("toggleSongLike"),
    isMediaAccessError: (error): error is FakeMediaAccessError => error instanceof FakeMediaAccessError,
    ...overrides
  };
}

test("lyrics selects QQ only for exact qqmusic and forwards mediaId without trimming", timeout, async () => {
  const calls: Array<[string, string | undefined]> = [];
  const dependencies = createDependencies({
    getQqSongLyrics: async (songId, mediaId) => {
      calls.push([songId, mediaId]);
      return { ...lyrics, songId, source: "qqmusic" };
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const withMediaId = await request("/api/lyrics/qq-song?source=qqmusic&mediaId=%20mid%20");
    assert.equal(withMediaId.status, 200);
    assert.deepEqual(withMediaId.body, {
      lyrics: { ...lyrics, songId: "qq-song", source: "qqmusic" }
    });

    const withoutMediaId = await request("/api/lyrics/qq-song-2?source=qqmusic");
    assert.equal(withoutMediaId.status, 200);
  });

  assert.deepEqual(calls, [
    ["qq-song", " mid "],
    ["qq-song-2", undefined]
  ]);
});

test("lyrics sends every non-exact or non-string source to the Netease provider", timeout, async () => {
  const calls: string[] = [];
  const dependencies = createDependencies({
    getSongLyrics: async (songId) => {
      calls.push(songId);
      return { ...lyrics, songId };
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const paths = [
      "/api/lyrics/missing",
      "/api/lyrics/qq?source=qq",
      "/api/lyrics/unknown?source=unknown",
      "/api/lyrics/spaced?source=%20qqmusic%20",
      "/api/lyrics/repeated?source=qqmusic&source=other"
    ];

    for (const path of paths) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { lyrics: { ...lyrics, songId: path.split(/[/?]/)[3] } });
    }
  });

  assert.deepEqual(calls, ["missing", "qq", "unknown", "spaced", "repeated"]);
});

test("lyrics preserves Error messages and the non-Error 502 fallback", timeout, async () => {
  const dependencies = createDependencies({
    getSongLyrics: async (songId) => {
      throw songId === "known" ? new Error("lyrics unavailable") : "lyrics unavailable";
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/lyrics/known");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "lyrics unavailable" });

    const fallback = await request("/api/lyrics/unknown");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取歌词失败" });
  });
});

test("audio probe rejects a missing song or each required field before dispatch", timeout, async () => {
  const dependencies = createDependencies();
  const bodies = [
    {},
    { song: { ...song, id: "" } },
    { song: { ...song, title: "" } },
    { song: { ...song, artist: "" } }
  ];

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    for (const body of bodies) {
      const response = await requestJson("POST", "/api/songs/audio-probe", body);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { message: "缺少歌曲信息" });
    }
  });
});

test("Netease audio probe defaults level and mode, forwards cookie, and preserves the full Song", timeout, async () => {
  const dispatchCalls: Song[] = [];
  const probeCalls: Array<[Song, DownloadQualityLevel, SongAudioProbeMode, string | undefined]> = [];
  const dependencies = createDependencies({
    isQqMusicSong: (receivedSong) => {
      dispatchCalls.push(receivedSong as Song);
      return false;
    },
    probeSongAudio: async (receivedSong, level, mode, userCookieOverride) => {
      probeCalls.push([receivedSong, level, mode, userCookieOverride]);
      return probe;
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      "/api/songs/audio-probe",
      { song },
      { "x-user-cookie": "MUSIC_U=cookie" }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { probe });
  });

  assert.deepEqual(dispatchCalls, [song]);
  assert.deepEqual(probeCalls, [[song, "standard", "playback", "MUSIC_U=cookie"]]);
});

test("audio probe passes an arbitrary string level through and keeps exact download mode", timeout, async () => {
  const calls: Array<[string, string, string | undefined]> = [];
  const dependencies = createDependencies({
    isQqMusicSong: () => false,
    probeSongAudio: async (_song, level, mode, userCookieOverride) => {
      calls.push([level, mode, userCookieOverride]);
      return { ...probe, requestedLevel: level, mode };
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson("POST", "/api/songs/audio-probe", {
      song,
      level: "future-quality",
      mode: "download"
    });
    assert.equal(response.status, 200);
  });

  assert.deepEqual(calls, [["future-quality", "download", undefined]]);
});

test("audio probe maps every non-download mode to playback", timeout, async () => {
  const modes: SongAudioProbeMode[] = [];
  const dependencies = createDependencies({
    isQqMusicSong: () => false,
    probeSongAudio: async (_song, _level, mode) => {
      modes.push(mode);
      return probe;
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    for (const mode of ["DOWNLOAD", "stream", 1, null]) {
      const response = await requestJson("POST", "/api/songs/audio-probe", { song, mode });
      assert.equal(response.status, 200);
    }
  });

  assert.deepEqual(modes, ["playback", "playback", "playback", "playback"]);
});

test("QQ audio probe receives the full Song, level, and mode but never the user cookie", timeout, async () => {
  const dispatchCalls: Song[] = [];
  const probeCalls: Array<[Song, DownloadQualityLevel, SongAudioProbeMode]> = [];
  const qqSong: Song = { ...song, source: "qqmusic" };
  const dependencies = createDependencies({
    isQqMusicSong: (receivedSong) => {
      dispatchCalls.push(receivedSong as Song);
      return true;
    },
    probeQqSongAudio: async function (receivedSong, level, mode) {
      assert.equal(arguments.length, 3);
      probeCalls.push([receivedSong, level, mode]);
      return { ...probe, songId: receivedSong.id, requestedLevel: level, mode };
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    const response = await requestJson(
      "POST",
      "/api/songs/audio-probe",
      { song: qqSong, level: "lossless", mode: "download" },
      { "x-user-cookie": "must-not-reach-qq" }
    );
    assert.equal(response.status, 200);
  });

  assert.deepEqual(dispatchCalls, [qqSong]);
  assert.deepEqual(probeCalls, [[qqSong, "lossless", "download"]]);
});

test("audio probe preserves media access status and ordinary error behavior", timeout, async () => {
  let calls = 0;
  const dependencies = createDependencies({
    isQqMusicSong: () => false,
    probeSongAudio: async (receivedSong) => {
      calls += 1;
      if (receivedSong.id === "media") {
        throw new FakeMediaAccessError(429, "media blocked");
      }
      if (receivedSong.id === "known") {
        throw new Error("probe failed");
      }
      throw "probe failed";
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    const media = await requestJson("POST", "/api/songs/audio-probe", { song: { ...song, id: "media" } });
    assert.equal(media.status, 429);
    assert.deepEqual(media.body, { message: "media blocked" });

    const known = await requestJson("POST", "/api/songs/audio-probe", { song: { ...song, id: "known" } });
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "probe failed" });

    const fallback = await requestJson("POST", "/api/songs/audio-probe", { song: { ...song, id: "fallback" } });
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "检测实际音源失败" });
  });

  assert.equal(calls, 3);
});

test("QQ insight returns the fixed placeholder with the requested song id", timeout, async () => {
  const dependencies = createDependencies();

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/songs/qq-song/insight?source=qqmusic");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      insight: {
        songId: "qq-song",
        listening: { note: "QQ 音乐歌曲洞察暂未接入" },
        encyclopedia: { tags: [] }
      }
    });
  });
});

test("insight uses Netease for missing, non-exact, and non-string sources", timeout, async () => {
  const calls: string[] = [];
  const dependencies = createDependencies({
    getNeteaseSongInsight: async (songId) => {
      calls.push(songId);
      return { ...insight, songId };
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const paths = [
      "/api/songs/missing/insight",
      "/api/songs/qq/insight?source=qq",
      "/api/songs/spaced/insight?source=%20qqmusic%20",
      "/api/songs/repeated/insight?source=qqmusic&source=other"
    ];

    for (const path of paths) {
      const songId = path.split("/")[3];
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { insight: { ...insight, songId } });
    }
  });

  assert.deepEqual(calls, ["missing", "qq", "spaced", "repeated"]);
});

test("insight preserves Error messages and the non-Error 502 fallback", timeout, async () => {
  const dependencies = createDependencies({
    getNeteaseSongInsight: async (songId) => {
      throw songId === "known" ? new Error("insight failed") : "insight failed";
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/songs/known/insight");
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "insight failed" });

    const fallback = await request("/api/songs/unknown/insight");
    assert.equal(fallback.status, 502);
    assert.deepEqual(fallback.body, { message: "获取歌曲洞察失败" });
  });
});

test("likes GET passes the id, ignores source, and wraps the provider value", timeout, async () => {
  const calls: string[] = [];
  const dependencies = createDependencies({
    isSongLiked: async (songId) => {
      calls.push(songId);
      return true;
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const response = await request("/api/likes/song-liked?source=qqmusic");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { liked: true });
  });

  assert.deepEqual(calls, ["song-liked"]);
});

test("likes GET keeps Error messages and the non-Error 401 fallback", timeout, async () => {
  const dependencies = createDependencies({
    isSongLiked: async (songId) => {
      throw songId === "known" ? new Error("login required") : "login required";
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const known = await request("/api/likes/known");
    assert.equal(known.status, 401);
    assert.deepEqual(known.body, { message: "login required" });

    const fallback = await request("/api/likes/unknown");
    assert.equal(fallback.status, 401);
    assert.deepEqual(fallback.body, { message: "获取喜欢状态失败" });
  });
});

test("likes POST keeps Boolean coercion and returns each provider result directly", timeout, async () => {
  const calls: Array<[string, boolean]> = [];
  const dependencies = createDependencies({
    toggleSongLike: async (songId, liked) => {
      calls.push([songId, liked]);
      return { liked, provider: "netease" };
    }
  });
  const cases: Array<[string, object, boolean]> = [
    ["true", { liked: true }, true],
    ["false", { liked: false }, false],
    ["one", { liked: 1 }, true],
    ["zero", { liked: 0 }, false],
    ["string-false", { liked: "false" }, true],
    ["empty-string", { liked: "" }, false],
    ["missing", {}, false]
  ];

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    for (const [songId, body, expected] of cases) {
      const response = await requestJson("POST", `/api/likes/${songId}`, body);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { liked: expected, provider: "netease" });
    }
  });

  assert.deepEqual(calls, cases.map(([songId, _body, liked]) => [songId, liked]));
});

test("likes POST keeps Error messages and liked-dependent non-Error fallbacks", timeout, async () => {
  const dependencies = createDependencies({
    toggleSongLike: async (songId) => {
      if (songId === "known") {
        throw new Error("toggle failed");
      }
      throw "toggle failed";
    }
  });

  await withTestRouter([createSongContentRouter(dependencies)], async ({ requestJson }) => {
    const known = await requestJson("POST", "/api/likes/known", { liked: true });
    assert.equal(known.status, 502);
    assert.deepEqual(known.body, { message: "toggle failed" });

    const join = await requestJson("POST", "/api/likes/join", { liked: "false" });
    assert.equal(join.status, 502);
    assert.deepEqual(join.body, { message: "加入喜欢失败" });

    const cancel = await requestJson("POST", "/api/likes/cancel", {});
    assert.equal(cancel.status, 502);
    assert.deepEqual(cancel.body, { message: "取消喜欢失败" });
  });
});

test("unknown, excluded, and wrong-method paths fall through without dependency calls", timeout, async () => {
  const dependencies = createDependencies();

  await withTestRouter([createSongContentRouter(dependencies)], async ({ request }) => {
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/unknown", undefined],
      ["/api/comments/songs/song-1", undefined],
      ["/api/comments/songs/song-1/comment-1/replies", undefined],
      ["/api/users/user-1", undefined],
      ["/api/artists/artist-1", undefined],
      ["/api/albums/album-1", undefined],
      ["/api/playlists", undefined],
      ["/api/lyrics/song-1", { method: "POST" }],
      ["/api/songs/audio-probe", undefined],
      ["/api/songs/song-1/insight", { method: "POST" }],
      ["/api/likes/song-1", { method: "PUT" }]
    ];

    for (const [path, init] of requests) {
      const response = await request(path, init);
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { message: "test fallback" });
    }
  });
});
