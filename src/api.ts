import type {
  AlbumProfile,
  AdminConfigUpdate,
  AdminConfigView,
  ArtistProfile,
  AppSettings,
  AuthSession,
  NeteaseCaptchaSendResult,
  NeteaseCellphoneLoginResult,
  DownloadQualityLevel,
  DownloadTask,
  NeteaseImportAudit,
  NeteaseImportAuditJob,
  NeteaseImportAuditRequest,
  NeteaseCookieCheckResult,
  NeteaseQrCheckResult,
  NeteaseQrStartResult,
  NeteaseTransferImportResult,
  PersistedPlayerState,
  PlaylistCompareExportRequest,
  PlaylistCompareJob,
  PlaylistCompareRequest,
  PlaylistCompareResult,
  PlaylistSongsPage,
  PlaylistTransferJob,
  PlaylistTransferRunJob,
  Song,
  SongLyrics,
  TransferExportFormat,
  TransferExportResult,
  TransferImportRequest,
  UserPlaylist
} from "./types";

const CLIENT_SESSION_STORAGE_KEY = "trackvault:client-session-id";

function getClientSessionId() {
  try {
    const existing = window.localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const nextValue = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, nextValue);
    return nextValue;
  } catch {
    return "default";
  }
}

async function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("x-client-session-id", getClientSessionId());

  return fetch(input, {
    ...init,
    headers
  });
}

export function getStreamUrl(songId: string, level: DownloadQualityLevel, expectedDurationSeconds?: number) {
  const params = new URLSearchParams({
    id: songId,
    level,
    sid: getClientSessionId()
  });

  if (Number.isFinite(expectedDurationSeconds) && Number(expectedDurationSeconds) > 0) {
    params.set("expectedDuration", String(Math.round(Number(expectedDurationSeconds))));
  }

  return `/api/stream?${params.toString()}`;
}

type DirectDownloadInfo = {
  url: string;
  filename: string;
  type?: string | null;
  time?: number | null;
};

export function getDirectDownloadUrl(song: Song, level: DownloadQualityLevel) {
  const params = new URLSearchParams({
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
    level,
    sid: getClientSessionId()
  });

  return `/api/download/direct?${params.toString()}`;
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(objectUrl), 1000);
}

export async function startDirectSongDownload(song: Song, level: DownloadQualityLevel, onProgress?: (progress: number) => void) {
  const directResponse = await apiFetch(getDirectDownloadUrl(song, level));
  if (!directResponse.ok) {
    const data = (await directResponse.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取直连下载地址失败");
  }

  const directDownload = (await directResponse.json()) as DirectDownloadInfo;
  const mediaResponse = await fetch(directDownload.url, {
    credentials: "omit",
    mode: "cors"
  }).catch(() => {
    throw new Error("浏览器被网易云 CDN 跨域策略拦截，无法无中转保存到本机。");
  });

  if (!mediaResponse.ok) {
    throw new Error(`网易云 CDN 下载失败：HTTP ${mediaResponse.status}`);
  }

  const contentLength = Number(mediaResponse.headers.get("content-length") ?? "0");
  if (!mediaResponse.body || !contentLength) {
    const blob = await mediaResponse.blob();
    saveBlob(blob, directDownload.filename);
    return;
  }

  const reader = mediaResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      receivedBytes += value.length;
      onProgress?.(Math.max(1, Math.min(99, Math.round((receivedBytes / contentLength) * 100))));
    }
  }

  saveBlob(new Blob(chunks, { type: mediaResponse.headers.get("content-type") ?? "application/octet-stream" }), directDownload.filename);
  onProgress?.(100);
}

export async function searchSongs(query: string): Promise<Song[]> {
  const response = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error("搜索失败");
  }
  const data = (await response.json()) as { results: Song[] };
  return data.results;
}

export async function getDiscoverSongs(): Promise<Song[]> {
  const response = await apiFetch("/api/discover/songs");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取发现音乐失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

export async function createDownload(song: Song, level: DownloadQualityLevel): Promise<DownloadTask> {
  const response = await apiFetch("/api/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ song, level })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "加入下载队列失败");
  }

  return (await response.json()) as DownloadTask;
}

export async function getTasks(): Promise<DownloadTask[]> {
  const response = await apiFetch("/api/tasks");
  if (!response.ok) {
    throw new Error("获取任务失败");
  }
  return (await response.json()) as DownloadTask[];
}

function getFilenameFromContentDisposition(contentDisposition: string | null) {
  if (!contentDisposition) {
    return "";
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim());
  }

  const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
  return filenameMatch?.[1]?.trim() ?? "";
}

