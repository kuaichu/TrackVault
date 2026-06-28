import cors from "cors";
import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { getAlbumProfile } from "./album-provider.js";
import { getCurrentUserKey, getSession, loginSession, logoutSession } from "./account-store.js";
import { getCloudSongs } from "./cloud-provider.js";
import { getDiscoverSongs } from "./discover-provider.js";
import { getArtistProfile, resolveArtistIdByName } from "./artist-provider.js";
import { getPlayHistory, getSearchHistory, removeSearchHistory, savePlayHistory, saveSearchHistory } from "./history-store.js";
import { getSongLyrics } from "./lyric-provider.js";
import { MediaAccessError } from "./media-security.js";
import { getPlaylistSongs, getUserPlaylists } from "./playlist-provider.js";
import { searchProvider } from "./provider.js";
import { runWithRequestContext } from "./request-context.js";
import { getDailyRecommendSongs } from "./recommend-provider.js";
import { getAdminConfig, getSettings, saveAdminConfig, saveSettings } from "./settings-store.js";
import { isSongLiked, toggleSongLike } from "./song-like-provider.js";
import { assertDownloadAccess, checkNeteaseCookie, createTask, getAllTasks, getTaskFileForDownload, resolveDirectDownload, resolveSongStream } from "./task-store.js";
import { checkNeteaseQrLogin, loginWithNeteaseCellphone, sendNeteaseCaptcha, startNeteaseQrLogin } from "./netease-auth.js";
import { formatTransferExport } from "./playlist-transfer/export-formatters.js";
import { buildNeteaseImportedPlaylistAudit } from "./playlist-transfer/netease-import-audit.js";
import { cancelNeteaseImportAuditJob, formatNeteaseImportAuditJobExport, getNeteaseImportAuditJob, startNeteaseImportAuditJob } from "./playlist-transfer/netease-import-audit-job.js";
import { getPlaylistCompareJob, startPlaylistCompareJob } from "./playlist-transfer/playlist-compare-job.js";
import { comparePlaylists, formatPlaylistCompareExport } from "./playlist-transfer/playlist-compare.js";
import { getPlaylistTransferRunJob, startPlaylistTransferRunJob } from "./playlist-transfer/playlist-transfer-job.js";
import { checkNeteaseProviderTrackAvailability, createNeteasePlaylistFromTrackIds, loadNeteasePlaylistAuditEntries, loadNeteasePlaylistTransferTracks, searchNeteaseProviderTracks, searchNeteaseProviderTracksByTitle } from "./playlist-transfer/netease-provider.js";
import { loadQqPlaylistTransferTracks, searchQqProviderTracks } from "./playlist-transfer/qq-provider.js";
import { createPlaylistTransferJob, getNeteaseImportTrackIds } from "./playlist-transfer/service.js";
import { getPlaylistTransferJob, listPlaylistTransferJobs, savePlaylistTransferJob } from "./playlist-transfer/store.js";
import type { AdminConfigUpdate, AppSettings, DownloadQualityLevel, DownloadRequest } from "./types.js";
import type { PlaylistCompareResult, PlaylistCompareStatus } from "./playlist-transfer/playlist-compare.js";
import type { MatchCandidate, TransferImportRequest, TransferTargetProvider, TransferTrack } from "./playlist-transfer/types.js";

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
  const results = await searchProvider(query);
  response.json({ results });
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

