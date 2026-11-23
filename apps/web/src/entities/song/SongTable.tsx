import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Disc3,
  Download,
  FolderPlus,
  Heart,
  ListEnd,
  ListPlus,
  Loader2,
  Lock,
  MoreHorizontal,
  Play,
  Trash2,
  User,
} from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type DownloadMode,
  type QualityLevel,
  type Song,
  getQualityLabel,
  getSongKey,
  sanitizeExternalUrl,
} from "#shared";
import { audioEngine } from "../../features/player/engine/audio-engine.js";
import { usePlayerStore } from "../../features/player/store/player-store.js";
import { api } from "../../shared/api/endpoints.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { trackPendingDirectLinkJob } from "../../shared/hooks/use-job-events.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../../shared/hooks/use-toggle-like.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, EqualizerBars, PlatformBadge } from "../../shared/ui/primitives.js";
import { AlbumLink, ArtistLinks } from "../music/EntityLinks.js";

const BUTTON_DBLCLICK_GUARD_MS = 1000;

interface SongTableProps {
  songs: Song[];
  emptyText?: string;
  emptyDescription?: string;
  onRemoveTrack?: (song: Song) => void;
  showHeaderMeta?: boolean;
  indexOffset?: number;
}

export function SongTable({
  songs,
  emptyText = "暂无歌曲",
  emptyDescription,
  onRemoveTrack,
  showHeaderMeta = true,
  indexOffset = 0,
}: SongTableProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const capabilities = useCapabilities();
  const canLikeNetease = capabilities.netease.canLikeSong && songs.some((s) => s.platform === "netease");
  const canLikeQq = capabilities.qq.canLikeSong && songs.some((s) => s.platform === "qq");

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const { data: neteaseLikedIdsData } = useLikedIdsQuery("netease", canLikeNetease);
  const { data: qqLikedIdsData } = useLikedIdsQuery("qq", canLikeQq);

  const [downloadMode, setDownloadMode] = useState<DownloadMode>("tagged_server");
  const [pendingDownloadKeys, setPendingDownloadKeys] = useState<Set<string>>(() => new Set());
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [menuPanel, setMenuPanel] = useState<"main" | "playlists" | "quality">("main");
  const [menuUpward, setMenuUpward] = useState(false);

  const lastButtonPlayRef = useRef<{ key: string; at: number } | null>(null);
  const lastZeroDetailPlayRef = useRef<{ key: string; at: number } | null>(null);

  // P15: Honor UIEvent.detail semantics so OS double-clicks at ANY speed (e.g. 650ms, detail=2) never play twice,
  // while independent single pointer clicks (detail === 1) ALWAYS respond even when 420ms apart.
  const handlePlayButtonClick = (e: MouseEvent<HTMLButtonElement>, song: Song) => {
    if (e.detail > 1) {
      return;
    }
    const songKey = getSongKey(song);
    const now = Date.now();
    if (e.detail === 0) {
      const prevZero = lastZeroDetailPlayRef.current;
      if (prevZero && prevZero.key === songKey && now - prevZero.at < 550) {
        return;
      }
      lastZeroDetailPlayRef.current = { key: songKey, at: now };
    }
    lastButtonPlayRef.current = { key: songKey, at: now };
    void audioEngine.playTrack(song, { queue: songs });
  };

  const activeMenuSong = openMenuKey
    ? songs.find((s, i) => `${getSongKey(s)}-${i}` === openMenuKey)
    : undefined;
  const playlistMenuPlatform = activeMenuSong?.platform;

  const userPlaylistsQuery = useQuery({
    queryKey: ["playlists", playlistMenuPlatform],
    queryFn: () =>
      playlistMenuPlatform ? api.getUserPlaylists(playlistMenuPlatform) : Promise.resolve({ playlists: [] }),
    enabled: Boolean(
      openMenuKey &&
        menuPanel === "playlists" &&
        playlistMenuPlatform &&
        capabilities[playlistMenuPlatform].canManagePlaylistTracks,
    ),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!openMenuKey) return;
    const onPointerDown = () => {
      setOpenMenuKey(null);
      setMenuPanel("main");
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [openMenuKey]);

  const likedSets = {
    netease: new Set(neteaseLikedIdsData?.ids ?? []),
    qq: new Set(qqLikedIdsData?.ids ?? []),
  };
  const defaultDownloadQuality = settingsData?.settings.defaultDownloadQuality ?? "lossless";

  const downloadMutation = useMutation({
    mutationFn: (payload: { song: Song; level: QualityLevel; mode: DownloadMode }) =>
      api.createDownloadJob(payload),
    onMutate: (vars) => {
      const songKey = getSongKey(vars.song);
      setPendingDownloadKeys((prev) => {
        const next = new Set(prev);
        next.add(songKey);
        return next;
      });
    },
    onSuccess: (res, vars) => {
      if (vars.mode === "direct_link") {
        const safeDirectUrl = sanitizeExternalUrl(res.job.directUrl);
        if (safeDirectUrl) {
          toast.success(`直链已就绪：${vars.song.title}（${getQualityLabel(vars.level)}）`, {
            action: { label: "打开直链", href: safeDirectUrl },
          });
        } else {
          const alreadyResolvedViaSse = trackPendingDirectLinkJob(res.job.id, {
            queryClient,
            fallbackTitle: `${vars.song.title}（${getQualityLabel(vars.level)}）`,
          });
          if (!alreadyResolvedViaSse) {
            toast.success(`正在解析直链：${vars.song.title}（${getQualityLabel(vars.level)}）`);
          }
        }
      } else {
        toast.success(`已加入下载：${vars.song.title}（${getQualityLabel(vars.level)}）`);
      }
      void queryClient.invalidateQueries({ queryKey: ["jobs", "download"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "加入下载队列失败");
    },
    onSettled: (_data, _error, vars) => {
      const songKey = getSongKey(vars.song);
      setPendingDownloadKeys((prev) => {
        if (!prev.has(songKey)) return prev;
        const next = new Set(prev);
        next.delete(songKey);
        return next;
      });
    },
  });

  const likeMutation = useToggleLikeMutation();

  const addToPlaylistMutation = useMutation({
    mutationFn: (vars: { playlistId: string; playlistName: string; song: Song }) =>
      api.addTracksToPlaylist(vars.song.platform, vars.playlistId, [vars.song.id]),
    onSuccess: (_res, vars) => {
      toast.success(`已收藏到「${vars.playlistName}」`);
      void queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", vars.song.platform, vars.playlistId],
      });
      void queryClient.invalidateQueries({ queryKey: ["playlists", vars.song.platform] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "收藏到歌单失败"),
  });

  const ownedTargetPlaylists = (userPlaylistsQuery.data?.playlists ?? []).filter((pl) => pl.owned);

  if (songs.length === 0) {
    return <EmptyState title={emptyText} description={emptyDescription} />;
  }

  return (
    <div className="@container">
      {showHeaderMeta && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-muted)]">
          <span className="tabular-nums">{songs.length} 首曲目</span>
          <div className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setDownloadMode("tagged_server")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                downloadMode === "tagged_server"
                  ? "bg-[var(--tv-surface-elevated)] font-medium text-[var(--tv-text)] shadow-xs"
                  : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
              }`}
            >
              写标签下载
            </button>
            <button
              type="button"
              onClick={() => setDownloadMode("direct_link")}
              className={`rounded-md px-2.5 py-1 transition-colors ${
                downloadMode === "direct_link"
                  ? "bg-[var(--tv-surface-elevated)] font-medium text-[var(--tv-text)] shadow-xs"
                  : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
              }`}
            >
              直链下载
            </button>
          </div>
        </div>
      )}

      {/* Container-query responsive column header (prevents 0px title collapse at any container width) */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--tv-border)] px-2 pb-2 text-[11px] font-medium text-[var(--tv-text-subtle)] select-none @lg:grid-cols-[32px_minmax(0,1fr)_48px_96px] @lg:gap-3 @lg:px-3 @3xl:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px]">
        <span className="hidden text-center @lg:block">#</span>
        <span>标题</span>
        <span className="hidden @3xl:block">专辑</span>
        <span className="hidden text-right @lg:block">时长</span>
        <span className="text-right">操作</span>
      </div>

      <div className="mt-1 space-y-0.5">
        {songs.map((song, idx) => {
          const key = getSongKey(song);
          const rowKey = `${key}-${idx}`;
          const active = currentTrack ? getSongKey(currentTrack) === key : false;
          const locked = Boolean(song.availability?.playback.locked);
          const downloadLocked = Boolean(song.availability?.download.locked);
          const canLikeSong = capabilities[song.platform].canLikeSong;
          const canManagePlaylists = capabilities[song.platform].canManagePlaylistTracks;
          const isLiked = canLikeSong && likedSets[song.platform].has(song.id);
          const isDownloading = pendingDownloadKeys.has(key);
          const downloadDisabled = isDownloading || downloadLocked;
          const preferredLevel: QualityLevel = song.availableQualities.some(
            (q) => q.level === defaultDownloadQuality,
          )
            ? defaultDownloadQuality
            : (song.availableQualities[song.availableQualities.length - 1]?.level ?? "standard");
          const downloadTitle = downloadLocked
            ? (song.availability?.download.reason ?? "当前曲目暂不可下载")
            : isDownloading
              ? "正在加入下载..."
              : `下载 ${getQualityLabel(preferredLevel)}`;
          const menuOpen = openMenuKey === rowKey;

          return (
            <div
              key={rowKey}
              onDoubleClick={(e) => {
                const target = e.target as HTMLElement | null;
                if (target?.closest("button, a, input, select")) return;
                const lastBtn = lastButtonPlayRef.current;
                if (lastBtn && lastBtn.key === key && Date.now() - lastBtn.at < BUTTON_DBLCLICK_GUARD_MS) {
                  lastButtonPlayRef.current = null;
                  return;
                }
                void audioEngine.playTrack(song, { queue: songs });
              }}
              className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 transition-colors @lg:grid-cols-[32px_minmax(0,1fr)_48px_96px] @lg:gap-3 @lg:px-3 @3xl:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px] ${
                active ? "bg-[var(--tv-accent-soft)]" : "hover:bg-[var(--tv-surface-hover)]"
              }`}
            >
              {/* Index / Playing Equalizer / Hover Play Button (@lg+) */}
              <div className="hidden items-center justify-center @lg:flex">
                <button
                  type="button"
                  onClick={(e) => handlePlayButtonClick(e, song)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--tv-text-subtle)] transition-colors hover:text-[var(--tv-text)]"
                  title={locked ? song.availability?.playback.reason : "播放"}
                  aria-label={`播放 ${song.title}`}
                >
                  {active && isPlaying ? (
                    <EqualizerBars />
                  ) : (
                    <>
                      <span
                        className={`text-xs tabular-nums group-hover:hidden ${
                          active ? "font-semibold text-[var(--tv-accent)]" : ""
                        }`}
                      >
                        {indexOffset + idx + 1}
                      </span>
                      <span className="hidden group-hover:inline-flex">
                        {locked ? (
                          <Lock className="h-3.5 w-3.5 text-[var(--tv-danger)]" />
                        ) : (
                          <Play className="h-3.5 w-3.5 fill-current text-[var(--tv-text)]" />
                        )}
                      </span>
                    </>
                  )}
                </button>
              </div>

              {/* Cover + Title + Clickable Artist Links */}
              <div className="flex min-w-0 items-center gap-2.5 @lg:gap-3">
                <button
                  type="button"
                  onClick={(e) => handlePlayButtonClick(e, song)}
                  className="relative shrink-0"
                  aria-label={`播放 ${song.title}`}
                >
                  <CoverArt src={song.coverUrl} alt={song.title} className="h-10 w-10" rounded="rounded-md" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 @lg:gap-2">
                    {active && isPlaying && (
                      <span className="inline-flex shrink-0 @lg:hidden">
                        <EqualizerBars />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => handlePlayButtonClick(e, song)}
                      className={`truncate text-left text-[13.5px] font-semibold transition-colors ${
                        active
                          ? "text-[var(--tv-accent)]"
                          : "text-[var(--tv-text)] hover:text-[var(--tv-accent)]"
                      }`}
                    >
                      {song.title}
                    </button>
                    {song.isCloud && (
                      <span className="shrink-0 rounded bg-[var(--tv-surface-active)] px-1.5 py-0.5 text-[10px] text-[var(--tv-text-muted)]">
                        云盘
                      </span>
                    )}
                    {song.availability && song.availability.playback.status !== "available" && (
                      <span
                        title={song.availability.playback.reason}
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                          song.availability.playback.locked
                            ? "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]"
                            : "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]"
                        }`}
                      >
                        {song.availability.playback.label}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--tv-text-muted)]">
                    <ArtistLinks
                      platform={song.platform}
                      artists={song.artists}
                      fallbackText={song.artist}
                      primaryArtistId={song.primaryArtistId}
                      className="truncate"
                    />
                    <PlatformBadge platform={song.platform} subtle />
                  </div>
                </div>
              </div>

              {/* Clickable Album Column (@3xl+) */}
              <div className="hidden min-w-0 truncate text-xs text-[var(--tv-text-muted)] @3xl:block">
                <AlbumLink song={song} />
              </div>

              {/* Duration (@lg+) */}
              <div className="hidden text-right text-xs tabular-nums text-[var(--tv-text-subtle)] @lg:block">
                {song.duration}
              </div>

              {/* Clean Row Actions: Like + Quick Download (@lg+) + Context Menu (touch-friendly) */}
              <div className="relative flex items-center justify-end gap-0.5">
                {canLikeSong && (
                  <button
                    type="button"
                    onClick={() =>
                      likeMutation.mutate({
                        platform: song.platform,
                        songId: song.id,
                        nextLiked: !isLiked,
                        songTitle: song.title,
                      })
                    }
                    title={isLiked ? "取消喜欢" : "红心喜欢"}
                    aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
                    className={`rounded-md p-1.5 transition-all ${
                      isLiked
                        ? "text-[var(--tv-accent)] opacity-100"
                        : "hidden text-[var(--tv-text-subtle)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] @lg:inline-flex @3xl:opacity-0 @3xl:group-hover:opacity-100"
                    }`}
                  >
                    <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
                  </button>
                )}

                <button
                  type="button"
                  disabled={downloadDisabled}
                  onClick={() =>
                    downloadMutation.mutate({
                      song,
                      level: preferredLevel,
                      mode: downloadMode,
                    })
                  }
                  title={downloadTitle}
                  aria-label={`下载 ${song.title}`}
                  className="hidden rounded-md p-1.5 text-[var(--tv-text-muted)] opacity-65 transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-35 @lg:inline-flex"
                >
                  {isDownloading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                </button>

                <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={(e) => {
                      if (menuOpen) {
                        setOpenMenuKey(null);
                        setMenuPanel("main");
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const hasLayoutRect = rect.height > 0 && window.innerHeight > 0;
                        const shouldFlipUp = hasLayoutRect
                          ? window.innerHeight - rect.bottom < 280 && rect.top > 240
                          : songs.length >= 4 && idx >= songs.length - 3;
                        setMenuUpward(shouldFlipUp);
                        setOpenMenuKey(rowKey);
                        setMenuPanel("main");
                      }
                    }}
                    title="更多操作"
                    aria-label="更多操作"
                    className={`rounded-md p-1.5 text-[var(--tv-text-muted)] transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] ${
                      menuOpen
                        ? "bg-[var(--tv-surface-active)] opacity-100"
                        : "opacity-100 @3xl:opacity-65 @3xl:group-hover:opacity-100"
                    }`}
                  >
                    <MoreHorizontal className="h-4 w-4 @lg:h-3.5 @lg:w-3.5" />
                  </button>

                  {menuOpen && (
                    <div
                      className={`absolute right-0 w-48 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] p-1 shadow-2xl ${
                        menuUpward ? "bottom-full mb-1" : "top-full mt-1"
                      }`}
                      style={{ zIndex: "var(--tv-z-dropdown)" }}
                    >
                      {menuPanel === "main" && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              audioEngine.insertNextInQueue(song);
                              toast.info(`已设为下一首播放：${song.title}`);
                              setOpenMenuKey(null);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                          >
                            <ListPlus className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                            下一首播放
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              audioEngine.addToQueue(song);
                              toast.info(`已添加到播放队列：${song.title}`);
                              setOpenMenuKey(null);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                          >
                            <ListEnd className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                            添加到队列末尾
                          </button>

                          {canManagePlaylists && (
                            <button
                              type="button"
                              onClick={() => setMenuPanel("playlists")}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                            >
                              <span className="flex items-center gap-2">
                                <FolderPlus className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                                收藏到歌单
                              </span>
                              <span className="text-[10px] text-[var(--tv-text-subtle)]">›</span>
                            </button>
                          )}

                          {canLikeSong && (
                            <button
                              type="button"
                              onClick={() => {
                                likeMutation.mutate({
                                  platform: song.platform,
                                  songId: song.id,
                                  nextLiked: !isLiked,
                                  songTitle: song.title,
                                });
                                setOpenMenuKey(null);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] @lg:hidden"
                            >
                              <Heart
                                className={`h-3.5 w-3.5 ${
                                  isLiked
                                    ? "fill-[var(--tv-accent)] text-[var(--tv-accent)]"
                                    : "text-[var(--tv-text-muted)]"
                                }`}
                              />
                              {isLiked ? "取消红心喜欢" : "红心喜欢"}
                            </button>
                          )}

                          {song.availableQualities.length > 1 ? (
                            <button
                              type="button"
                              disabled={downloadDisabled}
                              title={downloadTitle}
                              onClick={() => setMenuPanel("quality")}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <span className="flex items-center gap-2">
                                <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                                {downloadLocked ? "暂不可下载" : "下载歌曲"}
                              </span>
                              <span className="text-[10px] text-[var(--tv-text-subtle)]">›</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={downloadDisabled}
                              title={downloadTitle}
                              onClick={() => {
                                setOpenMenuKey(null);
                                downloadMutation.mutate({
                                  song,
                                  level: preferredLevel,
                                  mode: downloadMode,
                                });
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 @lg:hidden"
                            >
                              <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                              {downloadLocked ? "暂不可下载" : `下载 (${getQualityLabel(preferredLevel)})`}
                            </button>
                          )}

                          {(song.primaryArtistId || song.albumId) && (
                            <div className="my-1 border-t border-[var(--tv-border)]" />
                          )}

                          {song.primaryArtistId && (
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuKey(null);
                                navigate(
                                  `/artist/${song.platform}/${encodeURIComponent(song.primaryArtistId ?? "")}`,
                                );
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                            >
                              <User className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                              查看歌手
                            </button>
                          )}

                          {song.albumId && (
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuKey(null);
                                navigate(`/album/${song.platform}/${encodeURIComponent(song.albumId ?? "")}`);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                            >
                              <Disc3 className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                              查看专辑
                            </button>
                          )}

                          {onRemoveTrack && (
                            <>
                              <div className="my-1 border-t border-[var(--tv-border)]" />
                              <button
                                type="button"
                                onClick={() => {
                                  setOpenMenuKey(null);
                                  onRemoveTrack(song);
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-danger)] hover:bg-[var(--tv-danger)]/10"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                从歌单移除
                              </button>
                            </>
                          )}
                        </>
                      )}

                      {menuPanel === "playlists" && (
                        <>
                          <button
                            type="button"
                            onClick={() => setMenuPanel("main")}
                            className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                          >
                            ‹ 选择目标歌单
                          </button>
                          <div className="max-h-52 overflow-y-auto space-y-0.5">
                            {userPlaylistsQuery.isLoading ? (
                              <div className="flex items-center justify-center gap-1.5 px-2.5 py-3 text-[11px] text-[var(--tv-text-muted)]">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                加载歌单中...
                              </div>
                            ) : userPlaylistsQuery.isError ? (
                              <div className="space-y-1.5 px-2.5 py-3 text-center text-[11px] text-[var(--tv-text-muted)]">
                                <div>加载歌单失败</div>
                                <button
                                  type="button"
                                  onClick={() => void userPlaylistsQuery.refetch()}
                                  className="rounded bg-[var(--tv-surface)] px-2 py-0.5 text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
                                >
                                  重试
                                </button>
                              </div>
                            ) : ownedTargetPlaylists.length === 0 ? (
                              <div className="px-2.5 py-3 text-center text-[11px] text-[var(--tv-text-muted)]">
                                暂无自建歌单
                              </div>
                            ) : (
                              ownedTargetPlaylists.map((pl) => (
                                <button
                                  key={pl.id}
                                  type="button"
                                  onClick={() => {
                                    setOpenMenuKey(null);
                                    setMenuPanel("main");
                                    addToPlaylistMutation.mutate({
                                      playlistId: pl.id,
                                      playlistName: pl.name,
                                      song,
                                    });
                                  }}
                                  className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                                >
                                  {pl.name}
                                </button>
                              ))
                            )}
                          </div>
                        </>
                      )}

                      {menuPanel === "quality" && (
                        <>
                          <button
                            type="button"
                            onClick={() => setMenuPanel("main")}
                            className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                          >
                            ‹ 选择下载音质
                          </button>
                          {song.availableQualities.map((q) => (
                            <button
                              key={q.level}
                              type="button"
                              disabled={downloadDisabled}
                              onClick={() => {
                                setOpenMenuKey(null);
                                setMenuPanel("main");
                                downloadMutation.mutate({
                                  song,
                                  level: q.level,
                                  mode: downloadMode,
                                });
                              }}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] disabled:opacity-40"
                            >
                              <span>{q.label}</span>
                              {q.level === preferredLevel && (
                                <span className="text-[10px] text-[var(--tv-accent)]">默认</span>
                              )}
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
