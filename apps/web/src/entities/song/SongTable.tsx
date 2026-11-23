import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Disc3,
  Download,
  FolderPlus,
  Heart,
  ListEnd,
  ListPlus,
  Lock,
  MoreHorizontal,
  Play,
  Trash2,
  User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type DownloadMode, type QualityLevel, type Song, getQualityLabel, getSongKey } from "#shared";
import { audioEngine } from "../../features/player/engine/audio-engine.js";
import { usePlayerStore } from "../../features/player/store/player-store.js";
import { api } from "../../shared/api/endpoints.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../../shared/hooks/use-toggle-like.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, EqualizerBars, PlatformBadge } from "../../shared/ui/primitives.js";
import { AlbumLink, ArtistLinks } from "../music/EntityLinks.js";

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

  const hasNeteaseSongs = songs.some((s) => s.platform === "netease");

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const { data: likedIdsData } = useLikedIdsQuery("netease", hasNeteaseSongs);

  const [downloadMode, setDownloadMode] = useState<DownloadMode>("tagged_server");
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null);
  const [menuPanel, setMenuPanel] = useState<"main" | "playlists" | "quality">("main");

  const { data: userPlaylistsData } = useQuery({
    queryKey: ["playlists", "netease"],
    queryFn: () => api.getUserPlaylists("netease"),
    enabled: Boolean(openMenuKey && menuPanel === "playlists"),
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

  const likedSet = new Set(likedIdsData?.ids ?? []);
  const defaultDownloadQuality = settingsData?.settings.defaultDownloadQuality ?? "lossless";

  const downloadMutation = useMutation({
    mutationFn: (payload: { song: Song; level: QualityLevel; mode: DownloadMode }) =>
      api.createDownloadJob(payload),
    onSuccess: (res, vars) => {
      toast.success(`已加入下载：${vars.song.title}（${getQualityLabel(vars.level)}）`);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (res.job.directUrl) {
        window.open(res.job.directUrl, "_blank", "noopener,noreferrer");
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "加入下载队列失败");
    },
  });

  const likeMutation = useToggleLikeMutation();

  const addToPlaylistMutation = useMutation({
    mutationFn: (vars: { playlistId: string; playlistName: string; song: Song }) =>
      api.addTracksToPlaylist("netease", vars.playlistId, [vars.song.id]),
    onSuccess: (_res, vars) => {
      toast.success(`已收藏到「${vars.playlistName}」`);
      void queryClient.invalidateQueries({ queryKey: ["playlist-tracks", "netease", vars.playlistId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "收藏到歌单失败"),
  });

  const ownedNeteasePlaylists = (userPlaylistsData?.playlists ?? []).filter((pl) => pl.owned);

  if (songs.length === 0) {
    return <EmptyState title={emptyText} description={emptyDescription} />;
  }

  return (
    <div>
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

      {/* Feishin / Spotify style frameless column header (adapts cleanly to mobile 2-col) */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 border-b border-[var(--tv-border)] px-2 pb-2 text-[11px] font-medium text-[var(--tv-text-subtle)] select-none sm:grid-cols-[32px_minmax(0,1fr)_48px_96px] sm:gap-3 sm:px-3 md:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px]">
        <span className="hidden text-center sm:block">#</span>
        <span>标题</span>
        <span className="hidden md:block">专辑</span>
        <span className="hidden text-right sm:block">时长</span>
        <span className="text-right">操作</span>
      </div>

      <div className="mt-1 space-y-0.5">
        {songs.map((song, idx) => {
          const key = getSongKey(song);
          const active = currentTrack ? getSongKey(currentTrack) === key : false;
          const locked = Boolean(song.availability?.playback.locked);
          const isLiked = song.platform === "netease" && likedSet.has(song.id);
          const preferredLevel: QualityLevel = song.availableQualities.some(
            (q) => q.level === defaultDownloadQuality,
          )
            ? defaultDownloadQuality
            : (song.availableQualities[song.availableQualities.length - 1]?.level ?? "standard");
          const menuOpen = openMenuKey === key;

          return (
            <div
              key={key}
              onDoubleClick={() => void audioEngine.playTrack(song, { queue: songs })}
              className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-2 transition-colors sm:grid-cols-[32px_minmax(0,1fr)_48px_96px] sm:gap-3 sm:px-3 md:grid-cols-[36px_minmax(0,1.65fr)_minmax(0,1fr)_52px_104px] ${
                active ? "bg-[var(--tv-accent-soft)]" : "hover:bg-[var(--tv-surface-hover)]"
              }`}
            >
              {/* Index / Playing Equalizer / Hover Play Button (sm+) */}
              <div className="hidden items-center justify-center sm:flex">
                <button
                  type="button"
                  onClick={() => void audioEngine.playTrack(song, { queue: songs })}
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
              <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
                <button
                  type="button"
                  onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                  className="relative shrink-0"
                  aria-label={`播放 ${song.title}`}
                >
                  <CoverArt src={song.coverUrl} alt={song.title} className="h-10 w-10" rounded="rounded-md" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    {active && isPlaying && (
                      <span className="inline-flex shrink-0 sm:hidden">
                        <EqualizerBars />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void audioEngine.playTrack(song, { queue: songs })}
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

              {/* Clickable Album Column */}
              <div className="hidden min-w-0 truncate text-xs text-[var(--tv-text-muted)] md:block">
                <AlbumLink song={song} />
              </div>

              {/* Duration */}
              <div className="hidden text-right text-xs tabular-nums text-[var(--tv-text-subtle)] sm:block">
                {song.duration}
              </div>

              {/* Clean Row Actions: Like + Quick Download (sm+) + Context Menu (touch-friendly) */}
              <div className="relative flex items-center justify-end gap-0.5">
                {song.platform === "netease" && (
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
                        : "hidden text-[var(--tv-text-subtle)] hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] sm:inline-flex md:opacity-0 md:group-hover:opacity-100"
                    }`}
                  >
                    <Heart className={`h-3.5 w-3.5 ${isLiked ? "fill-current" : ""}`} />
                  </button>
                )}

                <button
                  type="button"
                  disabled={downloadMutation.isPending}
                  onClick={() =>
                    downloadMutation.mutate({
                      song,
                      level: preferredLevel,
                      mode: downloadMode,
                    })
                  }
                  title={`下载 ${getQualityLabel(preferredLevel)}`}
                  aria-label={`下载 ${song.title}`}
                  className="hidden rounded-md p-1.5 text-[var(--tv-text-muted)] opacity-65 transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] group-hover:opacity-100 disabled:opacity-40 sm:inline-flex"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>

                <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => {
                      if (menuOpen) {
                        setOpenMenuKey(null);
                        setMenuPanel("main");
                      } else {
                        setOpenMenuKey(key);
                        setMenuPanel("main");
                      }
                    }}
                    title="更多操作"
                    aria-label="更多操作"
                    className={`rounded-md p-1.5 text-[var(--tv-text-muted)] transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] ${
                      menuOpen
                        ? "bg-[var(--tv-surface-active)] opacity-100"
                        : "opacity-100 md:opacity-65 md:group-hover:opacity-100"
                    }`}
                  >
                    <MoreHorizontal className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                  </button>

                  {menuOpen && (
                    <div
                      className="absolute right-0 top-full mt-1 w-48 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] p-1 shadow-2xl"
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

                          {song.platform === "netease" && (
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

                          {song.platform === "netease" && (
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
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] sm:hidden"
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
                              onClick={() => setMenuPanel("quality")}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                            >
                              <span className="flex items-center gap-2">
                                <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                                下载歌曲
                              </span>
                              <span className="text-[10px] text-[var(--tv-text-subtle)]">›</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setOpenMenuKey(null);
                                downloadMutation.mutate({
                                  song,
                                  level: preferredLevel,
                                  mode: downloadMode,
                                });
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)] sm:hidden"
                            >
                              <Download className="h-3.5 w-3.5 text-[var(--tv-text-muted)]" />
                              下载 ({getQualityLabel(preferredLevel)})
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
                            {ownedNeteasePlaylists.length === 0 ? (
                              <div className="px-2.5 py-3 text-center text-[11px] text-[var(--tv-text-muted)]">
                                暂无自建歌单
                              </div>
                            ) : (
                              ownedNeteasePlaylists.map((pl) => (
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
                              onClick={() => {
                                setOpenMenuKey(null);
                                setMenuPanel("main");
                                downloadMutation.mutate({
                                  song,
                                  level: q.level,
                                  mode: downloadMode,
                                });
                              }}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
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
