import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ListMusic, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { MusicPlatform, PlaylistSort, Song } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

export function PlaylistsPage() {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<MusicPlatform>("netease");

  const playlistsQuery = useQuery({
    queryKey: ["playlists", platform],
    queryFn: () => api.getUserPlaylists(platform),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">我的歌单</h1>
          <p className="text-xs text-[var(--tv-text-muted)]">支持网易云音乐与 QQ 音乐自建及收藏歌单</p>
        </div>
        <div className="inline-flex rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-1 text-xs">
          {(["netease", "qq"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPlatform(p)}
              className={`rounded-lg px-3 py-1.5 ${
                platform === p ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
              }`}
            >
              {p === "netease" ? "网易云歌单" : "QQ 音乐歌单"}
            </button>
          ))}
        </div>
      </div>

      {playlistsQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">加载歌单列表中...</div>
      ) : playlistsQuery.isError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-5 text-sm text-rose-200">
          {playlistsQuery.error instanceof Error
            ? playlistsQuery.error.message
            : "获取歌单失败，请先在设置中绑定对应平台账号"}
        </div>
      ) : (playlistsQuery.data?.playlists.length ?? 0) === 0 ? (
        <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] py-16 text-center text-sm text-[var(--tv-text-muted)]">
          暂无歌单
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {playlistsQuery.data?.playlists.map((pl) => (
            <button
              key={`${pl.platform}:${pl.id}`}
              type="button"
              onClick={() => navigate(`/playlists/${pl.platform}/${encodeURIComponent(pl.id)}`)}
              className="group flex items-center gap-3.5 rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-3 text-left transition-all hover:border-amber-400/40 hover:bg-[var(--tv-surface-hover)]"
            >
              <CoverArt src={pl.coverUrl} alt={pl.name} className="h-16 w-16 rounded-xl" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="truncate text-sm font-semibold text-white group-hover:text-amber-300">
                  {pl.name}
                </div>
                <div className="flex items-center gap-2 text-xs text-[var(--tv-text-muted)]">
                  <span>{pl.trackCount} 首</span>
                  <PlatformBadge platform={pl.platform} />
                </div>
                <div className="truncate text-[11px] text-[var(--tv-text-subtle)]">
                  {pl.owned ? "自建" : `by ${pl.creatorName}`}
                </div>
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
  const queryClient = useQueryClient();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<PlaylistSort>("default");

  const detailQuery = useQuery({
    queryKey: ["playlist-tracks", platform, id, page, keyword, sort],
    queryFn: () => api.getPlaylistTracks(platform, id, { page, limit: 100, keyword, sort }),
    enabled: Boolean(id),
  });

  const removeMutation = useMutation({
    mutationFn: (song: Song) => api.removeTracksFromPlaylist(platform, id, [song.id]),
    onSuccess: () => {
      toast.success("已从歌单移除该曲目");
      void queryClient.invalidateQueries({ queryKey: ["playlist-tracks", platform, id] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "移除失败"),
  });

  const playlist = detailQuery.data?.playlist;
  const songs = detailQuery.data?.songs ?? [];

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => navigate("/playlists")}
        className="inline-flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)] hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回我的歌单
      </button>

      {playlist && (
        <div className="flex flex-wrap items-center gap-5 rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-5">
          <CoverArt src={playlist.coverUrl} alt={playlist.name} className="h-24 w-24 rounded-2xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-white">{playlist.name}</h1>
              <PlatformBadge platform={playlist.platform} />
            </div>
            <p className="text-xs text-[var(--tv-text-muted)]">
              创建者：{playlist.creatorName} · 共 {playlist.trackCount} 首
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={songs.length === 0}
                onClick={() => {
                  const first = songs[0];
                  if (first) void audioEngine.playTrack(first, { queue: songs });
                }}
                className="inline-flex items-center gap-1.5 rounded-xl bg-amber-400 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                播放全部
              </button>
              <input
                type="text"
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value);
                  setPage(1);
                }}
                placeholder="歌单内筛选..."
                className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-1.5 text-xs text-white focus:border-amber-400/60 focus:outline-none"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as PlaylistSort)}
                className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-1.5 text-xs text-white focus:border-amber-400/60 focus:outline-none"
              >
                <option value="default">默认排序</option>
                <option value="title-asc">歌名 A-Z</option>
                <option value="artist-asc">歌手 A-Z</option>
                <option value="duration-desc">时长降序</option>
                <option value="duration-asc">时长升序</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {detailQuery.isLoading ? (
        <div className="py-12 text-center text-sm text-[var(--tv-text-muted)]">
          <ListMusic className="mx-auto mb-2 h-6 w-6 animate-pulse text-amber-400" />
          加载歌单曲目中...
        </div>
      ) : (
        <>
          <SongTable
            songs={songs}
            onRemoveTrack={
              playlist?.owned && platform === "netease" ? (song) => removeMutation.mutate(song) : undefined
            }
          />
          <div className="flex items-center justify-center gap-3 text-xs text-[var(--tv-text-muted)]">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-[var(--tv-border)] px-3 py-1.5 hover:bg-white/5 disabled:opacity-40"
            >
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              type="button"
              disabled={!detailQuery.data?.hasMore}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-[var(--tv-border)] px-3 py-1.5 hover:bg-white/5 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
