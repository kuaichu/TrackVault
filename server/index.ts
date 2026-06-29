import cors from "cors";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getAlbumProfile } from "./album-provider.js";
import { getSession, loginSession, logoutSession } from "./account-store.js";
import { getCloudSongs } from "./cloud-provider.js";
import { getDiscoverSongs } from "./discover-provider.js";
import { getArtistProfile, resolveArtistIdByName } from "./artist-provider.js";
import { getPlayHistory, getSearchHistory, removeSearchHistory, savePlayHistory, saveSearchHistory } from "./history-store.js";
import { getSongLyrics } from "./lyric-provider.js";
import { MediaAccessError } from "./media-security.js";
import { getPlaylistSongs, getUserPlaylists } from "./playlist-provider.js";
import { searchProvider } from "./provider.js";
import { searchQqSongs } from "./qq-search-provider.js";
import { runWithRequestContext } from "./request-context.js";
import { getDailyRecommendSongs } from "./recommend-provider.js";
import { getAdminConfig, getSettings, saveAdminConfig, saveSettings } from "./settings-store.js";
import { isSongLiked, toggleSongLike } from "./song-like-provider.js";
import { assertDownloadAccess, checkNeteaseCookie, createTask, getAllTasks, resolveSongStream } from "./task-store.js";
import { checkNeteaseQrLogin, loginWithNeteaseCellphone, sendNeteaseCaptcha, startNeteaseQrLogin } from "./netease-auth.js";
import type { AdminConfigUpdate, AppSettings, DownloadQualityLevel, DownloadRequest, MusicPlatform } from "./types.js";

const app = express();
const port = 3010;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "../dist");

app.use(cors());
app.use(express.json());
app.use((request, response, next) => {
  const headerSessionId = typeof request.headers["x-client-session-id"] === "string" ? request.headers["x-client-session-id"] : "";
  const querySessionId = typeof request.query.sid === "string" ? request.query.sid : "";
  runWithRequestContext(headerSessionId || querySessionId, next);
});
app.use(express.static(clientDistDir));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/search", async (request, response) => {
  const query = typeof request.query.q === "string" ? request.query.q : "";
  const platform = (typeof request.query.platform === "string" ? request.query.platform : "netease") as MusicPlatform;

  try {
    const results = platform === "qq" ? await searchQqSongs(query) : await searchProvider(query);
    response.json({ results, platform });
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "搜索失败"
    });
  }
});

app.get("/api/discover/songs", async (_request, response) => {
  try {
    response.json({ songs: await getDiscoverSongs() });
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "获取发现音乐失败"
    });
  }
});

app.get("/api/tasks", async (_request, response) => {
  response.json(await getAllTasks());
});

app.get("/api/history/search", async (_request, response) => {
  response.json({ items: await getSearchHistory() });
});

app.put("/api/history/search", async (request, response) => {
  const items = Array.isArray(request.body?.items) ? request.body.items : [];
  response.json({ items: await saveSearchHistory(items) });
});

app.delete("/api/history/search", async (request, response) => {
  const keyword = typeof request.query.keyword === "string" ? request.query.keyword : "";
  response.json({ items: await removeSearchHistory(keyword) });
});

app.get("/api/history/play", async (_request, response) => {
  response.json({ items: await getPlayHistory() });
});

app.put("/api/history/play", async (request, response) => {
  const items = Array.isArray(request.body?.items) ? request.body.items : [];
  response.json({ items: await savePlayHistory(items) });
});

app.get("/api/playlists", async (_request, response) => {
  try {
    response.json({ playlists: await getUserPlaylists() });
  } catch (error) {
    response.status(401).json({
      message: error instanceof Error ? error.message : "获取歌单失败"
    });
  }
});

app.get("/api/playlists/:id/songs", async (request, response) => {
  try {
    const page = Number(request.query.page);
    const limit = Number(request.query.limit);
    const keyword = typeof request.query.keyword === "string" ? request.query.keyword : "";
    response.json(await getPlaylistSongs(request.params.id, page, limit, keyword));
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "获取歌单歌曲失败"
    });
  }
});

app.get("/api/cloud/songs", async (_request, response) => {
  try {
    response.json(await getCloudSongs());
  } catch (error) {
    response.status(401).json({
      message: error instanceof Error ? error.message : "获取云盘音乐失败"
    });
  }
});

app.get("/api/recommend/daily", async (_request, response) => {
  try {
    response.json({ songs: await getDailyRecommendSongs() });
  } catch (error) {
    response.status(401).json({
      message: error instanceof Error ? error.message : "获取每日推荐失败"
    });
  }
});

app.get("/api/lyrics/:id", async (request, response) => {
  try {
    response.json({ lyrics: await getSongLyrics(request.params.id) });
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "获取歌词失败"
    });
  }
});

app.get("/api/artists/resolve/by-name", async (request, response) => {
  const name = typeof request.query.name === "string" ? request.query.name : "";

  try {
    response.json(await resolveArtistIdByName(name));
  } catch (error) {
    response.status(404).json({
      message: error instanceof Error ? error.message : "解析歌手失败"
    });
  }
});

app.get("/api/artists/:id", async (request, response) => {
  try {
    response.json({ artist: await getArtistProfile(request.params.id) });
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "获取歌手信息失败"
    });
  }
});

app.get("/api/albums/:id", async (request, response) => {
  try {
    response.json({ album: await getAlbumProfile(request.params.id) });
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "获取专辑信息失败"
    });
  }
});

app.get("/api/likes/:id", async (request, response) => {
  try {
    response.json({ liked: await isSongLiked(request.params.id) });
  } catch (error) {
    response.status(401).json({
      message: error instanceof Error ? error.message : "获取喜欢状态失败"
    });
  }
});

