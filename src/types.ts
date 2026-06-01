export type DownloadQualityLevel =
  | "standard"
  | "exhigh"
  | "lossless"
  | "hires"
  | "jyeffect"
  | "jymaster"
  | "sky";

export type DownloadQualityOption = {
  level: DownloadQualityLevel;
  label: string;
};

export type SongArtist = {
  id?: string;
  name: string;
};

export type Song = {
  id: string;
  title: string;
  artist: string;
  primaryArtistId?: string;
  artists?: SongArtist[];
  album: string;
  albumId?: string;
  coverUrl?: string;
  duration: string;
  quality: string;
  availableQualities: DownloadQualityOption[];
  source: string;
};

export type ArtistProfile = {
  id: string;
  name: string;
  avatarUrl?: string;
  coverUrl?: string;
  description: string;
  musicCount: number;
  albumCount: number;
  mvCount: number;
  topSongs: Song[];
};

export type AlbumProfile = {
  id: string;
  name: string;
  coverUrl?: string;
  description: string;
  artist: string;
  artistId?: string;
  company?: string;
  publishDate?: string;
  trackCount: number;
  likedCount?: number;
  commentCount?: number;
  shareCount?: number;
  songs: Song[];
};

export type LyricLine = {
  time: number;
  text: string;
  translation?: string;
};

export type SongLyrics = {
  songId: string;
  lines: LyricLine[];
  source: "lyric_new" | "lyric";
};

export type UserPlaylist = {
  id: string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  creatorName: string;
  playCount: number;
  owned: boolean;
};

export type PlaylistSongsPage = {
  songs: Song[];
  page: number;
  limit: number;
  hasMore: boolean;
  total: number;
  sourceTotal?: number;
  keyword?: string;
};

export type DownloadTaskStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "done"
  | "failed";

export type DownloadTask = {
  id: string;
  songId: string;
  title: string;
  artist: string;
  quality: string;
  requestedLevel?: DownloadQualityLevel;
  retryCount?: number;
  retryLimit?: number;
  progress: number;
  status: DownloadTaskStatus;
  outputPath?: string;
  downloadedDuration?: string;
  fileSizeBytes?: number;
  error?: string;
  createdAt: string;
};

export type AppSettings = {
  accountName: string;
  vipEnabled: boolean;
  providerMode: "demo" | "netease";
  downloadDirectory: string;
  neteaseCookie: string;
  notes: string;
  defaultPlaybackQuality: DownloadQualityLevel;
  defaultDownloadQuality: DownloadQualityLevel;
  maxConcurrentDownloads: number;
};

export type AdminConfigView = {
  trustedUserWhitelistText: string;
  hasSystemDefaultToken: boolean;
  systemFallbackEnabled: boolean;
};

export type AdminConfigUpdate = {
  trustedUserWhitelistText: string;
  systemDefaultToken?: string;
  systemFallbackEnabled: boolean;
};

export type AccountProfile = {
  id: string;
  displayName: string;
  level: number;
  vipEnabled: boolean;
  vipType?: number;
  avatarUrl?: string;
  avatarSeed: string;
  provider: "demo" | "netease";
  bio: string;
  favoriteGenres: string[];
  lastLoginAt: string;
};

export type AuthSession = {
  loggedIn: boolean;
  profile: AccountProfile | null;
};

export type PersistedPlayerState = {
  currentTrack: Song | null;
  playQueue: Song[];
  playbackSeconds: number;
  volume: number;
  playbackMode?: "sequential" | "shuffle";
};

export type NeteaseCookieCheckResult = {
  ok: boolean;
  accountName: string | null;
  message: string;
};

export type NeteaseQrStartResult = {
  key: string;
  qrImage: string;
  qrUrl: string;
};

export type NeteaseQrCheckResult = {
  code: number;
  message: string;
  cookie?: string;
  session?: AuthSession;
};

export type NeteaseCaptchaSendResult = {
  code: number;
  message: string;
  sent: boolean;
};

export type NeteaseCellphoneLoginResult = {
  code: number;
  message: string;
  cookie?: string;
  session?: AuthSession;
};

export type DownloadRequest = {
  song: Song;
  level: DownloadQualityLevel;
};

