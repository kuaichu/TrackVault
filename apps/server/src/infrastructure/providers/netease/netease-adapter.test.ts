import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../../domain/errors.js";
import type { ProviderAuthContext } from "../../../domain/ports/music-provider.js";
import { NeteaseAdapter, normalizeNeteaseCookie } from "./netease-adapter.js";
import { mapNeteaseSong } from "./netease-mapper.js";

const authedCtx: ProviderAuthContext = {
  platform: "netease",
  cookie: "MUSIC_U=valid_token_123",
  scopeKey: "user-1",
  accountUid: "10001",
};

test("normalizeNeteaseCookie strips Cookie: prefix, line breaks, and Set-Cookie attributes (C041)", () => {
  const raw =
    "Cookie: MUSIC_U=abc123;\nMax-Age=31536000; Expires=Thu, 20 Nov 2036 00:00:00 GMT; Path=/; HttpOnly;\r\nCookie: __csrf=xyz789; os=pc";
  const normalized = normalizeNeteaseCookie(raw);

  assert.equal(normalized.includes("MUSIC_U=abc123"), true);
  assert.equal(normalized.includes("__csrf=xyz789"), true);
  assert.equal(normalized.includes("os=android"), true);
  assert.equal(normalized.includes("Cookie:"), false);
  assert.equal(normalized.includes("Max-Age"), false);
  assert.equal(normalized.includes("Expires"), false);
  assert.equal(normalized.includes("Path="), false);
  assert.equal(normalized.includes("HttpOnly"), false);
  assert.equal(normalized.includes("os=pc"), false);
});

test("NeteaseAdapter.toggleSongLike passes string like='false'/'true' and wraps errors (BUG-01)", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const adapter = new NeteaseAdapter({
    timeoutMs: 9000,
    apiOverride: {
      like: async (params) => {
        seen.push(params);
        if (params.id === "fail") {
          throw new Error("network down");
        }
        return { body: { code: 200 } };
      },
    },
  });

  await adapter.toggleSongLike("186016", false, authedCtx);
  await adapter.toggleSongLike("186016", true, authedCtx);
  assert.equal(seen[0]?.like, "false");
  assert.equal(seen[1]?.like, "true");
  assert.equal(seen[0]?.timeout, 9000); // A13: timeoutMs propagated

  await assert.rejects(
    () => adapter.toggleSongLike("fail", false, authedCtx),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_ERROR",
  );
});

test("NeteaseAdapter playlist write methods validate outer/inner business codes and chunk by 50 (A02)", async () => {
  const calls: Array<{ op: unknown; count: number }> = [];
  const adapter = new NeteaseAdapter({
    apiOverride: {
      playlist_tracks: async (params) => {
        const tracks = String(params.tracks ?? "")
          .split(",")
          .filter(Boolean);
        calls.push({ op: params.op, count: tracks.length });
        if (params.pid === "fail-inner") {
          return { body: { code: 200, body: { code: 401, message: "需要登录" } } };
        }
        return { body: { code: 200, body: { code: 200 } } };
      },
    },
  });

  await assert.rejects(
    () => adapter.removeTracksFromPlaylist("fail-inner", ["1"], authedCtx),
    (err: unknown) => err instanceof AppError && err.code === "CREDENTIAL_INVALID",
  );

  const ids = Array.from({ length: 120 }, (_, i) => String(i + 1));
  const removed = await adapter.removeTracksFromPlaylist("ok-pl", ids, authedCtx);
  assert.equal(removed.removedCount, 120);
  assert.deepEqual(
    calls.filter((c) => c.op === "del").map((c) => c.count),
    [1, 50, 50, 20],
  );
});