app.get("/api/tasks/:taskId/file", async (request, response) => {
  const file = await getTaskFileForDownload(request.params.taskId);

  if (!file) {
    response.status(404).json({ message: "下载文件不存在或无权访问" });
    return;
  }

  response.download(file.filePath, file.filename, (error) => {
    if (!error || response.headersSent) {
      return;
    }

    response.status(500).json({ message: "读取下载文件失败" });
  });
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

app.get("/api/download/direct", async (request, response) => {
  const song = {
    id: typeof request.query.id === "string" ? request.query.id : "",
    title: typeof request.query.title === "string" ? request.query.title : "",
    artist: typeof request.query.artist === "string" ? request.query.artist : "",
    album: typeof request.query.album === "string" ? request.query.album : "",
    duration: typeof request.query.duration === "string" ? request.query.duration : "",
    quality: "",
    availableQualities: [],
    source: "netease"
  };
  const level = typeof request.query.level === "string" ? request.query.level : "standard";
  const userCookieOverride = typeof request.headers["x-user-cookie"] === "string" ? request.headers["x-user-cookie"] : undefined;

  if (!song.id || !song.title || !song.artist) {
    response.status(400).json({ message: "缺少歌曲信息" });
    return;
  }

  try {
    const directDownload = await resolveDirectDownload(song, level as DownloadQualityLevel, userCookieOverride);
    response.json(directDownload);
  } catch (error) {
    response.status(error instanceof MediaAccessError ? error.status : 502).json({
      message: error instanceof Error ? error.message : "获取直连下载地址失败"
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

async function searchTransferTargetTracks(track: TransferTrack, targetProvider: TransferTargetProvider) {
  if (targetProvider === "netease") {
    return searchNeteaseProviderTracks(track);
  }

  if (targetProvider === "qq") {
    return searchQqProviderTracks(track);
  }

  return [];
}

async function loadTransferSourceTracks(input: TransferImportRequest) {
  if (input.sourceProvider === "netease") {
    if (!input.playlistId) {
      throw new Error("缺少网易云歌单 ID");
    }

    return loadNeteasePlaylistTransferTracks(input.playlistId);
  }

  if (input.sourceProvider === "qq") {
    if (!input.playlistId) {
      throw new Error("缺少 QQ 音乐歌单 ID");
    }

    return loadQqPlaylistTransferTracks(input.playlistId);
  }

  return [];
}

async function loadCompareSideTracks(provider: string, playlistId: string) {
  if (provider === "netease") {
    return loadNeteasePlaylistTransferTracks(playlistId);
  }

  if (provider === "qq") {
    return loadQqPlaylistTransferTracks(playlistId);
  }

  throw new Error("歌单对比暂只支持网易云歌单和 QQ 音乐公开歌单。");
}

function normalizeCompareStatuses(input: unknown): PlaylistCompareStatus[] {
  const allowed: PlaylistCompareStatus[] = ["exact", "same_title_different_artist", "similar_title", "left_only", "right_only"];
  if (!Array.isArray(input)) {
    return allowed;
  }

  return input.filter((item): item is PlaylistCompareStatus => allowed.includes(item as PlaylistCompareStatus));
}

async function withAuditTimeout<T>(operation: Promise<T>, timeoutMs: number, fallback: T) {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function checkTransferTargetAvailability(candidate: MatchCandidate) {
  if (candidate.provider === "netease") {
    return checkNeteaseProviderTrackAvailability(candidate);
  }

  return null;
}

app.get("/api/playlist-transfer/jobs", async (_request, response) => {
  const ownerKey = await getCurrentUserKey();
  response.json({ jobs: await listPlaylistTransferJobs(ownerKey) });
});

app.post("/api/playlist-transfer/jobs", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const payload = request.body as TransferImportRequest;

  try {
    const job = await createPlaylistTransferJob(
      {
        ...payload,
        ownerKey
      },
      {
        loadSourceTracks: (input) => loadTransferSourceTracks(input),
        searchTargetTracks: searchTransferTargetTracks,
        checkAvailability: checkTransferTargetAvailability,
        saveJob: savePlaylistTransferJob
      }
    );
    response.status(201).json(job);
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "创建歌单互转任务失败"
    });
  }
});

app.post("/api/playlist-transfer/jobs/progress", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const payload = request.body as TransferImportRequest;

  const job = startPlaylistTransferRunJob(
    {
      ...payload,
      ownerKey
    },
    {
      loadSourceTracks: (input) => loadTransferSourceTracks(input),
      searchTargetTracks: searchTransferTargetTracks,
      checkAvailability: checkTransferTargetAvailability,
      saveJob: savePlaylistTransferJob
    }
  );

  response.status(202).json({ job });
});

app.get("/api/playlist-transfer/jobs/progress/:id", (request, response) => {
  const job = getPlaylistTransferRunJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单互转进度任务不存在" });
    return;
  }

  response.json({ job });
});

app.get("/api/playlist-transfer/jobs/:id", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const job = await getPlaylistTransferJob(ownerKey, request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单互转任务不存在" });
    return;
  }

  response.json(job);
});

app.post("/api/playlist-transfer/jobs/:id/export", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const job = await getPlaylistTransferJob(ownerKey, request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单互转任务不存在" });
    return;
  }

  const format = typeof request.body?.format === "string" ? request.body.format : "markdown";
  response.json(formatTransferExport(job, format));
});

app.post("/api/playlist-transfer/jobs/:id/import/netease", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const job = await getPlaylistTransferJob(ownerKey, request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单互转任务不存在" });
    return;
  }

  if (job.targetProvider !== "netease") {
    response.status(400).json({ message: "只有目标为网易云的互转任务才能直接导入网易云歌单。" });
    return;
  }

  try {
    const name = typeof request.body?.name === "string" && request.body.name.trim()
      ? request.body.name.trim()
      : `${job.playlistName} 转换结果`;
    const trackIds = getNeteaseImportTrackIds(job);
    const result = await createNeteasePlaylistFromTrackIds(name, trackIds);
    response.json({
      ...result,
      skippedCount: job.summary.total - result.addedCount
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "导入网易云歌单失败"
    });
  }
});

