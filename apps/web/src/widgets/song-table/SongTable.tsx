import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type DownloadMode,
  type QualityLevel,
  type Song,
  getQualityLabel,
  getSongKey,
  sanitizeExternalUrl,
} from "#shared";
import {
  SongTable as PureSongTable,
  useLikedIdsQuery,
  useToggleLikeMutation,
} from "../../entities/song/index.js";
import { registerPendingDirectLinkJob, useDownloadModeStore } from "../../features/downloads/index.js";
import { audioEngine, usePlayerStore } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { useSettingsQuery } from "../../shared/hooks/use-settings-query.js";
import { toast } from "../../shared/store/toast-store.js";

export interface SongTableProps {
  songs: Song[];
  emptyText?: string;
  emptyDescription?: string;
  onRemoveTrack?: (song: Song) => void;
  showHeaderMeta?: boolean;
  indexOffset?: number;
}

function PlaylistSubmenuContent({
  song,
  onSelectPlaylist,
  onBack,
}: {
  song: Song;
  onSelectPlaylist: (playlistId: string, playlistName: string, song: Song) => void;
  onBack: () => void;
}) {
  const capabilities = useCapabilities();
  const canManage = capabilities[song.platform].canManagePlaylistTracks;
  const userPlaylistsQuery = useQuery({
    queryKey: ["playlists", song.platform],
    queryFn: () => api.getUserPlaylists(song.platform),
    enabled: canManage,
    staleTime: 60_000,
  });

  const ownedTargetPlaylists = (userPlaylistsQuery.data?.playlists ?? []).filter((pl) => pl.owned);

  return (
    <>
      <button
        type="button"
        onClick={onBack}
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
          <div className="px-2.5 py-3 text-center text-[11px] text-[var(--tv-text-muted)]">暂无自建歌单</div>
        ) : (
          ownedTargetPlaylists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              onClick={() => onSelectPlaylist(pl.id, pl.name, song)}
              className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
            >
              {pl.name}
            </button>
          ))
        )}
      </div>
    </>
  );
}

