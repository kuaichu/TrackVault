import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SoundQualityType } from "NeteaseCloudMusicApi";
import { getCurrentUserKey } from "./account-store.js";
import { getDatabase, isSqliteAvailable, readJsonStore, updateJsonStore } from "./database.js";
import { buildMediaCredentialPlan, extractClientSessionIdFromUserKey } from "./media-security.js";
import { addFlacMetadataToDownload, isFlacDownloadTarget } from "./download-metadata.js";
import { isQqMusicSong, probeQqSongAudio, resolveQqDirectDownload } from "./qqmusic-provider.js";
import { getSettings } from "./settings-store.js";
import type { DownloadQualityLevel, DownloadTask, NeteaseCookieCheckResult, Song, SongAudioProbe, SongAudioProbeMode } from "./types.js";

const require = createRequire(import.meta.url);
const neteaseApi = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi") & {
  song_download_url_v1: (params: { id: string | number; level: SoundQualityType; cookie?: string }) => Promise<{ body: unknown }>;
};
const { login_status, song_download_url_v1, song_url_v1 } = neteaseApi;

const dataDir = path.resolve(process.cwd(), "data");
const tasksPath = path.join(dataDir, "download-tasks.json");
const tasks = new Map<string, DownloadTask>();
const taskSongs = new Map<string, Song>();
const taskOwners = new Map<string, string>();
const runningTaskIds = new Set<string>();
const DEFAULT_RETRY_LIMIT = 2;
let scheduling = false;
let persistTimer: NodeJS.Timeout | null = null;
let initialized = false;

type SongUrlItem = {
  url?: string | null;
  type?: string | null;
  br?: number | string | null;
  level?: string | null;
  time?: number | null;
  freeTrialInfo?: {
    start?: number;
    end?: number;
  } | null;
};

export type ResolvedSongStream = {
  url: string;
  type?: string | null;
  br?: number | string | null;
  level?: string | null;
  time?: number | null;
  freeTrialInfo?: {
    start?: number;
    end?: number;
  } | null;
};

export type DirectDownloadResolution = {
  url: string;
  filename: string;
  type?: string | null;
  time?: number | null;
};

function normalizeTask(task: DownloadTask): DownloadTask {
  const normalizedTask: DownloadTask = {
    ...task,
    retryCount: Number.isFinite(task.retryCount) ? Math.max(0, Math.trunc(task.retryCount ?? 0)) : 0,
    retryLimit: Number.isFinite(task.retryLimit) ? Math.max(0, Math.trunc(task.retryLimit ?? DEFAULT_RETRY_LIMIT)) : DEFAULT_RETRY_LIMIT
  };

  if (task.status === "downloading" || task.status === "preparing" || task.status === "queued") {
    return {
      ...normalizedTask,
      status: "failed",
      progress: 0,
      error: normalizedTask.error || "任务在服务重启前被中断，请重新下载。"
    };
  }

  return normalizedTask;
}

function shouldAutoRetryDownload(errorMessage: string) {
  const hardFailureKeywords = [
    "试听片段",
    "不是完整版",
    "需要登录态",
    "cookie",
    "版权",
    "缺少歌曲信息",
    "没有返回可下载地址",
    "资源暂不可用",
    "任务在服务重启前被中断"
  ];

  const normalizedMessage = errorMessage.toLowerCase();
  return !hardFailureKeywords.some((keyword) => normalizedMessage.includes(keyword.toLowerCase()));
}