app.post("/api/playlist-transfer/netease-import-audit", async (request, response) => {
  const playlistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
  const playlistName = typeof request.body?.playlistName === "string" && request.body.playlistName.trim()
    ? request.body.playlistName.trim()
    : "网易云歌单";
  const maxTracks = Number(request.body?.maxTracks ?? 300);
  const candidateLimit = Number(request.body?.candidateLimit ?? 5);
  const checkAvailability = request.body?.checkAvailability !== false;

  if (!playlistId) {
    response.status(400).json({ message: "缺少网易云歌单 ID。" });
    return;
  }

  try {
    const tracks = await loadNeteasePlaylistAuditEntries(playlistId, maxTracks);
    const audit = await buildNeteaseImportedPlaylistAudit({
      playlistId,
      playlistName,
      tracks,
      candidateLimit,
      searchCandidates: searchNeteaseProviderTracksByTitle,
      checkCandidateAvailability: checkAvailability ? checkNeteaseProviderTrackAvailability : undefined
    });

    response.json(audit);
  } catch (error) {
    response.status(502).json({
      message: error instanceof Error ? error.message : "网易云导入歌单清理失败"
    });
  }
});

app.post("/api/playlist-transfer/netease-import-audit/jobs", async (request, response) => {
  const playlistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
  const playlistName = typeof request.body?.playlistName === "string" && request.body.playlistName.trim()
    ? request.body.playlistName.trim()
    : "网易云歌单";
  const maxTracks = Math.min(1000, Math.max(1, Math.trunc(Number(request.body?.maxTracks ?? 300)) || 300));
  const candidateLimit = Math.min(10, Math.max(1, Math.trunc(Number(request.body?.candidateLimit ?? 5)) || 5));
  const checkAvailability = request.body?.checkAvailability === true;

  if (!playlistId) {
    response.status(400).json({ message: "缺少网易云歌单 ID。" });
    return;
  }

  const job = startNeteaseImportAuditJob(
    {
      playlistId,
      playlistName,
      maxTracks,
      candidateLimit,
      checkAvailability
    },
    {
      loadEntries: loadNeteasePlaylistAuditEntries,
      searchCandidates: (track) => withAuditTimeout(searchNeteaseProviderTracksByTitle(track), 12000, []),
      checkCandidateAvailability: (candidate) => withAuditTimeout(checkNeteaseProviderTrackAvailability(candidate), 8000, null)
    }
  );

  response.status(202).json({ job });
});

app.get("/api/playlist-transfer/netease-import-audit/jobs/:id", (request, response) => {
  const job = getNeteaseImportAuditJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
    return;
  }

  response.json({ job });
});

app.post("/api/playlist-transfer/netease-import-audit/jobs/:id/cancel", (request, response) => {
  const job = cancelNeteaseImportAuditJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
    return;
  }

  response.json({ job });
});

app.post("/api/playlist-transfer/netease-import-audit/jobs/:id/export", (request, response) => {
  const job = getNeteaseImportAuditJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
    return;
  }

  if (job.status !== "completed" || !job.result) {
    response.status(400).json({ message: "任务尚未完成，不能导出。" });
    return;
  }

  const format = typeof request.body?.format === "string" ? request.body.format : "text";
  response.json(formatNeteaseImportAuditJobExport(job.result, format as "markdown" | "text" | "csv" | "json"));
});

app.post("/api/playlist-transfer/netease-import-audit/jobs/:id/import/playable", async (request, response) => {
  const job = getNeteaseImportAuditJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "网易云导入歌单清理任务不存在。" });
    return;
  }

  if (job.status !== "completed" || !job.result) {
    response.status(400).json({ message: "任务尚未完成，不能创建正常歌曲新歌单。" });
    return;
  }

  const trackIds = job.result.playableTrackIds;
  if (trackIds.length === 0) {
    response.status(400).json({ message: "扫描结果里没有正常可播歌曲，不能创建新歌单。" });
    return;
  }

  const name = typeof request.body?.name === "string" && request.body.name.trim()
    ? request.body.name.trim()
    : `${job.result.playlistName} - 正常歌曲`;

  try {
    const result = await createNeteasePlaylistFromTrackIds(name, trackIds);
    response.json({
      ...result,
      skippedCount: Math.max(0, job.result.scannedCount - trackIds.length)
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "创建正常歌曲新歌单失败"
    });
  }
});