test("NeteaseAdapter.resolveAudio continues past trial to full lower tier and safely maps 'higher' (A06/A14/A13)", async () => {
  const levelsTried: string[] = [];
  const adapter = new NeteaseAdapter({
    timeoutMs: 8000,
    apiOverride: {
      song_url_v1: async (params) => {
        const lv = String(params.level);
        levelsTried.push(lv);
        if (lv === "exhigh") {
          return {
            body: {
              data: [
                {
                  url: "http://m7.music.126.net/trial.mp3",
                  type: "mp3",
                  br: 320_000,
                  level: "exhigh",
                  time: 30_000,
                  freeTrialInfo: { start: 0, end: 30 },
                },
              ],
            },
          };
        }
        if (lv === "higher") {
          return {
            body: {
              data: [
                {
                  url: "http://m7.music.126.net/full192.mp3",
                  type: "mp3",
                  br: 192_000,
                  level: "higher",
                  time: 240_000,
                },
              ],
            },
          };
        }
        return { body: { data: [] } };
      },
    },
  });

  const resolved = await adapter.resolveAudio(
    { id: "186016", durationSeconds: 240 },
    "exhigh",
    "playback",
    authedCtx,
  );
  assert.equal(resolved.trial, false);
  assert.equal(resolved.level, "higher");
  assert.equal(resolved.url, "https://m7.music.126.net/full192.mp3");
  assert.ok(levelsTried.includes("exhigh"));
  assert.ok(levelsTried.includes("higher"));

  // A13: AbortSignal cancels in-flight SDK call promptly
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () =>
      adapter.resolveAudio({ id: "186016" }, "standard", "playback", {
        ...authedCtx,
        signal: ac.signal,
      }),
    (err: unknown) => err instanceof AppError && err.code === "UPSTREAM_TIMEOUT",
  );
});

test("NeteaseAdapter merges privileges in getDailyRecommendTracks and getAlbumDetail (A07/C040)", async () => {
  const adapter = new NeteaseAdapter({
    apiOverride: {
      recommend_songs: async () => ({
        body: {
          code: 200,
          data: {
            dailySongs: [
              {
                id: 101,
                name: "VIP 锁歌",
                fee: 1,
                ar: [{ name: "歌手" }],
                al: { name: "专辑" },
                dt: 200_000,
              },
            ],
            privileges: [{ id: 101, fee: 1, pl: 0, dl: 0, st: 0 }],
          },
        },
      }),
      album: async () => ({
        body: {
          album: { id: 55, name: "测试专辑", publishTime: 1704038400000 }, // 2024-01-01 00:00:00+08:00
          songs: [
            {
              id: 202,
              name: "专辑锁歌",
              fee: 1,
              ar: [{ name: "歌手" }],
              al: { name: "测试专辑" },
              dt: 200_000,
            },
          ],
        },
      }),
      song_detail: async () => ({
        body: {
          privileges: [{ id: 202, fee: 1, pl: 0, dl: 0, st: 0 }],
        },
      }),
    },
  });

  const daily = await adapter.getDailyRecommendTracks(authedCtx);
  assert.equal(daily[0]?.availability?.playback.locked, true);
  assert.equal(daily[0]?.availability?.download.locked, true);

  const album = await adapter.getAlbumDetail("55", authedCtx);
  assert.equal(album.publishDate, "2024-01-01"); // B08: Asia/Shanghai date
  assert.equal(album.songs[0]?.availability?.playback.locked, true);
});

