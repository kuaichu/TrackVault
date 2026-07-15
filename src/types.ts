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

export type SongAvailabilityState = "available" | "vip" | "copyright" | "restricted";

export type SongCapability = {
  status: SongAvailabilityState;
  locked: boolean;
  label: string;
  reason: string;
};

export type SongAvailability = {
  playback: SongCapability;
  download: SongCapability;
};

export type SongArtist = {
  id?: string;
  name: string;
};

export type Song = {
  id: string;
  providerSongId?: string;
  title: string;
  artist: string;
  primaryArtistId?: string;
  artists?: SongArtist[];
  album: string;
  albumId?: string;
  mediaId?: string;
  coverUrl?: string;
  duration: string;
  quality: string;
  availableQualities: DownloadQualityOption[];
  availability?: SongAvailability;
  source: string;
};

export type PersonalRadioKind = "radar" | "roaming";

export type PlaybackMode = "sequential" | "shuffle" | "repeat-one" | "heartbeat";

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
  source: "lyric_new" | "lyric" | "qqmusic";
};

export type SongComment = {
  id: string;
  userId: string;
  nickname: string;
  avatarUrl?: string;
  content: string;
  timeText: string;
  time?: number;
  liked: boolean;
  likedCount: number;
  replyCount: number;
  replyContent?: string;
};

export type SongCommentRepliesPage = {
  songId: string;
  parentCommentId: string;
  replies: SongComment[];
  total: number;
  hasMore: boolean;
  nextTime?: number;
};

export type SongCommentsPage = {
  songId: string;
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  hotComments: SongComment[];
  comments: SongComment[];
};

export type SongAudioProbeMode = "playback" | "download";

export type SongAudioProbe = {
  songId: string;
  mode: SongAudioProbeMode;
  requestedLevel: DownloadQualityLevel;
  requestedLabel: string;
  actualLabel: string;
  actualLevel?: string | null;
  actualBitrate?: number | null;
  actualType?: string | null;
  actualDuration?: string | null;
  trial: boolean;
};

export type SongInsightTag = {
  label: string;
  values: string[];
};

export type SongInsight = {
  songId: string;
  listening: {
    playCount?: number;
    playCountText?: string;
    firstListenText?: string;
    recentListenText?: string;
    note?: string;
  };
  encyclopedia: {
    tags: SongInsightTag[];
    sourceText?: string;
    releaseText?: string;
    originText?: string;
  };
};

export type UserProfilePlaylist = {
  id: string;
  name: string;
  coverUrl?: string;
  trackCount: number;
  playCount: number;
  owned: boolean;
};

export type UserProfile = {
  id: string;
  nickname: string;
  avatarUrl?: string;
  backgroundUrl?: string;
  signature: string;
  level: number;
  listenSongs: number;
  follows: number;
  followeds: number;
  eventCount: number;
  playlistCount: number;
  gender: "male" | "female" | "unknown";
  province?: number;
  city?: number;
  ageText?: string;
  createdAtText?: string;
  vipType?: number;
  playlists: UserProfilePlaylist[];
};

export type UserSocialListKind = "follows" | "followeds";

export type UserSocialUser = {
  id: string;
  nickname: string;
  avatarUrl?: string;
  signature: string;
  followed: boolean;
  mutual: boolean;
  followeds: number;
  follows: number;
};

export type UserSocialPage = {
  userId: string;
  kind: UserSocialListKind;
  users: UserSocialUser[];
  page: number;
  limit: number;
  total?: number;
  hasMore: boolean;
};

export type UserEventResourceType = "song" | "playlist" | "album" | "video" | "resource";

export type UserEventResource = {
  type: UserEventResourceType;
  id: string;
  title: string;
  subtitle?: string;
  coverUrl?: string;
};

export type UserEventItem = {
  id: string;
  userId: string;
  nickname: string;
  avatarUrl?: string;
  text: string;
  timeText: string;
  time?: number;
  type?: number;
  pics: string[];
  resource?: UserEventResource;
  likedCount: number;
  commentCount: number;
  shareCount: number;
};

export type UserEventsPage = {
  userId: string;
  events: UserEventItem[];
  lasttime?: number;
  hasMore: boolean;
};

