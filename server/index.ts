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
import { createMusicMetadataRouter } from "./routes/music-metadata-router.js";
import { createMusicDiscoveryRouter } from "./routes/music-discovery-router.js";
import { createNeteaseImportAuditRouter } from "./routes/netease-import-audit-router.js";
import { createPlaylistTransferJobRouter } from "./routes/playlist-transfer-job-router.js";
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
import type { MatchCandidate, TransferExportFormat, TransferImportRequest, TransferTargetProvider, TransferTrack } from "./playlist-transfer/types.js";

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

app.use(createMusicMetadataRouter({
  resolveArtistIdByName,
  getArtistProfile,
  getAlbumProfile
}));

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

async function checkTransferTargetAvailability(candidate: MatchCandidate) {
  if (candidate.provider === "netease") {
    return checkNeteaseProviderTrackAvailability(candidate);
  }

  return null;
}

app.use(createPlaylistTransferJobRouter({
  getCurrentUserKey,
  listPlaylistTransferJobs,
  createPlaylistTransferJob,
  startPlaylistTransferRunJob,
  loadSourceTracks: (input) => loadTransferSourceTracks(input),
  searchTargetTracks: searchTransferTargetTracks,
  checkAvailability: checkTransferTargetAvailability,
  saveJob: savePlaylistTransferJob,
  getPlaylistTransferRunJob,
  getPlaylistTransferJob,
  formatTransferExport: (job, format) => formatTransferExport(job, format as TransferExportFormat),
  getNeteaseImportTrackIds,
  addNeteaseTrackIdsToExistingPlaylist,
  createNeteasePlaylistFromTrackIds,
  getQqImportTrackMids,
  createQqPlaylistFromTrackMids
}));

app.use(createNeteaseImportAuditRouter({
  loadNeteasePlaylistAuditEntries,
  buildNeteaseImportedPlaylistAudit,
  searchNeteaseProviderTracksByTitle,
  checkNeteaseProviderTrackAvailability,
  startNeteaseImportAuditJob,
  getNeteaseImportAuditJob,
  cancelNeteaseImportAuditJob,
  formatNeteaseImportAuditJobExport,
  createNeteasePlaylistFromTrackIds
}));

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