test("NeteaseAdapter preserves fast pagination on 2,005-track playlist and hydrates all tracks on search/sort (A09)", async () => {
  const totalTracks = 2005;
  const trackIds = Array.from({ length: totalTracks }, (_, i) => ({ id: i + 1 }));
  let detailCalls = 0;

  const adapter = new NeteaseAdapter({
    apiOverride: {
      playlist_detail: async () => ({
        body: {
          code: 200,
          playlist: {
            id: 777,
            name: "超大歌单",
            trackCount: totalTracks,
            tracks: Array.from({ length: 10 }, (_, i) => ({
              id: i + 1,
              name: `Song ${i + 1}`,
              ar: [{ name: "Artist" }],
              al: { name: "Album" },
              dt: 180_000,
            })),
            trackIds,
          },
          privileges: [],
        },
      }),
      song_detail: async (params) => {
        detailCalls += 1;
        const ids = String(params.ids ?? "")
          .split(",")
          .filter(Boolean);
        return {
          body: {
            songs: ids.map((id) => ({
              id: Number(id),
              name: id === "2005" ? "Final Tail Track 2005" : `Song ${id}`,
              ar: [{ name: "Artist" }],
              al: { name: "Album" },
              dt: 180_000,
            })),
            privileges: [],
          },
        };
      },
    },
  });

  // Fast path: page 1 with limit 10 uses tracks already embedded -> 0 song_detail calls
  const p1 = await adapter.getPlaylistTracks("777", { page: 1, limit: 10, sort: "default" }, authedCtx);
  assert.equal(p1.songs.length, 10);
  assert.equal(detailCalls, 0);

  // Search path finds track #2005 (>2,000) and populates cache
  const search1 = await adapter.getPlaylistTracks(
    "777",
    { page: 1, limit: 20, keyword: "Final Tail Track 2005" },
    authedCtx,
  );
  assert.equal(search1.total, 1);
  assert.equal(search1.songs[0]?.id, "2005");
  assert.equal(search1.truncated, false);
  assert.equal(search1.scannedTotal, 2005);
  const callsAfterHydration = detailCalls;
  assert.ok(callsAfterHydration > 0);

  // Second search reuses hydrated songMap cache with 0 extra song_detail calls
  const search2 = await adapter.getPlaylistTracks(
    "777",
    { page: 1, limit: 20, keyword: "Song 1999" },
    authedCtx,
  );
  assert.equal(search2.total, 1);
  assert.equal(detailCalls, callsAfterHydration);
});

test("NeteaseAdapter cloud disk pagination uses count when hasMore is omitted and supports offset > 2000 (A10/B03)", async () => {
  const adapter = new NeteaseAdapter({
    apiOverride: {
      user_cloud: async (params) => {
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 100);
        const count = 2150;
        const remaining = Math.max(0, Math.min(limit, count - offset));
        return {
          body: {
            code: 200,
            count,
            // Intentionally omit `hasMore` to verify B03 fix
            data: Array.from({ length: remaining }, (_, idx) => ({
              songId: offset + idx + 1,
              songName: `Cloud Song ${offset + idx + 1}`,
              artist: "Uploader",
              album: "Cloud",
            })),
          },
        };
      },
    },
  });

  const page1 = await adapter.getCloudTracksPage(authedCtx, { offset: 0, limit: 100 });
  assert.equal(page1.songs.length, 100);
  assert.equal(page1.total, 2150);
  assert.equal(page1.hasMore, true);

  const tailPage = await adapter.getCloudTracksPage(authedCtx, { offset: 2100, limit: 100 });
  assert.equal(tailPage.songs.length, 50);
  assert.equal(tailPage.total, 2150);
  assert.equal(tailPage.hasMore, false);
});

test("NeteaseAdapter binds QR unikey to scopeKey (C038) and mapper safely truncates long emoji titles (C045)", async () => {
  const adapter = new NeteaseAdapter({
    apiOverride: {
      login_qr_key: async () => ({ body: { data: { unikey: "qr-key-abc" } } }),
      login_qr_create: async () => ({ body: { data: { qrimg: "data:image/png;base64,AA==" } } }),
      login_qr_check: async () => ({ body: { code: 801, message: "等待扫码" } }),
    },
  });

  const started = await adapter.startQrLogin("user-A");
  assert.equal(started.key, "qr-key-abc");

  const wrongUser = await adapter.checkQrLogin("user-B", "qr-key-abc");
  assert.equal(wrongUser.status, "expired");

  const rightUser = await adapter.checkQrLogin("user-A", "qr-key-abc");
  assert.equal(rightUser.status, "waiting");

  const mapped = mapNeteaseSong({
    id: 999,
    name: "🎵".repeat(600),
    al: { name: "📀".repeat(600) },
    ar: [{ name: "Artist" }],
  });
  assert.ok(mapped);
  assert.ok(Array.from(mapped.title).length <= 500);
  assert.ok(Array.from(mapped.album).length <= 500);
  assert.doesNotThrow(() => encodeURIComponent(mapped.title));
});
