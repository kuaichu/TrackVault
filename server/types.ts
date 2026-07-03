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

export type DownloadRequest = {
  song: Song;
  level: DownloadQualityLevel;
};
