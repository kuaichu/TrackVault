import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, Play, Plus, Search } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { MusicPlatform, PlaylistSort, PlaylistSummary, Song } from "#shared";
import { MediaDetailHeader, PlaylistCard } from "../../entities/music/index.js";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { usePlatformParam } from "../../shared/hooks/use-platform-param.js";
import { toast } from "../../shared/store/toast-store.js";
import { EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";
import { SongTable } from "../../widgets/song-table/index.js";

const PAGE_SIZE = 50;

export function PlaylistsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { platform, platformReady, setPlatform } = usePlatformParam();
  const capabilities = useCapabilities();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [playingPlaylistKey, setPlayingPlaylistKey] = useState<string | null>(null);

  const canCreatePlaylist = platformReady && capabilities[platform].canCreatePlaylist;

  const playlistsQuery = useQuery({
    queryKey: ["playlists", platform],
    queryFn: () => api.getUserPlaylists(platform),
    enabled: platformReady,
  });

  const createMutation = useMutation({
    mutationFn: ({ targetPlatform, name }: { targetPlatform: MusicPlatform; name: string }) =>
      api.createPlaylist(targetPlatform, name, []),
    onSuccess: (res, vars) => {
      setNewName("");
      setCreating(false);
      toast.success(`已新建歌单「${res.playlistName}」`);
      void queryClient.invalidateQueries({ queryKey: ["playlists", vars.targetPlatform] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
      navigate(`/playlists/${vars.targetPlatform}/${encodeURIComponent(res.playlistId)}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "新建歌单失败"),
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!platformReady || !canCreatePlaylist || !newName.trim()) return;
    createMutation.mutate({ targetPlatform: platform, name: newName.trim() });
  };

  const handlePlayPlaylist = async (pl: PlaylistSummary) => {
    const key = `${pl.platform}:${pl.id}`;
    if (playingPlaylistKey === key) return;
    setPlayingPlaylistKey(key);
    try {
      const res = await api.getPlaylistTracks(pl.platform, pl.id, { page: 1, limit: PAGE_SIZE });
      const first = findFirstPlayableSong(res.songs);
      if (!first) {
        toast.info("该歌单暂无可播放曲目");
        return;
      }
      await audioEngine.playTrack(first, { queue: res.songs });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载歌单曲目失败");
    } finally {
      setPlayingPlaylistKey((prev) => (prev === key ? null : prev));
    }
  };

  const playlists = playlistsQuery.data?.playlists ?? [];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">歌单</h1>
          {canCreatePlaylist && (
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text)] transition-colors hover:bg-[var(--tv-surface-active)]"
            >
              <Plus className="h-3.5 w-3.5" />
              新建歌单
            </button>
          )}
        </div>
        <SegmentedTabs
          value={platform}
          onChange={(next) => {
            setCreating(false);
            setPlatform(next);
          }}
          items={[
            { id: "netease", label: "网易云音乐" },
            { id: "qq", label: "QQ 音乐" },
          ]}
        />
      </div>

      {creating && canCreatePlaylist && (
        <form
          onSubmit={handleCreate}
          className="flex flex-wrap items-center gap-2.5 rounded-xl bg-[var(--tv-surface)] p-3.5"
        >
          <input
            type="text"
            required
            maxLength={100}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="输入新歌单名称..."
            className="h-9 flex-1 min-w-[200px] rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={!newName.trim() || createMutation.isPending}
            className="h-9 rounded-lg bg-[var(--tv-accent)] px-4 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
          >
            {createMutation.isPending ? "创建中..." : "创建"}
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="h-9 rounded-lg px-3 text-xs text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
          >
            取消
          </button>
        </form>
      )}

      {playlistsQuery.isLoading || !platformReady ? (
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"].map((id) => (
            <div key={id} className="space-y-2.5">
              <div className="aspect-square w-full animate-pulse rounded-xl bg-[var(--tv-surface)]" />
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-[var(--tv-surface)]" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--tv-surface)]" />
            </div>
          ))}
        </div>
      ) : playlistsQuery.isError ? (
        <EmptyState
          title="未能加载歌单列表"
          description={
            playlistsQuery.error instanceof Error
              ? playlistsQuery.error.message
              : "请先在设置中绑定对应音乐平台账号"
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void playlistsQuery.refetch()}
                className="inline-flex items-center rounded-lg bg-[var(--tv-surface-active)] px-4 py-2 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
              >
                重试
              </button>
              <Link
                to="/settings"
                className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
              >
                前往绑定账号
              </Link>
            </div>
          }
        />
      ) : playlists.length === 0 ? (
        <EmptyState title="暂无歌单" description="该平台账号下还没有自建或收藏的歌单。" />
      ) : (
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {playlists.map((pl) => {
            const key = `${pl.platform}:${pl.id}`;
            return (
              <PlaylistCard
                key={key}
                playlist={pl}
                playLoading={playingPlaylistKey === key}
                onOpen={() =>
                  navigate(`/playlists/${pl.platform}/${encodeURIComponent(pl.id)}`, {
                    state: { playlist: pl },
                  })
                }
                onPlay={() => void handlePlayPlaylist(pl)}
                subtitle={
                  <>
                    <span className="tabular-nums">{pl.trackCount} 首</span>
                    <span>·</span>
                    <span className="truncate">{pl.owned ? "自建" : pl.creatorName}</span>
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function PlaylistDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const initialSummary = (location.state as { playlist?: PlaylistSummary } | null)?.playlist;

  const [page, setPage] = useState(1);
  const [keywordInput, setKeywordInput] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [sort, setSort] = useState<PlaylistSort>("default");

  const prevRouteKeyRef = useRef(`${platform}:${id}`);
  useEffect(() => {
    const nextRouteKey = `${platform}:${id}`;
    if (prevRouteKeyRef.current !== nextRouteKey) {
      prevRouteKeyRef.current = nextRouteKey;
      setPage(1);
      setKeywordInput("");
      setDebouncedKeyword("");
      setSort("default");
    }
  }, [platform, id]);

  useEffect(() => {
    const trimmed = keywordInput.trim();
    if (trimmed === debouncedKeyword) return;
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(trimmed);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput, debouncedKeyword]);

  const detailQuery = useQuery({
    queryKey: ["playlist-tracks", platform, id, page, debouncedKeyword, sort],
    queryFn: () =>
      api.getPlaylistTracks(platform, id, {
        page,
        limit: PAGE_SIZE,
        keyword: debouncedKeyword,
        sort,
      }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (detailQuery.isSuccess && !detailQuery.isPlaceholderData && detailQuery.data) {
      const actualTotalPages = Math.max(1, Math.ceil(detailQuery.data.total / PAGE_SIZE));
      if (page > actualTotalPages) {
        setPage(actualTotalPages);
      }
    }
  }, [detailQuery.isSuccess, detailQuery.isPlaceholderData, detailQuery.data, page]);

  const removeMutation = useMutation({
    mutationFn: (song: Song) => api.removeTracksFromPlaylist(platform, id, [song.id]),
    onSuccess: () => {
      toast.success("已从歌单移除");
      void queryClient.invalidateQueries({ queryKey: ["playlist-tracks", platform, id] });
      void queryClient.invalidateQueries({ queryKey: ["playlists", platform] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "移除失败"),
  });

  const playlist = detailQuery.data?.playlist ?? (initialSummary?.id === id ? initialSummary : undefined);
  const songs = detailQuery.data?.songs ?? [];
  const total = detailQuery.data?.total ?? playlist?.trackCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canManageTracks = capabilities[platform].canManagePlaylistTracks;

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate(`/playlists?platform=${platform}`)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:text-[var(--tv-text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回歌单
      </button>

      {playlist && (
        <MediaDetailHeader
          coverUrl={playlist.coverUrl}
          coverAlt={playlist.name}
          platform={playlist.platform}
          title={playlist.name}
          description={playlist.description}
          meta={
            <p className="text-xs text-[var(--tv-text-muted)]">
              {playlist.creatorName} · 共 {total.toLocaleString("zh-CN")} 首曲目
            </p>
          }
          actions={
            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <button
                type="button"
                disabled={songs.length === 0}
                onClick={() => {
                  const first = findFirstPlayableSong(songs);
                  if (!first) {
                    toast.info("当前列表中的歌曲均不可播放");
                    return;
                  }
                  void audioEngine.playTrack(first, { queue: songs });
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                播放本页
              </button>

              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--tv-text-subtle)]" />
                <input
                  type="text"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  placeholder="在歌单中筛选"
                  className="h-8 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] pl-8 pr-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none"
                />
              </div>

              <select
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as PlaylistSort);
                  setPage(1);
                }}
                aria-label="歌单排序"
                className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-1.5 text-xs leading-normal text-[var(--tv-text)] focus:border-[var(--tv-border-strong)] focus:outline-none"
              >
                <option value="default">默认排序</option>
                <option value="title-asc">按歌名 A–Z</option>
                <option value="title-desc">按歌名 Z–A</option>
                <option value="artist-asc">按歌手</option>
                <option value="duration-desc">时长由长到短</option>
                <option value="duration-asc">时长由短到长</option>
              </select>

              {detailQuery.isFetching && !detailQuery.isLoading && (
                <span className="inline-flex items-center gap-1.5 text-xs text-[var(--tv-text-subtle)]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  载入中
                </span>
              )}
            </div>
          }
        />
      )}

      {detailQuery.isLoading && songs.length === 0 ? (
        <div className="space-y-2">
          {["d1", "d2", "d3", "d4", "d5", "d6"].map((rowId) => (
            <div key={rowId} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : detailQuery.isError ? (
        <EmptyState
          title="歌单加载失败"
          description={detailQuery.error instanceof Error ? detailQuery.error.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void detailQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : (
        <>
          {detailQuery.data?.truncated && (
            <output className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                该歌单超过单次检索上限（共 {(playlist?.trackCount ?? total).toLocaleString("zh-CN")}{" "}
                首），当前搜索或排序仅扫描前{" "}
                {(detailQuery.data.scannedTotal ?? 10_000).toLocaleString("zh-CN")}{" "}
                首曲目。清空筛选词并切回「默认排序」可翻页浏览全部曲目。
              </span>
            </output>
          )}
          <SongTable
            songs={songs}
            indexOffset={(page - 1) * PAGE_SIZE}
            onRemoveTrack={
              playlist?.owned && canManageTracks ? (song) => removeMutation.mutate(song) : undefined
            }
          />
          {(page > 1 || detailQuery.data?.hasMore) && (
            <div className="flex items-center justify-center gap-3 pt-2 text-xs text-[var(--tv-text-muted)]">
              <button
                type="button"
                disabled={page <= 1 || detailQuery.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg bg-[var(--tv-surface)] px-3.5 py-1.5 font-medium hover:bg-[var(--tv-surface-active)] disabled:opacity-35"
              >
                上一页
              </button>
              <span className="tabular-nums">
                第 {page} / {totalPages} 页
              </span>
              <button
                type="button"
                disabled={!detailQuery.data?.hasMore || detailQuery.isFetching}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg bg-[var(--tv-surface)] px-3.5 py-1.5 font-medium hover:bg-[var(--tv-surface-active)] disabled:opacity-35"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