export type TransferSourceProvider = "netease" | "qq" | "text" | "csv";
export type TransferTargetProvider = "netease" | "qq" | "text";
export type TransferExportFormat = "markdown" | "text" | "csv" | "json";

export type TransferTrackStatus =
  | "matched"
  | "manual_review"
  | "not_found"
  | "copyright_unavailable"
  | "vip_only"
  | "trial_only"
  | "duplicate"
  | "metadata_conflict"
  | "skipped";

export type TransferTrack = {
  source: TransferSourceProvider;
  sourceTrackId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  rawText?: string;
};

export type MatchCandidate = {
  provider: "netease" | "qq";
  targetTrackId: string;
  title: string;
  artists: string[];
  album?: string;
  durationSeconds?: number;
  availability?: {
    status: "available" | "copyright_unavailable" | "vip_only" | "trial_only";
    reason?: string;
  };
  confidenceScore: number;
  reasons: string[];
};

export type TransferTrackResult = {
  sourceTrack: TransferTrack;
  status: TransferTrackStatus;
  candidates: MatchCandidate[];
  selectedCandidate?: MatchCandidate;
  reason?: string;
};

export type TransferSummary = {
  total: number;
  matched: number;
  manualReview: number;
  notFound: number;
  unavailable: number;
  duplicate: number;
  skipped: number;
};

export type PlaylistTransferJob = {
  id: string;
  ownerKey: string;
  sourceProvider: TransferSourceProvider;
  targetProvider: TransferTargetProvider;
  playlistName: string;
  tracks: TransferTrackResult[];
  summary: TransferSummary;
  createdAt: string;
  updatedAt: string;
};

export type TransferImportRequest = {
  sourceProvider: TransferSourceProvider;
  targetProvider: TransferTargetProvider;
  playlistName?: string;
  playlistId?: string;
  text?: string;
  checkAvailability?: boolean;
};

export type TransferExportResult = {
  filename: string;
  contentType: string;
  content: string;
};

export type NeteaseTransferImportResult = {
  playlistId: string;
  addedCount: number;
  skippedCount: number;
};

export type NeteaseImportAuditStatus = "replaceable" | "needs_review" | "unusable";

export type NeteaseImportAuditItem = {
  originalTrackId: string;
  sourceTrack: TransferTrack;
  unusableReason: string;
  status: NeteaseImportAuditStatus;
  candidates: MatchCandidate[];
  selectedCandidate?: MatchCandidate;
  reason?: string;
};

export type NeteaseImportAudit = {
  playlistId: string;
  playlistName: string;
  scannedCount: number;
  summary: {
    total: number;
    suspect: number;
    replaceable: number;
    needsReview: number;
    unusable: number;
  };
  items: NeteaseImportAuditItem[];
  textPlaylist: string;
  unusableText: string;
  markdownReport: string;
};

export type NeteaseImportAuditRequest = {
  playlistId: string;
  playlistName?: string;
  maxTracks?: number;
  candidateLimit?: number;
  checkAvailability?: boolean;
};

export type PlaylistCompareStatus =
  | "exact"
  | "same_title_different_artist"
  | "similar_title"
  | "left_only"
  | "right_only";

export type PlaylistCompareItem = {
  status: PlaylistCompareStatus;
  leftTrack?: TransferTrack;
  rightTrack?: TransferTrack;
  score: number;
  reasons: string[];
};

export type PlaylistCompareResult = {
  left: {
    provider: TransferSourceProvider;
    playlistId?: string;
    playlistName: string;
    total: number;
  };
  right: {
    provider: TransferSourceProvider;
    playlistId?: string;
    playlistName: string;
    total: number;
  };
  items: PlaylistCompareItem[];
  summary: {
    totalLeft: number;
    totalRight: number;
    exact: number;
    sameTitleDifferentArtist: number;
    similarTitle: number;
    leftOnly: number;
    rightOnly: number;
  };
  createdAt: string;
};

export type PlaylistCompareRequest = {
  leftProvider: "netease" | "qq";
  leftPlaylistId: string;
  leftPlaylistName?: string;
  rightProvider: "netease" | "qq";
  rightPlaylistId: string;
  rightPlaylistName?: string;
};

export type PlaylistCompareExportRequest = {
  result: PlaylistCompareResult;
  format: TransferExportFormat;
  statuses: PlaylistCompareStatus[];
};
