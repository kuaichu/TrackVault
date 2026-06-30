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
  providerMode: "demo" | "netease";
  downloadDirectory: string;
  neteaseCookie: string;
  notes: string;
  defaultPlaybackQuality: DownloadQualityLevel;
  defaultDownloadQuality: DownloadQualityLevel;
  maxConcurrentDownloads: number;
};

export type AdminConfig = {
  trustedUserWhitelist: string[];
  systemDefaultToken: string;
  systemFallbackEnabled: boolean;
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

export type DownloadRequest = {
  song: Song;
  level: DownloadQualityLevel;
};
