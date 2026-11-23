import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronUp, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { ArtistLinks } from "../../entities/music/EntityLinks.js";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { CoverArt, EmptyState, PlatformBadge } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

export function AlbumDetailPage() {
  const navigate = useNavigate();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";
  const [descExpanded, setDescExpanded] = useState(false);

  const albumQuery = useQuery({
    queryKey: ["album-detail", platform, id],
    queryFn: () => api.getAlbumDetail(platform, id),
    enabled: Boolean(id),
  });

  const album = albumQuery.data?.album;
  const headerGlow = sanitizeCssUrl(album?.coverUrl);

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
        />
      ) : (
        <>
          <section className="relative flex flex-col gap-5 overflow-hidden rounded-2xl bg-[var(--tv-surface)]/55 p-4 sm:flex-row sm:items-end sm:gap-6 sm:p-6">
            {headerGlow && (
              <div
                className="pointer-events-none absolute -top-24 left-0 h-72 w-72 rounded-full bg-cover bg-center opacity-20 blur-3xl"
                style={{ backgroundImage: `url("${headerGlow}")` }}
              />
            )}

            <CoverArt
              src={album.coverUrl}
              alt={album.name}
              className="relative h-32 w-32 shrink-0 shadow-2xl sm:h-44 sm:w-44"
              rounded="rounded-xl"
            />

            <div className="relative min-w-0 flex-1 space-y-2.5">
              <PlatformBadge platform={album.platform} subtle />
              <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-3xl">
                {album.name}
              </h1>

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

              {album.description && (
                <div className="max-w-2xl">
                  <p
                    className={`whitespace-pre-line text-xs leading-relaxed text-[var(--tv-text-muted)] ${
                      descExpanded ? "" : "line-clamp-2"
                    }`}
                  >
                    {album.description}
                  </p>
                  {album.description.length > 90 && (
                    <button
                      type="button"
                      onClick={() => setDescExpanded((v) => !v)}
                      className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-medium text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
                    >
                      {descExpanded ? (
                        <>
                          收起介绍 <ChevronUp className="h-3 w-3" />
                        </>
                      ) : (
                        <>
                          展开介绍 <ChevronDown className="h-3 w-3" />
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}

              <div className="pt-2">
                <button
                  type="button"
                  disabled={album.songs.length === 0}
                  onClick={() => {
                    const first = album.songs[0];
                    if (first) void audioEngine.playTrack(first, { queue: album.songs });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  播放专辑
                </button>
              </div>
            </div>
          </section>

          <SongTable songs={album.songs} emptyText="专辑内暂无曲目" />
        </>
      )}
    </div>
  );
}
