import type {
  AlbumDetail,
  ArtistDetail,
  AuthStatus,
  ChartDetail,
  ChartSummary,
  CloudTracksPage,
  CompareStatus,
  CreateDownloadJobInput,
  CreateMemberInput,
  EntitySearchResult,
  EntitySearchType,
  ExportFormat,
  ExportPayload,
  JobKind,
  JobView,
  LoginInput,
  MusicPlatform,
  PlatformBindingView,
  PlayerState,
  PlaylistSort,
  PlaylistSummary,
  PlaylistTracksPage,
  ProviderCapabilities,
  ProviderMode,
  QrCheckResult,
  QrStartResult,
  QualityLevel,
  SetupAdminInput,
  Song,
  SongAudioProbe,
  SongCommentsPage,
  SongLyrics,
  StartCompareInput,
  StartImportAuditInput,
  StartTransferInput,
  SystemFallbackView,
  UpdateMemberInput,
  UpdateSystemFallbackInput,
  UpdateTransferSelectionInput,
  UpdateUserSettingsInput,
  UserSettings,
  UserSummary,
} from "#shared";
import { apiRequest } from "./http-client.js";

export const api = {
  // Auth & Members
  getAuthStatus: (signal?: AbortSignal) => apiRequest<AuthStatus>("/api/auth/status", { signal }),
  setupAdmin: (input: SetupAdminInput) =>
    apiRequest<{ user: UserSummary }>("/api/auth/setup", { method: "POST", body: input }),
  login: (input: LoginInput) =>
    apiRequest<{ user: UserSummary }>("/api/auth/login", { method: "POST", body: input }),
  logout: () => apiRequest<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  listMembers: () => apiRequest<{ members: UserSummary[] }>("/api/admin/members"),
  createMember: (input: CreateMemberInput) =>
    apiRequest<{ member: UserSummary }>("/api/admin/members", { method: "POST", body: input }),
  updateMember: (id: string, input: UpdateMemberInput) =>
    apiRequest<{ member: UserSummary }>(`/api/admin/members/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: input,
    }),
  deleteMember: (id: string) =>
    apiRequest<{ ok: boolean }>(`/api/admin/members/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listSystemFallbacks: () =>
    apiRequest<{ fallbacks: Record<MusicPlatform, SystemFallbackView> }>("/api/admin/fallbacks"),
  saveSystemFallback: (platform: MusicPlatform, input: UpdateSystemFallbackInput) =>
    apiRequest<{ fallback: SystemFallbackView }>(`/api/admin/fallbacks/${platform}`, {
      method: "PUT",
      body: input,
    }),

  // Platform Bindings
  listBindings: () => apiRequest<{ bindings: Record<MusicPlatform, PlatformBindingView> }>("/api/bindings"),
  bindPlatformCookie: (platform: MusicPlatform, cookie: string) =>
    apiRequest<{ binding: PlatformBindingView }>(`/api/bindings/${platform}/cookie`, {
      method: "POST",
      body: { cookie },
    }),
  unbindPlatform: (platform: MusicPlatform) =>
    apiRequest<{ binding: PlatformBindingView }>(`/api/bindings/${platform}`, { method: "DELETE" }),
  startQrLogin: (platform: MusicPlatform) =>
    apiRequest<QrStartResult>(`/api/bindings/${platform}/qr/start`, { method: "POST" }),
  checkQrLogin: (platform: MusicPlatform, key: string, signal?: AbortSignal) =>
    apiRequest<QrCheckResult>(`/api/bindings/${platform}/qr/check?key=${encodeURIComponent(key)}`, {
      signal,
    }),

  // Capabilities & Catalog
  getCapabilities: () =>
    apiRequest<{ capabilities: Record<MusicPlatform, ProviderCapabilities> }>("/api/capabilities"),
  searchSongs: (q: string, mode: ProviderMode, signal?: AbortSignal) =>
    apiRequest<{ results: Song[]; mode: ProviderMode; warnings: string[] }>(
      `/api/search?q=${encodeURIComponent(q)}&mode=${mode}`,
      { signal },
    ),
  searchEntities: (q: string, mode: ProviderMode, type: EntitySearchType, signal?: AbortSignal) =>
    apiRequest<EntitySearchResult>(
      `/api/search/entities?q=${encodeURIComponent(q)}&mode=${mode}&type=${type}`,
      { signal },
    ),
  getDiscover: (platform?: MusicPlatform) =>
    apiRequest<{ songs: Song[] }>(platform ? `/api/discover?platform=${platform}` : "/api/discover"),
  getRecommendedPlaylists: (platform: MusicPlatform) =>
    apiRequest<{ playlists: PlaylistSummary[] }>(`/api/discover/playlists?platform=${platform}`),
  getCharts: (platform: MusicPlatform) =>
    apiRequest<{ charts: ChartSummary[] }>(`/api/charts?platform=${platform}`),
  getChartDetail: (platform: MusicPlatform, id: string) =>
    apiRequest<ChartDetail>(`/api/charts/${platform}/${encodeURIComponent(id)}`),
  getArtistDetail: (platform: MusicPlatform, id: string) =>
    apiRequest<{ artist: ArtistDetail }>(`/api/artists/${platform}/${encodeURIComponent(id)}`),
  getAlbumDetail: (platform: MusicPlatform, id: string) =>
    apiRequest<{ album: AlbumDetail }>(`/api/albums/${platform}/${encodeURIComponent(id)}`),
  getPersonalFm: (signal?: AbortSignal) => apiRequest<{ songs: Song[] }>("/api/fm", { signal }),
  getDailyRecommend: () => apiRequest<{ songs: Song[] }>("/api/recommend/daily"),
  getCloudSongs: (params?: { offset?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return apiRequest<CloudTracksPage>(query ? `/api/cloud/songs?${query}` : "/api/cloud/songs");
  },
  getUserPlaylists: (platform: MusicPlatform) =>
    apiRequest<{ playlists: PlaylistSummary[] }>(`/api/playlists?platform=${platform}`),
  createPlaylist: (platform: MusicPlatform, name: string, trackIds: string[] = []) =>
    apiRequest<{
      playlistId: string;
      playlistName: string;
      playlistUrl: string;
      addedCount: number;
    }>(`/api/playlists/${platform}`, { method: "POST", body: { name, trackIds } }),
  getPlaylistTracks: (
    platform: MusicPlatform,
    id: string,
    params: { page?: number; limit?: number; keyword?: string; sort?: PlaylistSort } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set("page", String(params.page));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.keyword) qs.set("keyword", params.keyword);
    if (params.sort) qs.set("sort", params.sort);
    return apiRequest<PlaylistTracksPage>(
      `/api/playlists/${platform}/${encodeURIComponent(id)}/songs?${qs.toString()}`,
    );
  },
  addTracksToPlaylist: (platform: MusicPlatform, id: string, trackIds: string[]) =>
    apiRequest<{ addedCount: number }>(`/api/playlists/${platform}/${encodeURIComponent(id)}/tracks`, {
      method: "POST",
      body: { trackIds },
    }),
  removeTracksFromPlaylist: (platform: MusicPlatform, id: string, trackIds: string[]) =>
    apiRequest<{ removedCount: number }>(`/api/playlists/${platform}/${encodeURIComponent(id)}/tracks`, {
      method: "DELETE",
      body: { trackIds },
    }),
  getLyrics: (platform: MusicPlatform, id: string, mediaId?: string) => {
    const qs = mediaId ? `?mediaId=${encodeURIComponent(mediaId)}` : "";
    return apiRequest<{ lyrics: SongLyrics }>(`/api/lyrics/${platform}/${encodeURIComponent(id)}${qs}`);
  },
  getComments: (platform: MusicPlatform, id: string, page = 1, limit = 20) =>
    apiRequest<SongCommentsPage>(
      `/api/comments/${platform}/${encodeURIComponent(id)}?page=${page}&limit=${limit}`,
    ),
  setCommentLiked: (platform: MusicPlatform, songId: string, commentId: string, liked: boolean) =>
    apiRequest<{ liked: boolean }>(
      `/api/comments/${platform}/${encodeURIComponent(songId)}/${encodeURIComponent(commentId)}/like`,
      { method: "POST", body: { liked } },
    ),
  getLikedSongIds: (platform: MusicPlatform) => apiRequest<{ ids: string[] }>(`/api/likes/${platform}`),
  isSongLiked: (platform: MusicPlatform, id: string) =>
    apiRequest<{ liked: boolean }>(`/api/likes/${platform}/${encodeURIComponent(id)}`),
  toggleSongLike: (platform: MusicPlatform, id: string, liked: boolean) =>
    apiRequest<{ liked: boolean }>(`/api/likes/${platform}/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { liked },
    }),

  // Media & Downloads
  buildStreamUrl: (song: Song, level: QualityLevel): string => {
    const qs = new URLSearchParams({
      platform: song.platform,
      id: song.id,
      level,
      durationSeconds: String(song.durationSeconds),
    });
    if (song.mediaId) qs.set("mediaId", song.mediaId);
    return `/api/media/stream?${qs.toString()}`;
  },
  probeAudio: (song: Song, level: QualityLevel, mode: "playback" | "download") =>
    apiRequest<{ probe: SongAudioProbe }>("/api/media/probe", {
      method: "POST",
      body: {
        platform: song.platform,
        id: song.id,
        mediaId: song.mediaId,
        durationSeconds: song.durationSeconds,
        level,
        mode,
      },
    }),
  createDownloadJob: (input: CreateDownloadJobInput) =>
    apiRequest<{ job: JobView }>("/api/downloads", { method: "POST", body: input }),

  // Unified Jobs & Transfer
  listJobs: (kind?: JobKind) =>
    apiRequest<{ jobs: JobView[] }>(kind ? `/api/jobs?kind=${kind}` : "/api/jobs"),
  getJob: (id: string) => apiRequest<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) =>
    apiRequest<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  clearFinishedJobs: (kind?: JobKind) =>
    apiRequest<{ removedCount: number }>(kind ? `/api/jobs/finished?kind=${kind}` : "/api/jobs/finished", {
      method: "DELETE",
    }),
  getJobDownloadFileUrl: (id: string) => `/api/jobs/${encodeURIComponent(id)}/file`,

  startTransferJob: (input: StartTransferInput) =>
    apiRequest<{ job: JobView }>("/api/transfer/jobs", { method: "POST", body: input }),
  startImportAuditJob: (input: StartImportAuditInput) =>
    apiRequest<{ job: JobView }>("/api/transfer/audit/jobs", { method: "POST", body: input }),
  startCompareJob: (input: StartCompareInput) =>
    apiRequest<{ job: JobView }>("/api/transfer/compare/jobs", { method: "POST", body: input }),
  exportTransferJob: (id: string, format: ExportFormat, statuses?: CompareStatus[]) =>
    apiRequest<ExportPayload>(`/api/transfer/jobs/${encodeURIComponent(id)}/export`, {
      method: "POST",
      body: { format, statuses },
    }),
  updateTransferSelection: (id: string, input: UpdateTransferSelectionInput) =>
    apiRequest<{ job: JobView }>(`/api/transfer/jobs/${encodeURIComponent(id)}/selection`, {
      method: "PATCH",
      body: input,
    }),
  importTransferJob: (id: string, input: { name?: string; existingPlaylistId?: string }) =>
    apiRequest<{
      playlistId: string;
      playlistName: string;
      playlistUrl: string;
      addedCount: number;
      skippedCount: number;
    }>(`/api/transfer/jobs/${encodeURIComponent(id)}/import`, {
      method: "POST",
      body: input,
    }),

  // Settings, PlayerState & History
  getSettings: () => apiRequest<{ settings: UserSettings }>("/api/settings"),
  updateSettings: (patch: UpdateUserSettingsInput) =>
    apiRequest<{ settings: UserSettings }>("/api/settings", { method: "PATCH", body: patch }),
  getPlayerState: () => apiRequest<{ state: PlayerState }>("/api/player-state"),
  savePlayerState: (state: PlayerState, options?: { keepalive?: boolean }) =>
    apiRequest<{ state: PlayerState }>("/api/player-state", {
      method: "PUT",
      body: state,
      keepalive: options?.keepalive,
    }),
  getPlayHistory: () => apiRequest<{ items: Song[] }>("/api/history/play"),
  recordPlayHistory: (song: Song) =>
    apiRequest<{ items: Song[] }>("/api/history/play", { method: "POST", body: { song } }),
  clearPlayHistory: () => apiRequest<{ items: Song[] }>("/api/history/play", { method: "DELETE" }),
  getSearchHistory: () => apiRequest<{ items: string[] }>("/api/history/search"),
  addSearchHistory: (keyword: string) =>
    apiRequest<{ items: string[] }>("/api/history/search", { method: "POST", body: { keyword } }),
  removeSearchHistory: (keyword?: string) =>
    apiRequest<{ items: string[] }>(
      keyword ? `/api/history/search?keyword=${encodeURIComponent(keyword)}` : "/api/history/search",
      { method: "DELETE" },
    ),
};
