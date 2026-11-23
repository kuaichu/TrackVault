import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import {
  CoverArt,
  EmptyState,
  ExpandableText,
  PlatformBadge,
  SegmentedTabs,
} from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

export function ArtistDetailPage() {
  const navigate = useNavigate();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const [tab, setTab] = useState<"songs" | "albums">("songs");

  const artistQuery = useQuery({
    queryKey: ["artist-detail", platform, id],
    queryFn: () => api.getArtistDetail(platform, id),
    enabled: Boolean(id),
  });

  const artist = artistQuery.data?.artist;
  const headerGlow = sanitizeCssUrl(artist?.avatarUrl);

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

      {artistQuery.isLoading ? (
        <div className="space-y-6">
          <div className="flex items-center gap-6">
            <div className="h-40 w-40 animate-pulse rounded-full bg-[var(--tv-surface)]" />
            <div className="space-y-3">
              <div className="h-7 w-48 animate-pulse rounded bg-[var(--tv-surface)]" />
              <div className="h-4 w-72 animate-pulse rounded bg-[var(--tv-surface)]" />
            </div>
          </div>
          <div className="space-y-2">
            {["a1", "a2", "a3", "a4", "a5"].map((rowId) => (
              <div key={rowId} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
            ))}
          </div>
        </div>
      ) : artistQuery.isError || !artist ? (
        <EmptyState
          title="未能加载歌手信息"
          description={artistQuery.error instanceof Error ? artistQuery.error.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void artistQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : (
        <>
          {/* Apple Music / YesPlayMusic Artist Header */}
          <section className="relative flex flex-col gap-5 overflow-hidden rounded-2xl bg-[var(--tv-surface)]/55 p-4 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
            {headerGlow && (
              <div
                className="pointer-events-none absolute -top-24 left-0 h-72 w-72 rounded-full bg-cover bg-center opacity-20 blur-3xl"
                style={{ backgroundImage: `url("${headerGlow}")` }}
              />
            )}

            <CoverArt
              src={artist.avatarUrl}
              alt={artist.name}
              className="relative h-28 w-28 shrink-0 shadow-2xl sm:h-40 sm:w-40"
              rounded="rounded-full"
            />

            <div className="relative min-w-0 flex-1 space-y-2.5">
              <PlatformBadge platform={artist.platform} subtle />
              <div className="flex flex-wrap items-baseline gap-2.5">
                <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-3xl">
                  {artist.name}
                </h1>
                {artist.alias && artist.alias.length > 0 && (
                  <span className="text-sm text-[var(--tv-text-muted)]">{artist.alias.join(" / ")}</span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--tv-text-muted)]">
                {typeof artist.songCount === "number" && (
                  <span className="tabular-nums">{artist.songCount} 首单曲</span>
                )}
                {typeof artist.albumCount === "number" && (
                  <>
                    <span>·</span>
                    <span className="tabular-nums">{artist.albumCount} 张专辑</span>
                  </>
                )}
              </div>

              {artist.briefDesc && (
                <ExpandableText
                  text={artist.briefDesc}
                  expandLabel="展开简介"
                  collapseLabel="收起简介"
                  className="max-w-2xl"
                  textClassName="text-xs leading-relaxed text-[var(--tv-text-muted)]"
                />
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={artist.hotSongs.length === 0}
                  onClick={() => {
                    const first = artist.hotSongs[0];
                    if (first) void audioEngine.playTrack(first, { queue: artist.hotSongs });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  播放热门歌曲
                </button>

                <SegmentedTabs
                  value={tab}
                  onChange={setTab}
                  items={[
                    { id: "songs", label: `热门歌曲 (${artist.hotSongs.length})` },
                    { id: "albums", label: `专辑 (${artist.albums.length})` },
                  ]}
                />
              </div>
            </div>
          </section>

          {tab === "songs" ? (
            <SongTable songs={artist.hotSongs} emptyText="暂无热门歌曲" />
          ) : artist.albums.length === 0 ? (
            <EmptyState title="暂无专辑记录" />
          ) : (
            <div className="grid grid-cols-2 gap-x-5 gap-y-7 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {artist.albums.map((alb) => (
                <button
                  key={`${alb.platform}:${alb.id}`}
                  type="button"
                  onClick={() => navigate(`/album/${alb.platform}/${encodeURIComponent(alb.id)}`)}
                  className="group rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
                >
                  <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                    <CoverArt
                      src={alb.coverUrl}
                      alt={alb.name}
                      className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                      rounded="rounded-none"
                    />
                  </div>
                  <div className="mt-2.5 line-clamp-2 text-[13.5px] font-semibold leading-snug text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                    {alb.name}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
                    {alb.publishDate && <span className="tabular-nums">{alb.publishDate}</span>}
                    {alb.publishDate && alb.trackCount ? <span>·</span> : null}
                    {alb.trackCount ? <span className="tabular-nums">{alb.trackCount} 首</span> : null}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