export type UserFollowActionResult = {
  userId: string;
  followed: boolean;
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

export type PlaylistTrackAddResult = {
  playlistId: string;
  playlistName: string;
  songId: string;
  addedCount: number;
};

export type PlaylistTrackRemoveResult = {
  playlistId: string;
  playlistName: string;
  songIds: string[];
  removedCount: number;
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
  providerMode: "demo" | "netease" | "qq" | "aggregate";
  downloadDirectory: string;
  neteaseCookie: string;
  qqMusicCookie?: string;
  notes: string;
  defaultPlaybackQuality: DownloadQualityLevel;
  defaultDownloadQuality: DownloadQualityLevel;
  maxConcurrentDownloads: number;
  startupView: "discover" | "search" | "playlists" | "downloads";
  autoLoadDiscoverOnStart: boolean;
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
  vipExpireAt?: number;
  vipExpireText?: string;
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
  playbackMode?: PlaybackMode;
};

export type NeteaseCookieCheckResult = {
  ok: boolean;
  accountName: string | null;
  message: string;
};

export type QqMusicCookieCheckResult = {
  ok: boolean;
  uin: string | null;
  message: string;
  refreshedCookie?: string;
};

export type QqMusicAccountStatus = {
  ok: boolean;
  uin: string | null;
  displayName: string | null;
  avatarUrl?: string;
  vipEnabled: boolean;
  vipType?: number | string;
  vipExpireAt?: number;
  vipExpireText?: string;
  message: string;
};

export type QqMusicQrStartResult = {
  key: string;
  qrImage: string;
};

export type QqMusicQrCheckResult = {
  code: number;
  message: string;
  cookie?: string;
  account?: QqMusicAccountStatus;
};

export type QqMusicProfileAlbum = {
  id: string;
  name: string;
  coverUrl?: string;
  artistName: string;
  songCount: number;
  publishTime?: string;
};

export type QqMusicProfileSinger = {
  id: string;
  name: string;
  avatarUrl?: string;
  fanCount: number;
  songCount: number;
};

export type QqMusicProfileUser = {
  id: string;
  nickname: string;
  avatarUrl?: string;
  signature: string;
  fanCount: number;
  followed: boolean;
};

export type QqMusicProfileIssue = {
  section: string;
  message: string;
};

export type QqMusicUserProfile = {
  account: QqMusicAccountStatus;
  detail: {
    signature: string;
    level?: number;
    listenSongs?: number;
    locationText?: string;
    ageText?: string;
  };
  stats: {
    createdPlaylists: number;
    collectedPlaylists: number;
    collectedAlbums: number;
    followSingers: number;
    followUsers: number;
    fans: number;
  };
  createdPlaylists: UserPlaylist[];
  collectedPlaylists: UserPlaylist[];
  collectedAlbums: QqMusicProfileAlbum[];
  followSingers: QqMusicProfileSinger[];
  followUsers: QqMusicProfileUser[];
  fans: QqMusicProfileUser[];
  issues: QqMusicProfileIssue[];
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

export type PlaylistTransferRunJobStatus = "queued" | "loading" | "running" | "saving" | "completed" | "failed";

export type PlaylistTransferRunJob = {
  id: string;
  status: PlaylistTransferRunJobStatus;
  input: TransferImportRequest & {
    ownerKey: string;
  };
  progress: {
    phase: "queued" | "loading" | "matching" | "saving" | "completed" | "failed";
    processed: number;
    total: number;
    matched: number;
    manualReview: number;
    notFound: number;
    unavailable: number;
    duplicate: number;
    skipped: number;
    currentTitle?: string;
  };
  result?: PlaylistTransferJob;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type TransferImportRequest = {
  sourceProvider: TransferSourceProvider;
  targetProvider: TransferTargetProvider;
  playlistName?: string;
  playlistId?: string;
  sourceTrackIds?: string[];
  sourceTracks?: TransferTrack[];
  text?: string;
  checkAvailability?: boolean;
};

export type TransferExportResult = {
  filename: string;
  contentType: string;
  content: string;
};

export type PlaylistTransferImportResult = {
  playlistId: string;
  playlistName?: string;
  playlistUrl?: string;
  addedCount: number;
  skippedCount: number;
};

export type NeteaseTransferImportResult = PlaylistTransferImportResult;
export type QqTransferImportResult = PlaylistTransferImportResult;

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
    playable: number;
    suspect: number;
    replaceable: number;
    needsReview: number;
    unusable: number;
  };
  playableTrackIds: string[];
  playableTextPlaylist: string;
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

export type NeteaseImportAuditJobStatus = "queued" | "loading" | "running" | "cancelling" | "cancelled" | "completed" | "failed";

export type NeteaseImportAuditJob = {
  id: string;
  status: NeteaseImportAuditJobStatus;
  input: {
    playlistId: string;
    playlistName: string;
    maxTracks: number;
    candidateLimit: number;
    checkAvailability: boolean;
  };
  progress: {
    phase: "queued" | "loading" | "scanning" | "completed" | "failed" | "cancelled";
    scanned: number;
    total: number;
    suspect: number;
    replaceable: number;
    needsReview: number;
    unusable: number;
    currentTitle?: string;
  };
  result?: NeteaseImportAudit;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
  itemIndexes?: number[];
  preferredProvider?: "netease" | "qq";
};

export type PlaylistCompareJobStatus = "queued" | "loading" | "running" | "completed" | "failed";

export type PlaylistCompareJob = {
  id: string;
  status: PlaylistCompareJobStatus;
  input: PlaylistCompareRequest;
  progress: {
    phase: "queued" | "loading" | "comparing" | "completed" | "failed";
    processed: number;
    total: number;
    exact: number;
    sameTitleDifferentArtist: number;
    similarTitle: number;
    leftOnly: number;
    rightOnly: number;
    currentTitle?: string;
  };
  result?: PlaylistCompareResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
