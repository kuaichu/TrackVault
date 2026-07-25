import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAlbumProfile } from "./album-provider.js";
import { getCurrentUserKey, getSession, loginSession, logoutSession } from "./account-store.js";
import { requireAdminAuth } from "./admin-auth.js";
import { getCloudSongs } from "./cloud-provider.js";
import { getSongCommentReplies, getSongComments, replyToSongComment, setSongCommentLiked } from "./comment-provider.js";
import { getDiscoverSongs } from "./discover-provider.js";
import { getAccountState, getDataScopeId } from "./data-scope.js";
import { addAudioMetadataToDownload, getAudioMetadataTarget, getHighResolutionCoverUrl } from "./download-metadata.js";
import { getHeartbeatSongs } from "./heartbeat-provider.js";
import { getArtistProfile, resolveArtistIdByName } from "./artist-provider.js";
import { getPlayHistory, getSearchHistory, removeSearchHistory, savePlayHistory, saveSearchHistory } from "./history-store.js";
import { getSongLyrics } from "./lyric-provider.js";
import { MediaAccessError } from "./media-security.js";
import {
  decideServerMediaHandling,
  getMaxInMemoryMediaBytes,
  getResponseContentLength,
  MediaMemoryLimitExceededError,
  readResponseBytesWithLimit,
  withMediaTaggingSlot
} from "./media-memory-policy.js";
import { addSongToUserPlaylist, getPlaylistSongs, getUserPlaylists, removeSongsFromUserPlaylist } from "./playlist-provider.js";
import { searchProvider } from "./provider.js";
import { runWithRequestContext } from "./request-context.js";
import { getDailyRecommendSongs } from "./recommend-provider.js";
import { getPersonalRadioSongs } from "./personal-radio-provider.js";
import { createAccountRouter } from "./routes/account-router.js";
import { createAdminRouter } from "./routes/admin-router.js";
import { createCommentRouter } from "./routes/comment-router.js";
import { createDownloadTaskRouter } from "./routes/download-task-router.js";
import { createLibraryRouter } from "./routes/library-router.js";
import { createMediaRouter } from "./routes/media-router.js";
import { createMusicDiscoveryRouter } from "./routes/music-discovery-router.js";
import { createPlatformCookieRouter, createSettingsRouter } from "./routes/settings-router.js";
import { createSongContentRouter } from "./routes/song-content-router.js";
import { createUserProfileRouter } from "./routes/user-profile-router.js";
import { createUserStateRouter } from "./routes/user-state-router.js";
import { createQqPlaylistFromTrackMids, getQqDiscoverSongs, getQqMusicAccountStatus, getQqMusicUserProfile, getQqPlaylistSongs, getQqSongCommentReplies, getQqSongComments, getQqSongLyrics, getQqUserPlaylists, isQqMusicSong, probeQqSongAudio, resolveQqSongStream, setQqSongCommentLiked } from "./qqmusic-provider.js";
import { checkQqMusicQrLogin, importQqMusicCookie, logoutQqMusicSession, startQqMusicQrLogin } from "./qqmusic-auth.js";
import { getAdminConfig, getSettings, saveAdminConfig, saveSettings, SettingsUpdateConflictError, toPublicSettings } from "./settings-store.js";
import { getNeteaseSongInsight } from "./song-insight-provider.js";
import { isSongLiked, toggleSongLike } from "./song-like-provider.js";
import { assertDownloadAccess, checkNeteaseCookie, createTask, getAllTasks, getTaskFileForDownload, probeSongAudio, resolveDirectDownload, resolveSongStream } from "./task-store.js";
import { checkNeteaseQrLogin, importNeteaseCookie, loginWithNeteaseCellphone, sendNeteaseCaptcha, startNeteaseQrLogin } from "./netease-auth.js";
import { getUserEvents, getUserMutualFollow, getUserProfile, getUserSocialList, setUserFollowed } from "./user-provider.js";
import { formatTransferExport } from "./playlist-transfer/export-formatters.js";
import { buildNeteaseImportedPlaylistAudit } from "./playlist-transfer/netease-import-audit.js";
import { cancelNeteaseImportAuditJob, formatNeteaseImportAuditJobExport, getNeteaseImportAuditJob, startNeteaseImportAuditJob } from "./playlist-transfer/netease-import-audit-job.js";
import { getPlaylistCompareJob, startPlaylistCompareJob } from "./playlist-transfer/playlist-compare-job.js";
import { comparePlaylists, formatPlaylistCompareExport } from "./playlist-transfer/playlist-compare.js";
import { getPlaylistTransferRunJob, startPlaylistTransferRunJob } from "./playlist-transfer/playlist-transfer-job.js";
import { addNeteaseTrackIdsToExistingPlaylist, checkNeteaseProviderTrackAvailability, createNeteasePlaylistFromTrackIds, loadNeteasePlaylistAuditEntries, loadNeteasePlaylistTransferTracks, searchNeteaseProviderTracks, searchNeteaseProviderTracksByTitle } from "./playlist-transfer/netease-provider.js";
import { loadQqPlaylistTransferTracks, searchQqProviderTracks } from "./playlist-transfer/qq-provider.js";
import { createPlaylistTransferJob, getNeteaseImportTrackIds, getQqImportTrackMids } from "./playlist-transfer/service.js";
import { getPlaylistTransferJob, listPlaylistTransferJobs, savePlaylistTransferJob } from "./playlist-transfer/store.js";
import type { PlaylistCompareResult, PlaylistCompareStatus } from "./playlist-transfer/playlist-compare.js";
import type { MatchCandidate, TransferImportRequest, TransferTargetProvider, TransferTrack } from "./playlist-transfer/types.js";

