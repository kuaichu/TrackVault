import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Play, Plus, Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  type MusicPlatform,
  type PlaylistSort,
  type PlaylistSummary,
  type Song,
  sanitizeCssUrl,
} from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, PlatformBadge, SegmentedTabs } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

const PAGE_SIZE = 50;

export function PlaylistsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<MusicPlatform>("netease");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const playlistsQuery = useQuery({
    queryKey: ["playlists", platform],
    queryFn: () => api.getUserPlaylists(platform),
  });

  const createMutation = useMutation({
    mutationFn: () => api.createPlaylist("netease", newName.trim(), []),
    onSuccess: (res) => {
      setNewName("");
      setCreating(false);
      toast.success(`已新建歌单「${res.playlistName}」`);
      void queryClient.invalidateQueries({ queryKey: ["playlists", "netease"] });
      navigate(`/playlists/netease/${encodeURIComponent(res.playlistId)}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "新建歌单失败"),
  });

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    createMutation.mutate();
  };

  const playlists = playlistsQuery.data?.playlists ?? [];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">歌单</h1>
          {platform === "netease" && (
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
          onChange={setPlatform}
          items={[
            { id: "netease", label: "网易云音乐" },
            { id: "qq", label: "QQ 音乐" },
          ]}
        />
      </div>

      {creating && platform === "netease" && (
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

      {playlistsQuery.isLoading ? (
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
            <Link
              to="/settings"
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              前往绑定账号
            </Link>
          }
        />
      ) : playlists.length === 0 ? (
        <EmptyState title="暂无歌单" description="该平台账号下还没有自建或收藏的歌单。" />
      ) : (
        /* YesPlayMusic / Apple Music Frameless Cover Art Grid */
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {playlists.map((pl) => (
            <button
              key={`${pl.platform}:${pl.id}`}
              type="button"
              onClick={() =>
                navigate(`/playlists/${pl.platform}/${encodeURIComponent(pl.id)}`, {
                  state: { playlist: pl },
                })
              }
              className="group text-left focus:outline-none"
            >
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                <CoverArt
                  src={pl.coverUrl}
                  alt={pl.name}
                  className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                  rounded="rounded-none"
                />
                <span className="absolute bottom-3 right-3 flex h-10 w-10 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                </span>
              </div>
              <div className="mt-2.5 line-clamp-2 text-[13.5px] font-semibold leading-snug text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                {pl.name}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
                <span className="tabular-nums">{pl.trackCount} 首</span>
                <span>·</span>
                <span className="truncate">{pl.owned ? "自建" : pl.creatorName}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaylistDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const initialSummary = (location.state as { playlist?: PlaylistSummary } | null)?.playlist;

  const [page, setPage] = useState(1);
  const [keywordInput, setKeywordInput] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [sort, setSort] = useState<PlaylistSort>("default");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedKeyword(keywordInput.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);

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

  const removeMutation = useMutation({
    mutationFn: (song: Song) => api.removeTracksFromPlaylist(platform, id, [song.id]),
    onSuccess: () => {
      toast.success("已从歌单移除");
      void queryClient.invalidateQueries({ queryKey: ["playlist-tracks", platform, id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "移除失败"),
  });

  const playlist = detailQuery.data?.playlist ?? (initialSummary?.id === id ? initialSummary : undefined);
  const songs = detailQuery.data?.songs ?? [];
  const total = detailQuery.data?.total ?? playlist?.trackCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const headerGlow = sanitizeCssUrl(playlist?.coverUrl);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate("/playlists")}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:text-[var(--tv-text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回歌单
      </button>

      {playlist && (
        <div className="relative flex flex-col gap-5 overflow-hidden rounded-2xl bg-[var(--tv-surface)]/55 p-4 sm:flex-row sm:items-end sm:gap-6 sm:p-6">
          {headerGlow && (
            <div
              className="pointer-events-none absolute -top-24 left-0 h-72 w-72 rounded-full bg-cover bg-center opacity-20 blur-3xl"
              style={{ backgroundImage: `url("${headerGlow}")` }}
            />
          )}

          <CoverArt
            src={playlist.coverUrl}
            alt={playlist.name}
            className="relative h-32 w-32 shrink-0 shadow-2xl sm:h-44 sm:w-44"
            rounded="rounded-xl"
          />

          <div className="relative min-w-0 flex-1 space-y-2.5 sm:space-y-3">
            <PlatformBadge platform={playlist.platform} subtle />
            <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-3xl">
              {playlist.name}
            </h1>
            <p className="text-xs text-[var(--tv-text-muted)]">
              {playlist.creatorName} · 共 {total.toLocaleString("zh-CN")} 首曲目
            </p>

            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <button
                type="button"
                disabled={songs.length === 0}
                onClick={() => {
                  const first = songs[0];
                  if (first) void audioEngine.playTrack(first, { queue: songs });
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
                  onChange={(e) => {
                    setKeywordInput(e.target.value);
                    setPage(1);
                  }}
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
                <option value="title-asc">按歌名</option>
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
          </div>
        </div>
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
        />
      ) : (
        <>
          <SongTable
            songs={songs}
            indexOffset={(page - 1) * PAGE_SIZE}
            onRemoveTrack={
              playlist?.owned && platform === "netease" ? (song) => removeMutation.mutate(song) : undefined
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
