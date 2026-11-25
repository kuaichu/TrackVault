import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Play } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { MusicPlatform } from "#shared";
import { ArtistLinks, MediaDetailHeader } from "../../entities/music/index.js";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { EmptyState } from "../../shared/ui/primitives.js";
import { SongTable } from "../../widgets/song-table/index.js";

export function AlbumDetailPage() {
  const navigate = useNavigate();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const albumQuery = useQuery({
    queryKey: ["album-detail", platform, id],
    queryFn: () => api.getAlbumDetail(platform, id),
    enabled: Boolean(id),
  });

  const album = albumQuery.data?.album;

  return (
    <div className="space-y-7">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:text-[var(--tv-text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回
      </button>

      {albumQuery.isLoading ? (
        <div className="space-y-6">
          <div className="flex items-end gap-6">
            <div className="h-44 w-44 animate-pulse rounded-xl bg-[var(--tv-surface)]" />
            <div className="space-y-3">
              <div className="h-7 w-56 animate-pulse rounded bg-[var(--tv-surface)]" />
              <div className="h-4 w-40 animate-pulse rounded bg-[var(--tv-surface)]" />
            </div>
          </div>
          <div className="space-y-2">
            {["al1", "al2", "al3", "al4", "al5"].map((rowId) => (
              <div key={rowId} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
            ))}
          </div>
        </div>
      ) : albumQuery.isError || !album ? (
        <EmptyState
          title="未能加载专辑信息"
          description={albumQuery.error instanceof Error ? albumQuery.error.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void albumQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : (
        <>
          <MediaDetailHeader
            coverUrl={album.coverUrl}
            coverAlt={album.name}
            platform={album.platform}
            title={album.name}
            description={album.description}
            meta={
              <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--tv-text-muted)]">
                <ArtistLinks
                  platform={album.platform}
                  artists={album.artists}
                  fallbackText="未知歌手"
                  linkClassName="font-medium text-[var(--tv-text)] hover:text-[var(--tv-accent)] hover:underline"
                />
                {album.publishDate && (
                  <>
                    <span>·</span>
                    <span className="text-xs tabular-nums">{album.publishDate}</span>
                  </>
                )}
                {album.company && (
                  <>
                    <span>·</span>
                    <span className="text-xs">{album.company}</span>
                  </>
                )}
                <span>·</span>
                <span className="text-xs tabular-nums">{album.trackCount} 首</span>
              </div>
            }
            actions={
              <div className="pt-2">
                <button
                  type="button"
                  disabled={album.songs.length === 0}
                  onClick={() => {
                    const first = findFirstPlayableSong(album.songs);
                    if (!first) {
                      toast.info("当前列表中的歌曲均不可播放");
                      return;
                    }
                    void audioEngine.playTrack(first, { queue: album.songs });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  播放专辑
                </button>
              </div>
            }
          />

          <SongTable songs={album.songs} emptyText="专辑内暂无曲目" />
        </>
      )}
    </div>
  );
}