async function initializeTaskStore() {
  if (initialized) {
    return;
  }

  if (!isSqliteAvailable()) {
    const existingRows = (readJsonStore().download_tasks ?? []) as Array<{
      id: string;
      user_key: string;
      task_json: DownloadTask;
      song_json: Song;
    }>;

    if (existingRows.length === 0) {
      try {
        const raw = await fsPromises.readFile(tasksPath, "utf8");
        const parsed = JSON.parse(raw) as DownloadTask[];
        if (Array.isArray(parsed)) {
          const migratedRows: Array<{
            id: string;
            user_key: string;
            task_json: DownloadTask;
            song_json: Song;
          }> = [];

          parsed.forEach((task) => {
            if (!task?.id || !task.songId || !task.title || !task.artist || !task.status || !task.createdAt) {
              return;
            }

            const normalizedTask = normalizeTask(task);
            const legacySong: Song = {
              id: normalizedTask.songId,
              title: normalizedTask.title,
              artist: normalizedTask.artist,
              album: "未知专辑",
              duration: normalizedTask.downloadedDuration ?? "00:00",
              quality: normalizedTask.quality,
              availableQualities: [{ level: normalizedTask.requestedLevel ?? "standard", label: normalizedTask.quality }],
              source: "legacy-task"
            };

            migratedRows.push({
              id: normalizedTask.id,
              user_key: "guest:legacy",
              task_json: normalizedTask,
              song_json: legacySong
            });
          });

          updateJsonStore((store) => {
            store.download_tasks = migratedRows;
          });
        }
      } catch {
        // Ignore missing legacy json file.
      }
    }

    const rows = (readJsonStore().download_tasks ?? []) as Array<{
      id: string;
      user_key: string;
      task_json: DownloadTask;
      song_json: Song;
    }>;

    for (const row of rows) {
      const task = normalizeTask(row.task_json);
      const song = row.song_json;
      tasks.set(row.id, task);
      taskSongs.set(row.id, song);
      taskOwners.set(row.id, row.user_key);
    }

    initialized = true;
    return;
  }

  const database = getDatabase();
  const selectStatement = database.prepare(`
    SELECT id, user_key, task_json, song_json
    FROM download_tasks
    ORDER BY updated_at DESC
  `);
  const existingRows = selectStatement.all() as Array<{
    id: string;
    user_key: string;
    task_json: string;
    song_json: string;
  }>;

  if (existingRows.length === 0) {
    try {
      const raw = await fsPromises.readFile(tasksPath, "utf8");
      const parsed = JSON.parse(raw) as DownloadTask[];
      if (Array.isArray(parsed)) {
        const insertStatement = database.prepare(`
          INSERT INTO download_tasks (id, user_key, task_json, song_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);

        database.exec("BEGIN");
        try {
          parsed.forEach((task, index) => {
            if (!task?.id || !task.songId || !task.title || !task.artist || !task.status || !task.createdAt) {
              return;
            }

            const normalizedTask = normalizeTask(task);
            const legacySong: Song = {
              id: normalizedTask.songId,
              title: normalizedTask.title,
              artist: normalizedTask.artist,
              album: "未知专辑",
              duration: normalizedTask.downloadedDuration ?? "00:00",
              quality: normalizedTask.quality,
              availableQualities: [{ level: normalizedTask.requestedLevel ?? "standard", label: normalizedTask.quality }],
              source: "legacy-task"
            };

            insertStatement.run(
              normalizedTask.id,
              "guest:legacy",
              JSON.stringify(normalizedTask),
              JSON.stringify(legacySong),
              Date.now() - index
            );
          });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
    } catch {
      // Ignore missing legacy json file.
    }
  }

  const rows = selectStatement.all() as Array<{
    id: string;
    user_key: string;
    task_json: string;
    song_json: string;
  }>;

  for (const row of rows) {
    const task = normalizeTask(JSON.parse(row.task_json) as DownloadTask);
    const song = JSON.parse(row.song_json) as Song;
    tasks.set(row.id, task);
    taskSongs.set(row.id, song);
    taskOwners.set(row.id, row.user_key);
  }

  initialized = true;
}

function persistTasks() {
  if (!isSqliteAvailable()) {
    updateJsonStore((store) => {
      store.download_tasks = [...tasks.entries()]
        .sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1))
        .map(([taskId, task]) => {
          const song = taskSongs.get(taskId);
          const userKey = taskOwners.get(taskId) ?? "guest:default";
          return song
            ? {
                id: taskId,
                user_key: userKey,
                task_json: task,
                song_json: song
              }
            : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
    });
    return;
  }

  const database = getDatabase();
  const deleteStatement = database.prepare("DELETE FROM download_tasks");
  const insertStatement = database.prepare(`
    INSERT INTO download_tasks (id, user_key, task_json, song_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  database.exec("BEGIN");
  try {
    deleteStatement.run();

    [...tasks.entries()]
      .sort((a, b) => (a[1].createdAt < b[1].createdAt ? 1 : -1))
      .forEach(([taskId, task], index) => {
        const song = taskSongs.get(taskId);
        const userKey = taskOwners.get(taskId) ?? "guest:default";
        if (!song) {
          return;
        }

        insertStatement.run(
          taskId,
          userKey,
          JSON.stringify(task),
          JSON.stringify(song),
          Date.now() - index
        );
      });

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function scheduleTaskPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTasks();
  }, 180);
}

function sanitizeFileName(input: string) {
  return input
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveQualityLevel(level: DownloadQualityLevel): SoundQualityType {
  return level as SoundQualityType;
}

function getQualityLabel(level: DownloadQualityLevel) {
  switch (level) {
    case "exhigh":
      return "320K";
    case "lossless":
      return "FLAC";
    case "hires":
      return "Hi-Res";
    case "jyeffect":
      return "高清环绕声";
    case "jymaster":
      return "超清母带";
    case "sky":
      return "沉浸环绕声";
    default:
      return "128K";
  }
}

function getMinimumBitrateForLevel(level: DownloadQualityLevel) {
  switch (level) {
    case "exhigh":
      return 300000;
    case "lossless":
      return 700000;
    case "hires":
      return 900000;
    case "jyeffect":
    case "jymaster":
    case "sky":
      return 300000;
    default:
      return 0;
  }
}

function getActualQualityLabel(match: SongUrlItem) {
  const type = match.type?.replace(/^\./, "").toUpperCase();
  const bitrate = Number(match.br ?? 0);
  const bitrateLabel = bitrate > 0 ? `${Math.round(bitrate / 1000)}K` : "";

  if (type && bitrateLabel) {
    return `${type} ${bitrateLabel}`;
  }

  return type || bitrateLabel || "未知音质";
}

function buildSongAudioProbe(song: Song, mode: SongAudioProbeMode, requestedLevel: DownloadQualityLevel, match: SongUrlItem): SongAudioProbe {
  const actualBitrate = Number(match.br ?? 0);

  return {
    songId: song.id,
    mode,
    requestedLevel,
    requestedLabel: getQualityLabel(requestedLevel),
    actualLabel: getActualQualityLabel(match),
    actualLevel: match.level ?? null,
    actualBitrate: Number.isFinite(actualBitrate) && actualBitrate > 0 ? actualBitrate : null,
    actualType: match.type?.replace(/^\./, "").toUpperCase() ?? null,
    actualDuration: match.time ? formatDuration(Number(match.time)) : null,
    trial: isTrialClip(song, match)
  };
}

function assertResolvedQualityMatchesRequest(song: Song, requestedLevel: DownloadQualityLevel, match: SongUrlItem) {
  const requestedLabel = getQualityLabel(requestedLevel);
  const actualBitrate = Number(match.br ?? 0);
  const actualType = match.type?.replace(/^\./, "").toLowerCase() ?? "";
  const actualLevel = match.level?.toLowerCase() ?? "";
  const minimumBitrate = getMinimumBitrateForLevel(requestedLevel);
  const isLosslessRequest = requestedLevel === "lossless" || requestedLevel === "hires";
  const hasLosslessContainer = actualType === "flac" || actualType === "wav";
  const hasMatchingLevel = actualLevel === requestedLevel.toLowerCase();

  if (requestedLevel === "standard") {
    return;
  }

  if (isLosslessRequest && (hasLosslessContainer || hasMatchingLevel || (actualBitrate > 0 && actualBitrate >= minimumBitrate))) {
    return;
  }

  if (!isLosslessRequest && (hasMatchingLevel || !actualBitrate || actualBitrate >= minimumBitrate)) {
    return;
  }

  throw new Error(
    `网易云返回的实际文件是 ${getActualQualityLabel(match)}，低于你选择的 ${requestedLabel}。` +
      `如果这首歌在云盘里只有低码率版本，网易云会优先返回云盘文件；已尝试绕开，仍拿不到更高音质。歌曲：${song.title}`
  );
}

function parseDurationToMs(duration: string) {
  const [minutesText, secondsText] = duration.split(":");
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);

  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return 0;
  }

  return (minutes * 60 + seconds) * 1000;
}

function formatDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isTrialClip(song: Song, match: SongUrlItem) {
  const expectedDurationMs = parseDurationToMs(song.duration);
  const actualDurationMs = Number(match.time ?? 0);
  const trialEnd = Number(match.freeTrialInfo?.end ?? 0);

  if (trialEnd > 0) {
    return true;
  }

  if (!expectedDurationMs || !actualDurationMs) {
    return false;
  }

  return actualDurationMs + 5000 < expectedDurationMs;
}

function getFileExtension(downloadUrl: string, contentType: string | null, fallbackType: string | null | undefined) {
  if (fallbackType) {
    return fallbackType.replace(/^\./, "");
  }

  if (contentType?.includes("audio/flac")) {
    return "flac";
  }

  if (contentType?.includes("audio/mpeg")) {
    return "mp3";
  }

  try {
    const url = new URL(downloadUrl);
    const extension = path.extname(url.pathname).replace(/^\./, "");
    if (extension) {
      return extension;
    }
  } catch {
    // Ignore malformed URL parsing and fall back to a safe default.
  }

  return "mp3";
}

function extractSongUrlItem(body: unknown): SongUrlItem | undefined {
  const data = (body as { data?: SongUrlItem[] | SongUrlItem }).data;

  if (Array.isArray(data)) {
    return data[0];
  }

  return data;
}

async function resolveSongAudio(songId: string, level: DownloadQualityLevel, cookie: string, preferDownloadUrl = false): Promise<ResolvedSongStream> {
  const params = {
    id: songId,
    level: resolveQualityLevel(level),
    cookie: cookie || undefined
  };
  const response = preferDownloadUrl ? await song_download_url_v1(params) : await song_url_v1(params);
  const match = extractSongUrlItem(response.body);

  if (!match?.url) {
    throw new Error("当前歌曲没有返回可下载地址，可能需要登录态或该资源暂不可用。");
  }

  return {
    ...match,
    url: match.url
  };
}

function ensureFullStreamForPlayback(resolved: ResolvedSongStream, expectedDurationSeconds?: number) {
  if (!Number.isFinite(expectedDurationSeconds) || Number(expectedDurationSeconds) <= 0) {
    return;
  }

  const expectedDurationMs = Number(expectedDurationSeconds) * 1000;
  const actualDurationMs = Number(resolved.time ?? 0);
  const trialEnd = Number(resolved.freeTrialInfo?.end ?? 0);

  if (trialEnd > 0 || (actualDurationMs > 0 && actualDurationMs + 5000 < expectedDurationMs)) {
    throw new Error("当前返回的是试听片段，不是完整版。请先登录有效网易云账号，或切换其他可用音质后再试。");
  }
}

async function resolveSongStreamWithPlan(songId: string, level: DownloadQualityLevel, plan: Awaited<ReturnType<typeof buildMediaCredentialPlan>>, expectedDurationSeconds?: number) {
  let primaryError: Error | null = null;

  if (plan.primaryCookie) {
    try {
      const resolved = await resolveSongAudio(songId, level, plan.primaryCookie);
      ensureFullStreamForPlayback(resolved, expectedDurationSeconds);
      return resolved;
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error("媒体流获取失败");
      if (!plan.fallbackCookie) {
        throw primaryError;
      }
    }
  }

  if (plan.fallbackCookie) {
    const resolved = await resolveSongAudio(songId, level, plan.fallbackCookie);
    ensureFullStreamForPlayback(resolved, expectedDurationSeconds);
    return resolved;
  }

  throw primaryError ?? new Error("当前账号没有可用的媒体访问凭证。");
}

async function resolveSongDownloadWithPlan(song: Song, level: DownloadQualityLevel, plan: Awaited<ReturnType<typeof buildMediaCredentialPlan>>) {
  let primaryError: Error | null = null;

  if (plan.primaryCookie) {
    try {
      const match = await resolveSongAudio(song.id, level, plan.primaryCookie, true);
      assertResolvedQualityMatchesRequest(song, level, match);
      if (isTrialClip(song, match)) {
        throw new Error("当前返回的是试听片段，不是完整版。请先在设置页填入网易云登录态 Cookie 后再重试。");
      }
      return match;
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error("下载前校验失败");
      if (!plan.fallbackCookie) {
        throw primaryError;
      }
    }
  }

  if (plan.fallbackCookie) {
    const match = await resolveSongAudio(song.id, level, plan.fallbackCookie, true);
    assertResolvedQualityMatchesRequest(song, level, match);
    if (isTrialClip(song, match)) {
      throw new Error("全局保底凭证返回的仍是试听片段，当前资源不可用。");
    }
    return match;
  }

  throw primaryError ?? new Error("当前账号没有可用的下载凭证。");
}

async function resolveSongPlaybackProbeWithPlan(song: Song, level: DownloadQualityLevel, plan: Awaited<ReturnType<typeof buildMediaCredentialPlan>>) {
  let primaryMatch: ResolvedSongStream | null = null;
  let primaryError: Error | null = null;

  if (plan.primaryCookie) {
    try {
      primaryMatch = await resolveSongAudio(song.id, level, plan.primaryCookie);
      if (!isTrialClip(song, primaryMatch) || !plan.fallbackCookie) {
        return primaryMatch;
      }
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error("媒体流检测失败");
      if (!plan.fallbackCookie) {
        throw primaryError;
      }
    }
  }

  if (plan.fallbackCookie) {
    try {
      return await resolveSongAudio(song.id, level, plan.fallbackCookie);
    } catch (error) {
      if (primaryMatch) {
        return primaryMatch;
      }

      throw error instanceof Error ? error : primaryError ?? new Error("媒体流检测失败");
    }
  }

  throw primaryError ?? new Error("当前账号没有可用的媒体访问凭证。");
}

function shouldTryFallbackForDownloadProbe(song: Song, level: DownloadQualityLevel, match: SongUrlItem) {
  if (isTrialClip(song, match)) {
    return true;
  }

  try {
    assertResolvedQualityMatchesRequest(song, level, match);
    return false;
  } catch {
    return true;
  }
}

async function resolveSongDownloadProbeWithPlan(song: Song, level: DownloadQualityLevel, plan: Awaited<ReturnType<typeof buildMediaCredentialPlan>>) {
  let primaryMatch: ResolvedSongStream | null = null;
  let primaryError: Error | null = null;

  if (plan.primaryCookie) {
    try {
      primaryMatch = await resolveSongAudio(song.id, level, plan.primaryCookie, true);
      if (!shouldTryFallbackForDownloadProbe(song, level, primaryMatch) || !plan.fallbackCookie) {
        return primaryMatch;
      }
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error("下载音源检测失败");
      if (!plan.fallbackCookie) {
        throw primaryError;
      }
    }
  }

  if (plan.fallbackCookie) {
    try {
      return await resolveSongAudio(song.id, level, plan.fallbackCookie, true);
    } catch (error) {
      if (primaryMatch) {
        return primaryMatch;
      }

      throw error instanceof Error ? error : primaryError ?? new Error("下载音源检测失败");
    }
  }

  throw primaryError ?? new Error("当前账号没有可用的下载凭证。");
}

export async function resolveSongStream(
  songId: string,
  level: DownloadQualityLevel,
  userCookieOverride?: string,
  expectedDurationSeconds?: number
) {
  const plan = await buildMediaCredentialPlan({ userCookieOverride });
  return resolveSongStreamWithPlan(songId, level, plan, expectedDurationSeconds);
}

export async function assertDownloadAccess(song: Song, level: DownloadQualityLevel, userCookieOverride?: string) {
  const plan = await buildMediaCredentialPlan({ userCookieOverride });
  await resolveSongDownloadWithPlan(song, level, plan);
}

export async function probeSongAudio(song: Song, level: DownloadQualityLevel, mode: SongAudioProbeMode, userCookieOverride?: string): Promise<SongAudioProbe> {
  if (isQqMusicSong(song)) {
    return probeQqSongAudio(song, level, mode);
  }

  const plan = await buildMediaCredentialPlan({ userCookieOverride });
  const match =
    mode === "download"
      ? await resolveSongDownloadProbeWithPlan(song, level, plan)
      : await resolveSongPlaybackProbeWithPlan(song, level, plan);

  return buildSongAudioProbe(song, mode, level, match);
}

export async function resolveDirectDownload(song: Song, level: DownloadQualityLevel, userCookieOverride?: string): Promise<DirectDownloadResolution> {
  if (isQqMusicSong(song)) {
    return resolveQqDirectDownload(song, level);
  }

  const plan = await buildMediaCredentialPlan({ userCookieOverride });
  const resolvedSong = await resolveSongDownloadWithPlan(song, level, plan);
  const extension = getFileExtension(resolvedSong.url, null, resolvedSong.type);
  const safeFileName = sanitizeFileName(`${song.title}-${song.artist}-${song.id}`);

  return {
    url: resolvedSong.url,
    filename: `${safeFileName}.${extension}`,
    type: resolvedSong.type,
    time: resolvedSong.time
  };
}

export async function checkNeteaseCookie(cookie: string): Promise<NeteaseCookieCheckResult> {
  const trimmed = cookie.trim();
  if (!trimmed) {
    return {
      ok: false,
      accountName: null,
      message: "请先填写完整的网易云登录态 Cookie。"
    };
  }

  try {
    const response = await login_status({ cookie: trimmed });
    const body = response.body as {
      data?: {
        account?: {
          id?: number;
        } | null;
        profile?: {
          nickname?: string;
        } | null;
      };
      profile?: {
        nickname?: string;
      } | null;
      account?: {
        id?: number;
      } | null;
    };

    const accountName = body.data?.profile?.nickname ?? body.profile?.nickname ?? null;
    const accountId = body.data?.account?.id ?? body.account?.id ?? null;
    const ok = Boolean(accountName || accountId);

    return {
      ok,
      accountName,
      message: ok
        ? `Cookie 有效，当前账号：${accountName ?? `UID ${accountId}`}`
        : "Cookie 未通过校验，可能已经过期、复制不完整，或当前登录态不支持该接口。"
    };
  } catch (error) {
    return {
      ok: false,
      accountName: null,
      message: error instanceof Error ? error.message : "Cookie 检测失败"
    };
  }
}

async function downloadSongFile(task: DownloadTask, song: Song) {
  const settings = await getSettings();
  const outputDir = path.resolve(process.cwd(), settings.downloadDirectory);
  const selectedLevel = task.requestedLevel ?? "standard";
  const taskOwner = taskOwners.get(task.id) ?? "guest:default";
  const ownerSessionId = extractClientSessionIdFromUserKey(taskOwner);
  const plan = await buildMediaCredentialPlan({ clientSessionId: ownerSessionId });
  const resolvedSong = await resolveSongDownloadWithPlan(song, selectedLevel, plan);
  const response = await fetch(resolvedSong.url);

  if (!response.ok || !response.body) {
    throw new Error(`下载失败，远程响应状态为 ${response.status}`);
  }

  await fsPromises.mkdir(outputDir, { recursive: true });

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  const extension = getFileExtension(
    resolvedSong.url,
    response.headers.get("content-type"),
    resolvedSong.type
  );
  const contentType = response.headers.get("content-type");
  const safeFileName = sanitizeFileName(`${task.title}-${task.artist}-${task.songId}`);
  const outputPath = path.join(outputDir, `${safeFileName}.${extension}`);
  const writeStream = fs.createWriteStream(outputPath);

  let receivedBytes = 0;
  task.status = "downloading";
  task.progress = 12;
  scheduleTaskPersist();

  const progressStream = Readable.fromWeb(response.body as any).on("data", (chunk: Buffer) => {
    receivedBytes += chunk.length;

    if (contentLength > 0) {
      task.progress = Math.min(99, Math.max(12, Math.round((receivedBytes / contentLength) * 100)));
      scheduleTaskPersist();
      return;
    }

    task.progress = Math.min(95, task.progress + 8);
    scheduleTaskPersist();
  });

  await pipeline(progressStream, writeStream);

  let finalFileSizeBytes = contentLength > 0 ? contentLength : receivedBytes;
  if (isFlacDownloadTarget({ filename: outputPath, type: resolvedSong.type, contentType })) {
    const originalBytes = await fsPromises.readFile(outputPath);
    const taggedBytes = await addFlacMetadataToDownload({
      song,
      bytes: originalBytes,
      filename: outputPath,
      type: resolvedSong.type,
      contentType
    });
    await fsPromises.writeFile(outputPath, taggedBytes);
    finalFileSizeBytes = taggedBytes.byteLength;
  }

  task.progress = 100;
  task.status = "done";
  task.outputPath = outputPath;
  task.downloadedDuration = formatDuration(Number(resolvedSong.time ?? parseDurationToMs(song.duration)));
  task.fileSizeBytes = finalFileSizeBytes;
  scheduleTaskPersist();
}

async function runTask(taskId: string, song: Song) {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }

  task.status = "preparing";
  task.progress = 5;
  task.error = undefined;
  scheduleTaskPersist();

  try {
    await downloadSongFile(task, song);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "下载失败";
    const retryCount = task.retryCount ?? 0;
    const retryLimit = task.retryLimit ?? DEFAULT_RETRY_LIMIT;
    const canRetry = retryCount < retryLimit && shouldAutoRetryDownload(errorMessage);

    task.progress = 0;

    if (canRetry) {
      task.retryCount = retryCount + 1;
      task.status = "queued";
      task.error = `下载失败，准备自动重试（${task.retryCount}/${retryLimit}）：${errorMessage}`;
    } else {
      task.status = "failed";
      task.error = retryCount > 0 ? `已重试 ${retryCount} 次后仍失败：${errorMessage}` : errorMessage;
    }

    scheduleTaskPersist();
  }
}

async function scheduleTasks() {
  await initializeTaskStore();
  if (scheduling) {
    return;
  }

  scheduling = true;

  try {
    const settings = await getSettings();
    const maxConcurrentDownloads = Math.min(5, Math.max(1, Math.round(settings.maxConcurrentDownloads || 3)));
    const freeSlots = maxConcurrentDownloads - runningTaskIds.size;

    if (freeSlots <= 0) {
      return;
    }

    const queuedTasks = [...tasks.values()]
      .filter((task) => task.status === "queued")
      .sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1))
      .slice(0, freeSlots);

    for (const task of queuedTasks) {
      const song = taskSongs.get(task.id);
      if (!song) {
        task.status = "failed";
        task.error = "下载任务缺少歌曲信息。";
        continue;
      }

      runningTaskIds.add(task.id);
      void runTask(task.id, song).finally(() => {
        runningTaskIds.delete(task.id);
        void scheduleTasks();
      });
    }
  } finally {
    scheduling = false;
  }
}