/**
 * Business-wired `<SongTable>` widget connecting the pure virtualized `entities/song` table
 * with player transport, liked state, playlist mutations, and download mode preferences.
 */
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
  const downloadMode = useDownloadModeStore((s) => s.downloadMode);
  const setDownloadMode = useDownloadModeStore((s) => s.setDownloadMode);

  const capabilities = useCapabilities();
  const canLikeNetease = useMemo(
    () => capabilities.netease.canLikeSong && songs.some((s) => s.platform === "netease"),
    [capabilities.netease.canLikeSong, songs],
  );
  const canLikeQq = useMemo(
    () => capabilities.qq.canLikeSong && songs.some((s) => s.platform === "qq"),
    [capabilities.qq.canLikeSong, songs],
  );

  const { data: settingsData } = useSettingsQuery();
  const { data: neteaseLikedIdsData } = useLikedIdsQuery("netease", canLikeNetease);
  const { data: qqLikedIdsData } = useLikedIdsQuery("qq", canLikeQq);

  const neteaseLikedSet = useMemo(() => new Set(neteaseLikedIdsData?.ids ?? []), [neteaseLikedIdsData?.ids]);
  const qqLikedSet = useMemo(() => new Set(qqLikedIdsData?.ids ?? []), [qqLikedIdsData?.ids]);

  const [pendingDownloadKeys, setPendingDownloadKeys] = useState<Set<string>>(() => new Set());
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
          const meta = res.job.metadata;
          const resolvedLevel = typeof meta?.level === "string" ? (meta.level as QualityLevel) : vars.level;
          const resolvedBitrate = typeof meta?.bitrate === "number" ? meta.bitrate : null;
          const resolvedFormat =
            typeof meta?.format === "string"
              ? meta.format
              : (res.job.artifactFilename?.split(".").pop() ?? null);
          const actualLabel = getQualityLabel(resolvedLevel, resolvedBitrate, resolvedFormat);
          toast.success(`直链已就绪：${vars.song.title}（${actualLabel}）`, {
            action: { label: "打开直链", href: safeDirectUrl },
          });
        } else {
          const alreadyResolvedViaSse = registerPendingDirectLinkJob(res.job.id, {
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

  const currentTrackKey = currentTrack ? getSongKey(currentTrack) : null;

  const canLikeSong = useCallback((song: Song) => capabilities[song.platform].canLikeSong, [capabilities]);

  const isSongLiked = useCallback(
    (song: Song) => {
      if (!capabilities[song.platform].canLikeSong) return false;
      return song.platform === "netease" ? neteaseLikedSet.has(song.id) : qqLikedSet.has(song.id);
    },
    [capabilities, neteaseLikedSet, qqLikedSet],
  );

  const isSongDownloading = useCallback(
    (song: Song) => pendingDownloadKeys.has(getSongKey(song)),
    [pendingDownloadKeys],
  );

  const canManagePlaylists = useCallback(
    (song: Song) => capabilities[song.platform].canManagePlaylistTracks,
    [capabilities],
  );

  const getPreferredDownloadQuality = useCallback(
    (song: Song) => {
      const level: QualityLevel = song.availableQualities.some((q) => q.level === defaultDownloadQuality)
        ? defaultDownloadQuality
        : (song.availableQualities[song.availableQualities.length - 1]?.level ?? "standard");
      return { level, label: getQualityLabel(level) };
    },
    [defaultDownloadQuality],
  );

  const handlePlaySong = useCallback((song: Song, queue: Song[]) => {
    void audioEngine.playTrack(song, { queue });
  }, []);

  const handleToggleLike = useCallback(
    (song: Song, nextLiked: boolean) => {
      likeMutation.mutate({
        platform: song.platform,
        songId: song.id,
        nextLiked,
        songTitle: song.title,
      });
    },
    [likeMutation],
  );

  const handleDownloadSong = useCallback(
    (song: Song, level: QualityLevel, mode: DownloadMode) => {
      downloadMutation.mutate({ song, level, mode });
    },
    [downloadMutation],
  );

  const handleQueueNext = useCallback((song: Song) => {
    audioEngine.insertNextInQueue(song);
    toast.info(`已设为下一首播放：${song.title}`);
  }, []);

  const handleQueueAdd = useCallback((song: Song) => {
    audioEngine.addToQueue(song);
    toast.info(`已添加到播放队列：${song.title}`);
  }, []);

  const handleNavigateArtist = useCallback(
    (song: Song) => {
      navigate(`/artist/${song.platform}/${encodeURIComponent(song.primaryArtistId ?? "")}`);
    },
    [navigate],
  );

  const handleNavigateAlbum = useCallback(
    (song: Song) => {
      navigate(`/album/${song.platform}/${encodeURIComponent(song.albumId ?? "")}`);
    },
    [navigate],
  );

  const renderPlaylistSubmenu = useCallback(
    (song: Song, { closeMenu, backToMain }: { closeMenu: () => void; backToMain: () => void }) => (
      <PlaylistSubmenuContent
        song={song}
        onBack={backToMain}
        onSelectPlaylist={(playlistId, playlistName, targetSong) => {
          closeMenu();
          backToMain();
          addToPlaylistMutation.mutate({ playlistId, playlistName, song: targetSong });
        }}
      />
    ),
    [addToPlaylistMutation],
  );

  return (
    <PureSongTable
      songs={songs}
      emptyText={emptyText}
      emptyDescription={emptyDescription}
      showHeaderMeta={showHeaderMeta}
      indexOffset={indexOffset}
      currentTrackKey={currentTrackKey}
      isPlaying={isPlaying}
      downloadMode={downloadMode}
      onChangeDownloadMode={setDownloadMode}
      canLikeSong={canLikeSong}
      isSongLiked={isSongLiked}
      isSongDownloading={isSongDownloading}
      canManagePlaylists={canManagePlaylists}
      getPreferredDownloadQuality={getPreferredDownloadQuality}
      onPlaySong={handlePlaySong}
      onToggleLike={handleToggleLike}
      onDownloadSong={handleDownloadSong}
      onQueueNext={handleQueueNext}
      onQueueAdd={handleQueueAdd}
      onRemoveTrack={onRemoveTrack}
      onNavigateArtist={handleNavigateArtist}
      onNavigateAlbum={handleNavigateAlbum}
      renderPlaylistSubmenu={renderPlaylistSubmenu}
    />
  );
}