export async function downloadTaskFile(task: DownloadTask): Promise<void> {
  const response = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}/file`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "保存文件失败");
  }

  const blob = await response.blob();
  const filename = getFilenameFromContentDisposition(response.headers.get("content-disposition")) || `${task.title}-${task.artist}.mp3`;
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

export async function getPlaylists(): Promise<UserPlaylist[]> {
  const response = await apiFetch("/api/playlists");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单失败");
  }
  const data = (await response.json()) as { playlists: UserPlaylist[] };
  return data.playlists;
}

export async function getPlaylistSongs(playlistId: string, page = 1, limit = 100, keyword = ""): Promise<PlaylistSongsPage> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit)
  });
  if (keyword.trim()) {
    params.set("keyword", keyword.trim());
  }
  const response = await apiFetch(`/api/playlists/${encodeURIComponent(playlistId)}/songs?${params.toString()}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单歌曲失败");
  }
  return (await response.json()) as PlaylistSongsPage;
}

export async function getCloudSongs(): Promise<{ songs: Song[]; count: number; size: number; maxSize: number }> {
  const response = await apiFetch("/api/cloud/songs");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取云盘音乐失败");
  }

  return (await response.json()) as { songs: Song[]; count: number; size: number; maxSize: number };
}

export async function getDailyRecommendSongs(): Promise<Song[]> {
  const response = await apiFetch("/api/recommend/daily");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取每日推荐失败");
  }

  const data = (await response.json()) as { songs: Song[] };
  return data.songs;
}