const app = express();
const port = 3010;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistDir = path.resolve(__dirname, "../dist");

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((request, response, next) => {
  const headerSessionId = typeof request.headers["x-client-session-id"] === "string" ? request.headers["x-client-session-id"] : "";
  const querySessionId = typeof request.query.sid === "string" ? request.query.sid : "";
  runWithRequestContext(headerSessionId || querySessionId, next);
});
app.use(express.static(clientDistDir, {
  setHeaders(response, filePath) {
    if (filePath.endsWith(".html")) {
      response.setHeader("Cache-Control", "no-store");
      return;
    }

    if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      response.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    }
  }
}));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.use(createMusicDiscoveryRouter({
  searchProvider,
  getSettings,
  getDiscoverSongs,
  getQqDiscoverSongs,
  getDailyRecommendSongs,
  getPersonalRadioSongs,
  getHeartbeatSongs
}));

app.use(createDownloadTaskRouter({
  getAllTasks,
  getTaskFileForDownload,
  assertDownloadAccess,
  createTask,
  isMediaAccessError: (error): error is MediaAccessError => error instanceof MediaAccessError
}));

app.use(createUserStateRouter({
  getDataScopeId,
  getSearchHistory,
  saveSearchHistory,
  removeSearchHistory,
  getPlayHistory,
  savePlayHistory,
  getPlayerState: async (dataScopeId) =>
    (await import("./player-state-store.js")).getPlayerState(dataScopeId),
  savePlayerState: async (state, dataScopeId) =>
    (await import("./player-state-store.js")).savePlayerState(state, dataScopeId)
}));

app.use(createLibraryRouter({
  getSettings,
  getUserPlaylists,
  getQqUserPlaylists,
  getPlaylistSongs,
  getQqPlaylistSongs,
  addSongToUserPlaylist,
  removeSongsFromUserPlaylist,
  getCloudSongs
}));

app.use(createSongContentRouter({
  getSongLyrics,
  getQqSongLyrics,
  isQqMusicSong,
  probeQqSongAudio,
  probeSongAudio,
  getNeteaseSongInsight,
  isSongLiked,
  toggleSongLike,
  isMediaAccessError: (error): error is MediaAccessError => error instanceof MediaAccessError
}));

app.use(createCommentRouter({
  getSongComments,
  getQqSongComments,
  getSongCommentReplies,
  getQqSongCommentReplies,
  setSongCommentLiked,
  setQqSongCommentLiked,
  replyToSongComment
}));

app.use(createUserProfileRouter({
  getUserProfile,
  getUserSocialList,
  getUserEvents,
  getUserMutualFollow,
  setUserFollowed
}));

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

