import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Play } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { CoverArt, EmptyState, PlatformBadge, SegmentedTabs } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

export function ChartsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const urlPlatform = searchParams.get("platform");
  const hasExplicitPlatform = urlPlatform === "netease" || urlPlatform === "qq";
  const defaultPlatform: MusicPlatform =
    settingsQuery.data?.settings.providerMode === "qq" ? "qq" : "netease";
  const platform: MusicPlatform = hasExplicitPlatform ? urlPlatform : defaultPlatform;
  const platformReady = hasExplicitPlatform || !settingsQuery.isLoading;

  const chartsQuery = useQuery({
    queryKey: ["charts", platform],
    queryFn: () => api.getCharts(platform),
    enabled: platformReady,
  });

  const charts = chartsQuery.data?.charts ?? [];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">排行榜</h1>
        <SegmentedTabs
          value={platform}
          onChange={(next) => setSearchParams({ platform: next })}
          items={[
            { id: "netease", label: "网易云音乐" },
            { id: "qq", label: "QQ 音乐" },
          ]}
        />
      </div>

      {chartsQuery.isLoading || !platformReady ? (
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"].map((id) => (
            <div key={id} className="space-y-2.5">
              <div className="aspect-square w-full animate-pulse rounded-xl bg-[var(--tv-surface)]" />
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-[var(--tv-surface)]" />
            </div>
          ))}
        </div>
      ) : chartsQuery.isError ? (
        <EmptyState
          title="未能加载排行榜"
          description={chartsQuery.error instanceof Error ? chartsQuery.error.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void chartsQuery.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : charts.length === 0 ? (
        <EmptyState title="暂无榜单数据" />
      ) : (
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {charts.map((chart) => (
            <button
              key={`${chart.platform}:${chart.id}`}
              type="button"
              onClick={() => navigate(`/charts/${chart.platform}/${encodeURIComponent(chart.id)}`)}
              className="group rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
            >
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                <CoverArt
                  src={chart.coverUrl}
                  alt={chart.name}
                  className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                  rounded="rounded-none"
                />
                {chart.updateFrequency && (
                  <span className="absolute left-2.5 top-2.5 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-md">
                    {chart.updateFrequency}
                  </span>
                )}
                <span className="absolute bottom-3 right-3 flex h-10 w-10 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                </span>
              </div>
              <div className="mt-2.5 line-clamp-1 text-[13.5px] font-semibold text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                {chart.name}
              </div>
              {chart.previewTracks && chart.previewTracks.length > 0 ? (
                <div className="mt-1 space-y-0.5 text-[11px] text-[var(--tv-text-muted)]">
                  {chart.previewTracks.slice(0, 2).map((line, i) => (
                    <div key={`${chart.id}-${i}`} className="truncate">
                      {i + 1}. {line}
                    </div>
                  ))}
                </div>
              ) : chart.trackCount ? (
                <div className="mt-1 text-xs tabular-nums text-[var(--tv-text-muted)]">
                  {chart.trackCount} 首
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ChartDetailPage() {
  const navigate = useNavigate();
  const { platform: rawPlatform, id = "" } = useParams();
  const platform: MusicPlatform = rawPlatform === "qq" ? "qq" : "netease";

  const detailQuery = useQuery({
    queryKey: ["chart-detail", platform, id],
    queryFn: () => api.getChartDetail(platform, id),
    enabled: Boolean(id),
  });

  const chart = detailQuery.data?.chart;
  const songs = detailQuery.data?.songs ?? [];
  const headerGlow = sanitizeCssUrl(chart?.coverUrl);

  return (
    <div className="space-y-6">
      <button
        type="button"
        onClick={() => navigate(`/charts?platform=${platform}`)}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:text-[var(--tv-text)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回排行榜
      </button>

      {detailQuery.isLoading ? (
        <div className="space-y-2">
          {["cd1", "cd2", "cd3", "cd4", "cd5", "cd6"].map((rowId) => (
            <div key={rowId} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : detailQuery.isError || !chart ? (
        <EmptyState
          title="未能加载榜单曲目"
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
          <section className="relative flex flex-col gap-5 overflow-hidden rounded-2xl bg-[var(--tv-surface)]/55 p-4 sm:flex-row sm:items-end sm:gap-6 sm:p-6">
            {headerGlow && (
              <div
                className="pointer-events-none absolute -top-24 left-0 h-72 w-72 rounded-full bg-cover bg-center opacity-20 blur-3xl"
                style={{ backgroundImage: `url("${headerGlow}")` }}
              />
            )}

            <CoverArt
              src={chart.coverUrl}
              alt={chart.name}
              className="relative h-32 w-32 shrink-0 shadow-2xl sm:h-44 sm:w-44"
              rounded="rounded-xl"
            />

            <div className="relative min-w-0 flex-1 space-y-2.5 sm:space-y-3">
              <PlatformBadge platform={chart.platform} subtle />
              <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-3xl">
                {chart.name}
              </h1>
              <p className="text-xs text-[var(--tv-text-muted)]">
                {chart.updateFrequency ? `${chart.updateFrequency} · ` : ""}共 {songs.length} 首上榜曲目
              </p>
              <div className="pt-1">
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
                  播放全部
                </button>
              </div>
            </div>
          </section>

          <SongTable songs={songs} emptyText="该榜单暂无曲目" />
        </>
      )}
    </div>
  );
}