export async function getLyrics(songId: string): Promise<SongLyrics> {
  const response = await apiFetch(`/api/lyrics/${encodeURIComponent(songId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌词失败");
  }

  const data = (await response.json()) as { lyrics: SongLyrics };
  return data.lyrics;
}

export async function getArtistProfile(artistId: string): Promise<ArtistProfile> {
  const response = await apiFetch(`/api/artists/${encodeURIComponent(artistId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌手信息失败");
  }

  const data = (await response.json()) as { artist: ArtistProfile };
  return data.artist;
}

export async function getAlbumProfile(albumId: string): Promise<AlbumProfile> {
  const response = await apiFetch(`/api/albums/${encodeURIComponent(albumId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取专辑信息失败");
  }

  const data = (await response.json()) as { album: AlbumProfile };
  return data.album;
}

export async function getSongLiked(songId: string): Promise<boolean> {
  const response = await apiFetch(`/api/likes/${encodeURIComponent(songId)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取喜欢状态失败");
  }

  const data = (await response.json()) as { liked: boolean };
  return Boolean(data.liked);
}

export async function setSongLiked(songId: string, liked: boolean): Promise<boolean> {
  const response = await apiFetch(`/api/likes/${encodeURIComponent(songId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ liked })
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? (liked ? "加入喜欢失败" : "取消喜欢失败"));
  }

  const data = (await response.json()) as { liked: boolean };
  return Boolean(data.liked);
}

export async function resolveArtistByName(name: string): Promise<{ id: string; name: string }> {
  const response = await apiFetch(`/api/artists/resolve/by-name?name=${encodeURIComponent(name)}`);
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "解析歌手失败");
  }

  return (await response.json()) as { id: string; name: string };
}

export async function getSettings(): Promise<AppSettings> {
  const response = await apiFetch("/api/settings");
  if (!response.ok) {
    throw new Error("获取设置失败");
  }
  return (await response.json()) as AppSettings;
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const response = await apiFetch("/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(settings)
  });

  if (!response.ok) {
    throw new Error("保存设置失败");
  }

  return (await response.json()) as AppSettings;
}

export async function getAdminConfig(): Promise<AdminConfigView> {
  const response = await apiFetch("/api/admin/config");
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取高级控制配置失败");
  }

  return (await response.json()) as AdminConfigView;
}

export async function saveAdminConfig(config: AdminConfigUpdate): Promise<AdminConfigView> {
  const response = await apiFetch("/api/admin/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(config)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "保存高级控制配置失败");
  }

  return (await response.json()) as AdminConfigView;
}

export async function checkNeteaseCookie(cookie: string): Promise<NeteaseCookieCheckResult> {
  const response = await apiFetch("/api/settings/netease-cookie/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ cookie })
  });

  if (!response.ok) {
    throw new Error("检测 Cookie 失败");
  }

  return (await response.json()) as NeteaseCookieCheckResult;
}

export async function getSession(): Promise<AuthSession> {
  const response = await apiFetch("/api/account");
  if (!response.ok) {
    throw new Error("获取账号信息失败");
  }
  return (await response.json()) as AuthSession;
}

export async function loginAccount(payload: { accountName: string; vipEnabled: boolean; note: string }): Promise<AuthSession> {
  const response = await apiFetch("/api/account/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("登录失败");
  }

  return (await response.json()) as AuthSession;
}

export async function logoutAccount(): Promise<AuthSession> {
  const response = await apiFetch("/api/account/logout", {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error("退出登录失败");
  }

  return (await response.json()) as AuthSession;
}

export async function startNeteaseQrLogin(): Promise<NeteaseQrStartResult> {
  const response = await apiFetch("/api/account/netease/qr/start", {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "二维码登录初始化失败");
  }

  return (await response.json()) as NeteaseQrStartResult;
}

export async function checkNeteaseQrLogin(key: string): Promise<NeteaseQrCheckResult> {
  const response = await apiFetch(`/api/account/netease/qr/check?key=${encodeURIComponent(key)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "二维码登录状态检查失败");
  }

  return (await response.json()) as NeteaseQrCheckResult;
}

export async function sendNeteaseCaptcha(phone: string, countryCode = "86"): Promise<NeteaseCaptchaSendResult> {
  const response = await apiFetch("/api/account/netease/captcha/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phone, countryCode })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "验证码发送失败");
  }

  return (await response.json()) as NeteaseCaptchaSendResult;
}

export async function loginWithNeteaseCellphone(phone: string, captcha: string, countryCode = "86"): Promise<NeteaseCellphoneLoginResult> {
  const response = await apiFetch("/api/account/netease/cellphone/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ phone, captcha, countryCode })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "手机号登录失败");
  }

  return (await response.json()) as NeteaseCellphoneLoginResult;
}

export async function getSearchHistory(): Promise<string[]> {
  const response = await apiFetch("/api/history/search");
  if (!response.ok) {
    throw new Error("获取搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function saveSearchHistory(items: string[]): Promise<string[]> {
  const response = await apiFetch("/api/history/search", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    throw new Error("保存搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function removeSearchHistory(keyword: string): Promise<string[]> {
  const response = await apiFetch(`/api/history/search?keyword=${encodeURIComponent(keyword)}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error("删除搜索记录失败");
  }

  const data = (await response.json()) as { items: string[] };
  return data.items;
}

export async function getPlayHistory(): Promise<Song[]> {
  const response = await apiFetch("/api/history/play");
  if (!response.ok) {
    throw new Error("获取播放历史失败");
  }

  const data = (await response.json()) as { items: Song[] };
  return data.items;
}

export async function savePlayHistory(items: Song[]): Promise<Song[]> {
  const response = await apiFetch("/api/history/play", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ items })
  });

  if (!response.ok) {
    throw new Error("保存播放历史失败");
  }

  const data = (await response.json()) as { items: Song[] };
  return data.items;
}

export async function getPlayerState(): Promise<PersistedPlayerState> {
  const response = await apiFetch("/api/player-state");
  if (!response.ok) {
    throw new Error("获取播放器状态失败");
  }

  return (await response.json()) as PersistedPlayerState;
}

export async function savePlayerState(state: PersistedPlayerState): Promise<PersistedPlayerState> {
  const response = await apiFetch("/api/player-state", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(state)
  });

  if (!response.ok) {
    throw new Error("保存播放器状态失败");
  }

  return (await response.json()) as PersistedPlayerState;
}

export async function getPlaylistTransferJobs(): Promise<PlaylistTransferJob[]> {
  const response = await apiFetch("/api/playlist-transfer/jobs");
  if (!response.ok) {
    throw new Error("获取歌单互转任务失败");
  }

  const data = (await response.json()) as { jobs: PlaylistTransferJob[] };
  return data.jobs;
}

export async function createPlaylistTransferJob(payload: TransferImportRequest): Promise<PlaylistTransferJob> {
  const response = await apiFetch("/api/playlist-transfer/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "创建歌单互转任务失败");
  }

  return (await response.json()) as PlaylistTransferJob;
}

export async function startPlaylistTransferRunJob(payload: TransferImportRequest): Promise<PlaylistTransferRunJob> {
  const response = await apiFetch("/api/playlist-transfer/jobs/progress", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动歌单互转任务失败");
  }

  const data = (await response.json()) as { job: PlaylistTransferRunJob };
  return data.job;
}

export async function getPlaylistTransferRunJob(jobId: string): Promise<PlaylistTransferRunJob> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/progress/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单互转进度失败");
  }

  const data = (await response.json()) as { job: PlaylistTransferRunJob };
  return data.job;
}

export async function exportPlaylistTransferJob(jobId: string, format: TransferExportFormat): Promise<TransferExportResult> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/${encodeURIComponent(jobId)}/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ format })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出歌单互转报告失败");
  }

  return (await response.json()) as TransferExportResult;
}

export async function importPlaylistTransferToNetease(jobId: string, name: string): Promise<NeteaseTransferImportResult> {
  const response = await apiFetch(`/api/playlist-transfer/jobs/${encodeURIComponent(jobId)}/import/netease`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导入网易云歌单失败");
  }

  return (await response.json()) as NeteaseTransferImportResult;
}

export async function createNeteaseImportAudit(payload: NeteaseImportAuditRequest): Promise<NeteaseImportAudit> {
  const response = await apiFetch("/api/playlist-transfer/netease-import-audit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "网易云导入歌单清理失败");
  }

  return (await response.json()) as NeteaseImportAudit;
}

export async function startNeteaseImportAuditJob(payload: NeteaseImportAuditRequest): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch("/api/playlist-transfer/netease-import-audit/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动网易云导入歌单清理失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function getNeteaseImportAuditJob(jobId: string): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取网易云导入歌单清理进度失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function cancelNeteaseImportAuditJob(jobId: string): Promise<NeteaseImportAuditJob> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST"
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "取消网易云导入歌单清理失败");
  }

  const data = (await response.json()) as { job: NeteaseImportAuditJob };
  return data.job;
}

export async function exportNeteaseImportAuditJob(jobId: string, format: TransferExportFormat): Promise<TransferExportResult> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ format })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出网易云导入歌单清理结果失败");
  }

  return (await response.json()) as TransferExportResult;
}

export async function createNeteaseImportAuditPlayablePlaylist(jobId: string, name: string): Promise<NeteaseTransferImportResult> {
  const response = await apiFetch(`/api/playlist-transfer/netease-import-audit/jobs/${encodeURIComponent(jobId)}/import/playable`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name })
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "创建正常歌曲新歌单失败");
  }

  return (await response.json()) as NeteaseTransferImportResult;
}

export async function createPlaylistCompare(payload: PlaylistCompareRequest): Promise<PlaylistCompareResult> {
  const response = await apiFetch("/api/playlist-transfer/compare", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "歌单对比失败");
  }

  return (await response.json()) as PlaylistCompareResult;
}

export async function startPlaylistCompareJob(payload: PlaylistCompareRequest): Promise<PlaylistCompareJob> {
  const response = await apiFetch("/api/playlist-transfer/compare/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "启动歌单对比任务失败");
  }

  const data = (await response.json()) as { job: PlaylistCompareJob };
  return data.job;
}

export async function getPlaylistCompareJob(jobId: string): Promise<PlaylistCompareJob> {
  const response = await apiFetch(`/api/playlist-transfer/compare/jobs/${encodeURIComponent(jobId)}`);

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "获取歌单对比进度失败");
  }

  const data = (await response.json()) as { job: PlaylistCompareJob };
  return data.job;
}

export async function exportPlaylistCompare(payload: PlaylistCompareExportRequest): Promise<TransferExportResult> {
  const response = await apiFetch("/api/playlist-transfer/compare/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(data?.message ?? "导出歌单对比结果失败");
  }

  return (await response.json()) as TransferExportResult;
}