app.post("/api/playlist-transfer/compare/jobs", (request, response) => {
  const leftProvider = typeof request.body?.leftProvider === "string" ? request.body.leftProvider.trim() : "";
  const rightProvider = typeof request.body?.rightProvider === "string" ? request.body.rightProvider.trim() : "";
  const leftPlaylistId = typeof request.body?.leftPlaylistId === "string" ? request.body.leftPlaylistId.trim() : "";
  const rightPlaylistId = typeof request.body?.rightPlaylistId === "string" ? request.body.rightPlaylistId.trim() : "";
  const leftPlaylistName = typeof request.body?.leftPlaylistName === "string" && request.body.leftPlaylistName.trim()
    ? request.body.leftPlaylistName.trim()
    : `左侧歌单 ${leftPlaylistId}`;
  const rightPlaylistName = typeof request.body?.rightPlaylistName === "string" && request.body.rightPlaylistName.trim()
    ? request.body.rightPlaylistName.trim()
    : `右侧歌单 ${rightPlaylistId}`;

  if (!leftPlaylistId || !rightPlaylistId) {
    response.status(400).json({ message: "请填写左右两个歌单 ID。" });
    return;
  }

  const job = startPlaylistCompareJob(
    {
      leftProvider: leftProvider as "netease" | "qq",
      leftPlaylistId,
      leftPlaylistName,
      rightProvider: rightProvider as "netease" | "qq",
      rightPlaylistId,
      rightPlaylistName
    },
    {
      loadSideTracks: loadCompareSideTracks
    }
  );

  response.status(202).json({ job });
});

app.get("/api/playlist-transfer/compare/jobs/:id", (request, response) => {
  const job = getPlaylistCompareJob(request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单对比进度任务不存在" });
    return;
  }

  response.json({ job });
});

app.post("/api/playlist-transfer/compare", async (request, response) => {
  const leftProvider = typeof request.body?.leftProvider === "string" ? request.body.leftProvider.trim() : "";
  const rightProvider = typeof request.body?.rightProvider === "string" ? request.body.rightProvider.trim() : "";
  const leftPlaylistId = typeof request.body?.leftPlaylistId === "string" ? request.body.leftPlaylistId.trim() : "";
  const rightPlaylistId = typeof request.body?.rightPlaylistId === "string" ? request.body.rightPlaylistId.trim() : "";
  const leftPlaylistName = typeof request.body?.leftPlaylistName === "string" && request.body.leftPlaylistName.trim()
    ? request.body.leftPlaylistName.trim()
    : `左侧歌单 ${leftPlaylistId}`;
  const rightPlaylistName = typeof request.body?.rightPlaylistName === "string" && request.body.rightPlaylistName.trim()
    ? request.body.rightPlaylistName.trim()
    : `右侧歌单 ${rightPlaylistId}`;

  if (!leftPlaylistId || !rightPlaylistId) {
    response.status(400).json({ message: "请填写左右两个歌单 ID。" });
    return;
  }

  try {
    const [leftTracks, rightTracks] = await Promise.all([
      loadCompareSideTracks(leftProvider, leftPlaylistId),
      loadCompareSideTracks(rightProvider, rightPlaylistId)
    ]);
    response.json(comparePlaylists({
      left: {
        provider: leftProvider as "netease" | "qq",
        playlistId: leftPlaylistId,
        playlistName: leftPlaylistName,
        tracks: leftTracks
      },
      right: {
        provider: rightProvider as "netease" | "qq",
        playlistId: rightPlaylistId,
        playlistName: rightPlaylistName,
        tracks: rightTracks
      }
    }));
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "歌单对比失败"
    });
  }
});

app.post("/api/playlist-transfer/compare/export", async (request, response) => {
  const result = request.body?.result as PlaylistCompareResult | undefined;
  const format = typeof request.body?.format === "string" ? request.body.format : "markdown";
  const statuses = normalizeCompareStatuses(request.body?.statuses);

  if (!result?.left || !result?.right || !Array.isArray(result.items)) {
    response.status(400).json({ message: "缺少有效的歌单对比结果。" });
    return;
  }

  response.json(formatPlaylistCompareExport(result, format as "markdown" | "text" | "csv" | "json", statuses));
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(clientDistDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