export async function getAllTasks(): Promise<DownloadTask[]> {
  await initializeTaskStore();
  const userKey = await getCurrentUserKey();
  return [...tasks.entries()]
    .filter(([taskId]) => (taskOwners.get(taskId) ?? "guest:default") === userKey)
    .map(([, task]) => task)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getTaskFileForDownload(taskId: string): Promise<{ task: DownloadTask; filePath: string; filename: string } | null> {
  await initializeTaskStore();
  const userKey = await getCurrentUserKey();
  const task = tasks.get(taskId);

  if (!task || (taskOwners.get(taskId) ?? "guest:default") !== userKey || task.status !== "done" || !task.outputPath) {
    return null;
  }

  try {
    const stat = await fsPromises.stat(task.outputPath);
    if (!stat.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    task,
    filePath: task.outputPath,
    filename: path.basename(task.outputPath)
  };
}

export async function createTask(song: Song, level: DownloadQualityLevel): Promise<DownloadTask> {
  await initializeTaskStore();
  const userKey = await getCurrentUserKey();
  const id = crypto.randomUUID();
  const task: DownloadTask = {
    id,
    songId: song.id,
    title: song.title,
    artist: song.artist,
    quality: getQualityLabel(level),
    requestedLevel: level,
    retryCount: 0,
    retryLimit: DEFAULT_RETRY_LIMIT,
    progress: 0,
    status: "queued",
    createdAt: new Date().toISOString()
  };

  tasks.set(id, task);
  taskSongs.set(id, song);
  taskOwners.set(id, userKey);
  scheduleTaskPersist();
  void scheduleTasks();
  return task;
}