app.post("/api/likes/:id", async (request, response) => {
  const liked = Boolean(request.body?.liked);

  try {
    response.json(await toggleSongLike(request.params.id, liked));
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : liked ? "加入喜欢失败" : "取消喜欢失败"
    });
  }
});

app.get("/api/stream", async (request, response) => {
  const songId = typeof request.query.id === "string" ? request.query.id : "";
  const level = typeof request.query.level === "string" ? request.query.level : "standard";
  const expectedDurationSeconds = Number(request.query.expectedDuration ?? 0);
  const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

  if (!songId) {
    response.status(400).json({ message: "缺少歌曲 id" });
    return;
  }

  try {
    const resolved = await resolveSongStream(
      songId,
      level as DownloadQualityLevel,
      userCookieOverride,
      Number.isFinite(expectedDurationSeconds) ? expectedDurationSeconds : 0
    );
    const upstream = await fetch(resolved.url, {
      headers: request.headers.range ? { Range: request.headers.range } : undefined
    });

    if (!upstream.ok || !upstream.body) {
      response.status(upstream.status || 502).json({ message: "音频流获取失败" });
      return;
    }

    const headersToForward = [
      "accept-ranges",
      "content-length",
      "content-range",
      "content-type",
      "cache-control",
      "last-modified",
      "etag"
    ] as const;

    for (const headerName of headersToForward) {
      const value = upstream.headers.get(headerName);
      if (value) {
        response.setHeader(headerName, value);
      }
    }

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.status(upstream.status);
    Readable.fromWeb(upstream.body as any).pipe(response);
  } catch (error) {
    response.status(error instanceof MediaAccessError ? error.status : 502).json({
      message: error instanceof Error ? error.message : "音频流获取失败"
    });
  }
});

app.get("/api/settings", async (_request, response) => {
  response.json(await getSettings());
});

app.put("/api/settings", async (request, response) => {
  const settings = request.body as AppSettings;
  response.json(await saveSettings(settings));
});

app.get("/api/admin/config", async (_request, response) => {
  const session = await getSession();
  if (!session.loggedIn) {
    response.status(401).json({ message: "Unauthorized: Login Required" });
    return;
  }

  response.json(await getAdminConfig());
});

app.post("/api/admin/config", async (request, response) => {
  const session = await getSession();
  if (!session.loggedIn) {
    response.status(401).json({ message: "Unauthorized: Login Required" });
    return;
  }

  response.json(await saveAdminConfig(request.body as AdminConfigUpdate));
});

app.post("/api/settings/netease-cookie/check", async (request, response) => {
  const cookie = typeof request.body?.cookie === "string" ? request.body.cookie : "";
  response.json(await checkNeteaseCookie(cookie));
});

app.get("/api/account", async (_request, response) => {
  response.json(await getSession());
});

app.post("/api/account/login", async (request, response) => {
  const accountName = typeof request.body?.accountName === "string" ? request.body.accountName : "";
  const vipEnabled = Boolean(request.body?.vipEnabled);
  const note = typeof request.body?.note === "string" ? request.body.note : "";

  response.json(await loginSession({ accountName, vipEnabled, note }));
});

app.post("/api/account/logout", async (_request, response) => {
  response.json(await logoutSession());
});

app.post("/api/account/netease/qr/start", async (_request, response) => {
  try {
    response.json(await startNeteaseQrLogin());
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : "二维码登录初始化失败" });
  }
});

app.get("/api/account/netease/qr/check", async (request, response) => {
  const key = typeof request.query.key === "string" ? request.query.key : "";

  try {
    response.json(await checkNeteaseQrLogin(key));
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : "二维码登录状态检查失败" });
  }
});

app.post("/api/account/netease/captcha/send", async (request, response) => {
  const phone = typeof request.body?.phone === "string" ? request.body.phone : "";
  const countryCode = typeof request.body?.countryCode === "string" ? request.body.countryCode : "86";

  try {
    response.json(await sendNeteaseCaptcha(phone, countryCode));
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : "验证码发送失败" });
  }
});

app.post("/api/account/netease/cellphone/login", async (request, response) => {
  const phone = typeof request.body?.phone === "string" ? request.body.phone : "";
  const captcha = typeof request.body?.captcha === "string" ? request.body.captcha : "";
  const countryCode = typeof request.body?.countryCode === "string" ? request.body.countryCode : "86";

  try {
    response.json(await loginWithNeteaseCellphone(phone, captcha, countryCode));
  } catch (error) {
    response.status(500).json({ message: error instanceof Error ? error.message : "手机号登录失败" });
  }
});

app.get("/api/player-state", async (_request, response) => {
  const { getPlayerState } = await import("./player-state-store.js");
  response.json(await getPlayerState());
});

app.put("/api/player-state", async (request, response) => {
  const { savePlayerState } = await import("./player-state-store.js");
  response.json(await savePlayerState(request.body));
});

app.post("/api/download", async (request, response) => {
  const payload = request.body as DownloadRequest;
  const song = payload?.song;
  const level = payload?.level;
  const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

  if (!song?.id || !song?.title || !song?.artist) {
    response.status(400).json({ message: "缺少歌曲信息" });
    return;
  }

  if (!level) {
    response.status(400).json({ message: "缺少下载音质" });
    return;
  }

  try {
    await assertDownloadAccess(song, level, userCookieOverride);
    const task = await createTask(song, level);
    response.status(201).json(task);
  } catch (error) {
    response.status(error instanceof MediaAccessError ? error.status : 502).json({
      message: error instanceof Error ? error.message : "加入下载队列失败"
    });
  }
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(clientDistDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
