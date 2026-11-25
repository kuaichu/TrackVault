import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ChartSummary, MusicPlatform } from "#shared";
import { MediaDetailHeader } from "../../entities/music/index.js";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { usePlatformParam } from "../../shared/hooks/use-platform-param.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";
import { SongTable } from "../../widgets/song-table/index.js";

export function ChartsPage() {
  const navigate = useNavigate();
  const { platform, platformReady, setPlatform } = usePlatformParam();
  const [playingChartKey, setPlayingChartKey] = useState<string | null>(null);

  const chartsQuery = useQuery({
    queryKey: ["charts", platform],
    queryFn: () => api.getCharts(platform),
    enabled: platformReady,
  });

  const handlePlayChart = async (chart: ChartSummary) => {
    const key = `${chart.platform}:${chart.id}`;
    if (playingChartKey === key) return;
    setPlayingChartKey(key);
    try {
      const detail = await api.getChartDetail(chart.platform, chart.id);
      const first = findFirstPlayableSong(detail.songs);
      if (!first) {
        toast.info("该榜单暂无可播放曲目");
        return;
      }
      await audioEngine.playTrack(first, { queue: detail.songs });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载榜单曲目失败");
    } finally {
      setPlayingChartKey((prev) => (prev === key ? null : prev));
    }
  };

  const charts = chartsQuery.data?.charts ?? [];

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">排行榜</h1>
        <SegmentedTabs
          value={platform}
          onChange={setPlatform}
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
          {charts.map((chart) => {
            const chartKey = `${chart.platform}:${chart.id}`;
            const isLoadingPlay = playingChartKey === chartKey;
            const openChart = () => navigate(`/charts/${chart.platform}/${encodeURIComponent(chart.id)}`);

            return (
              <div key={chartKey} className="group rounded-xl text-left">
                <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                  <button
                    type="button"
                    onClick={openChart}
                    aria-label={`打开榜单 ${chart.name}`}
                    className="block h-full w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)]"
                  >
                    <CoverArt
                      src={chart.coverUrl}
                      alt={chart.name}
                      className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                      rounded="rounded-none"
                    />
                  </button>
                  {chart.updateFrequency && (
                    <span className="pointer-events-none absolute left-2.5 top-2.5 rounded-md bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-md">
                      {chart.updateFrequency}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={isLoadingPlay}
                    onClick={() => void handlePlayChart(chart)}
                    aria-label={`播放榜单 ${chart.name}`}
                    title={`播放 ${chart.name}`}
                    className="absolute bottom-3 right-3 flex h-10 w-10 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 hover:scale-105 group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100 disabled:opacity-60"
                  >
                    {isLoadingPlay ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    )}
                  </button>
                </div>

                <button type="button" onClick={openChart} className="mt-2.5 block w-full text-left">
                  <div className="line-clamp-1 text-[13.5px] font-semibold text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
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
              </div>
            );
          })}
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
          <MediaDetailHeader
            coverUrl={chart.coverUrl}
            coverAlt={chart.name}
            platform={chart.platform}
            title={chart.name}
            meta={
              <p className="text-xs text-[var(--tv-text-muted)]">
                {chart.updateFrequency ? `${chart.updateFrequency} · ` : ""}共 {songs.length} 首上榜曲目
              </p>
            }
            actions={
              <div className="pt-1">
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
                  播放全部
                </button>
              </div>
            }
          />

          <SongTable songs={songs} emptyText="该榜单暂无曲目" />
        </>
      )}
    </div>
  );
}