app.use(createMediaRouter({
  fetchImpl: fetch,
  getHighResolutionCoverUrl,
  getAudioMetadataTarget,
  addAudioMetadataToDownload,
  decideServerMediaHandling,
  getMaxInMemoryMediaBytes,
  getResponseContentLength,
  readResponseBytesWithLimit,
  withMediaTaggingSlot,
  resolveQqSongStream,
  resolveSongStream,
  resolveDirectDownload,
  isMediaAccessError: (error) => error instanceof MediaAccessError,
  isMediaMemoryLimitExceededError: (error) => error instanceof MediaMemoryLimitExceededError
}));

app.use(createSettingsRouter({
  getSettings,
  saveSettings,
  toPublicSettings,
  isSettingsUpdateConflictError: (error) => error instanceof SettingsUpdateConflictError
}));

app.use(createAdminRouter({
  requireAdminAuth,
  getAdminConfig,
  saveAdminConfig
}));

app.use(createPlatformCookieRouter({
  getSettings,
  checkNeteaseCookie,
  importNeteaseCookie,
  importQqMusicCookie
}));

app.use(createAccountRouter({
  getAccountState,
  loginSession,
  logoutSession,
  getQqMusicAccountStatus,
  getQqMusicUserProfile,
  startQqMusicQrLogin,
  checkQqMusicQrLogin,
  logoutQqMusicSession,
  startNeteaseQrLogin,
  checkNeteaseQrLogin,
  sendNeteaseCaptcha,
  loginWithNeteaseCellphone
}));

async function searchTransferTargetTracks(track: TransferTrack, targetProvider: TransferTargetProvider) {
  if ((targetProvider === "netease" || targetProvider === "qq") && track.source === targetProvider && track.sourceTrackId) {
    return [{
      provider: targetProvider,
      id: track.sourceTrackId,
      title: track.title,
      artists: track.artists,
      album: track.album,
      durationSeconds: track.durationSeconds
    }];
  }

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

function normalizeCompareItemIndexes(input: unknown, itemCount: number) {
  if (!Array.isArray(input)) {
    return undefined;
  }

  return [...new Set(input.filter((item): item is number => Number.isInteger(item) && item >= 0 && item < itemCount))];
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
    const targetPlaylistId = typeof request.body?.playlistId === "string" ? request.body.playlistId.trim() : "";
    const trackIds = getNeteaseImportTrackIds(job);
    const result = targetPlaylistId
      ? await addNeteaseTrackIdsToExistingPlaylist(targetPlaylistId, trackIds)
      : await createNeteasePlaylistFromTrackIds(name, trackIds);
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

app.post("/api/playlist-transfer/jobs/:id/import/qq", async (request, response) => {
  const ownerKey = await getCurrentUserKey();
  const job = await getPlaylistTransferJob(ownerKey, request.params.id);
  if (!job) {
    response.status(404).json({ message: "歌单互转任务不存在" });
    return;
  }

  if (job.targetProvider !== "qq") {
    response.status(400).json({ message: "只有目标为 QQ 音乐的互转任务才能直接导入 QQ 歌单。" });
    return;
  }

  try {
    const name = typeof request.body?.name === "string" && request.body.name.trim()
      ? request.body.name.trim()
      : `${job.playlistName} 转换结果`;
    const trackMids = getQqImportTrackMids(job);
    const result = await createQqPlaylistFromTrackMids(name, trackMids);
    response.json({
      ...result,
      skippedCount: job.summary.total - result.addedCount
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "导入 QQ 音乐歌单失败"
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

  const itemIndexes = normalizeCompareItemIndexes(request.body?.itemIndexes, result.items.length);
  const preferredProvider = request.body?.preferredProvider === "netease" || request.body?.preferredProvider === "qq"
    ? request.body.preferredProvider
    : undefined;

  response.json(formatPlaylistCompareExport(
    result,
    format as "markdown" | "text" | "csv" | "json",
    statuses,
    { itemIndexes, preferredProvider }
  ));
});

app.get("/assets/*", (_request, response) => {
  response.status(404).json({ message: "静态资源不存在，请刷新页面获取最新版本。" });
});

app.get("*", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(clientDistDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
