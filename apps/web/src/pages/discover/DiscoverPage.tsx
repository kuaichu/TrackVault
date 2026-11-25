import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PlaylistSummary } from "#shared";
import { ArtistLinks, PlaylistCard } from "../../entities/music/index.js";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { usePlatformParam } from "../../shared/hooks/use-platform-param.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";
import { SongTable } from "../../widgets/song-table/index.js";

function toHeroCoverUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/param=\d+y\d+/, "param=800y800").replace(/T002R\d+x\d+/, "T002R800x800");
}

function PlayTriangleIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M7.5 5.4C7.5 4.2 8.8 3.48 9.82 4.11L19.6 10.21C20.56 10.81 20.56 12.19 19.6 12.79L9.82 18.89C8.8 19.52 7.5 18.8 7.5 17.6V5.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function DiscoverPage() {
  const navigate = useNavigate();
  const [section, setSection] = useState<"discover" | "daily">("discover");
  const { platform, platformReady, setPlatform } = usePlatformParam();
  const [playingPlaylistKey, setPlayingPlaylistKey] = useState<string | null>(null);

  const discoverQuery = useQuery({
    queryKey: ["discover", platform],
    queryFn: () => api.getDiscover(platform),
    enabled: section === "discover" && platformReady,
  });

  const recPlaylistsQuery = useQuery({
    queryKey: ["discover-playlists", platform],
    queryFn: () => api.getRecommendedPlaylists(platform),
    enabled: section === "discover" && platformReady,
  });

  const dailyQuery = useQuery({
    queryKey: ["daily-recommend"],
    queryFn: () => api.getDailyRecommend(),
    enabled: section === "daily",
  });

  const handlePlayPlaylist = async (pl: PlaylistSummary) => {
    const key = `${pl.platform}:${pl.id}`;
    if (playingPlaylistKey === key) return;
    setPlayingPlaylistKey(key);
    try {
      const res = await api.getPlaylistTracks(pl.platform, pl.id, { page: 1, limit: 50 });
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

  const activeQuery = section === "discover" ? discoverQuery : dailyQuery;
  const songs = activeQuery.data?.songs ?? [];
  const recPlaylists = recPlaylistsQuery.data?.playlists ?? [];
  const leadSong = findFirstPlayableSong(songs) ?? songs[0];
  const quickPicks = songs.slice(0, 6);
  const heroCoverUrl = toHeroCoverUrl(leadSong?.coverUrl);
  const songsLoading = activeQuery.isLoading || (section === "discover" && !platformReady);
  const playlistsLoading = recPlaylistsQuery.isLoading || !platformReady;

  return (
    <div className="space-y-8 sm:space-y-10">
      {/* Apple Music Large Editorial Page Title + Hairline Rule + Right-Aligned Mode Controls */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-[var(--tv-border)] pb-3.5">
        <h1 className="text-[30px] leading-none font-extrabold tracking-tight text-[var(--tv-text)] sm:text-[34px]">
          发现
        </h1>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs
            value={section}
            onChange={setSection}
            items={[
              { id: "discover", label: "新歌速递" },
              { id: "daily", label: "每日推荐" },
            ]}
          />

          {section === "discover" && (
            <SegmentedTabs
              value={platform}
              onChange={setPlatform}
              items={[
                { id: "netease", label: "网易云" },
                { id: "qq", label: "QQ 音乐" },
              ]}
            />
          )}

          <button
            type="button"
            onClick={() => {
              void activeQuery.refetch();
              if (section === "discover") void recPlaylistsQuery.refetch();
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            title="刷新"
            aria-label="刷新列表"
          >
            <RefreshCw
              className={`h-4 w-4 ${activeQuery.isFetching || (section === "discover" && recPlaylistsQuery.isFetching) ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* Editorial Showcase Hero + Borderless Apple Music Track Shelf */}
      {activeQuery.isError ? (
        <EmptyState
          title="暂时无法获取推荐曲目"
          description={
            activeQuery.error instanceof Error
              ? activeQuery.error.message
              : "请先在设置中绑定网易云或 QQ 音乐账号"
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => void activeQuery.refetch()}
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
      ) : songsLoading ? (
        <div className="space-y-6">
          <div className="grid gap-7 lg:grid-cols-[1.06fr_1fr]">
            <div className="h-[268px] animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {["sk1", "sk2", "sk3", "sk4", "sk5", "sk6"].map((id) => (
                <div key={id} className="h-16 animate-pulse rounded-xl bg-[var(--tv-surface)]/60" />
              ))}
            </div>
          </div>
          <div className="space-y-2">
            {["r1", "r2", "r3", "r4", "r5"].map((id) => (
              <div key={id} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
            ))}
          </div>
        </div>
      ) : songs.length === 0 ? (
        <EmptyState
          title="暂无推荐内容"
          description="绑定平台账号后即可浏览个性化每日推荐与新歌。"
          action={
            <Link
              to="/settings"
              className="inline-flex items-center rounded-lg bg-[var(--tv-surface)] px-4 py-2 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            >
              打开账号设置
            </Link>
          }
        />
      ) : (
        <section className="grid items-end gap-7 lg:grid-cols-[1.05fr_1fr]">
          {/* Left: Magazine Editorial Showcase Card (external eyebrow + full-bleed cover + bottom frosted bar) */}
          <div className="space-y-2">
            <div>
              <div className="text-[11px] font-semibold tracking-wider text-[var(--tv-text-subtle)] uppercase">
                {section === "daily"
                  ? "FOR YOU · 个性化推荐"
                  : platform === "netease"
                    ? "精选推荐 · 网易云音乐"
                    : "精选推荐 · QQ 音乐"}
              </div>
              <div className="mt-0.5 text-[16px] font-semibold tracking-tight text-[var(--tv-text)]">
                {section === "daily" ? "每日私享歌单" : "今日新歌精选"}
              </div>
            </div>

            <div className="group relative flex h-[236px] flex-col justify-end overflow-hidden rounded-[14px] bg-[#18181c] text-white shadow-lg sm:h-[252px]">
              {heroCoverUrl && (
                <CoverArt
                  src={heroCoverUrl}
                  alt={leadSong?.title ?? "精选封面"}
                  darkBackdrop
                  rounded="rounded-none"
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
                />
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/88 via-black/32 to-black/5" />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[14px]"
                style={{ boxShadow: "inset 0 0 0 0.5px rgba(255, 255, 255, 0.14)" }}
              />

              <div className="relative flex items-end justify-between gap-4 bg-gradient-to-t from-black/55 to-transparent px-5 pt-8 pb-4.5 backdrop-blur-[2px]">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h2 className="truncate text-lg font-bold tracking-tight text-white sm:text-xl">
                    {leadSong?.title ?? (section === "daily" ? "每日推荐" : "今日新歌精选")}
                  </h2>
                  <p className="truncate text-xs text-white/72">
                    {leadSong?.artist ? `${leadSong.artist} · ` : ""}共 {songs.length} 首精选曲目
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const first = findFirstPlayableSong(songs);
                    if (!first) {
                      toast.info("当前列表中的歌曲均不可播放");
                      return;
                    }
                    void audioEngine.playTrack(first, { queue: songs });
                  }}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/20 px-4 py-2 text-xs font-semibold text-white ring-1 ring-white/25 backdrop-blur-xl transition-all duration-200 hover:scale-[1.03] hover:bg-white hover:text-[#111113] active:scale-95"
                >
                  <PlayTriangleIcon className="h-3.5 w-3.5" />
                  播放全部
                </button>
              </div>
            </div>
          </div>

          {/* Right: Borderless Apple Music Track List on Pure Canvas (zero card boxes, inset hairline dividers) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[16px] font-semibold tracking-tight text-[var(--tv-text)]">
                {section === "daily" ? "今日主打" : "最新单曲"}
              </div>
              <span className="text-xs text-[var(--tv-text-subtle)]">点击即播</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 sm:gap-x-6">
              {quickPicks.map((song, idx) => {
                const isBottomRowInTwoCol = idx >= quickPicks.length - 2;
                const isLastOverall = idx === quickPicks.length - 1;
                return (
                  <div
                    key={`${song.platform}:${song.id}`}
                    className="group relative flex items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-[var(--tv-surface-hover)]"
                  >
                    <button
                      type="button"
                      onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                      className="relative shrink-0 overflow-hidden rounded-[8px]"
                      aria-label={`播放 ${song.title}`}
                    >
                      <CoverArt
                        src={song.coverUrl}
                        alt={song.title}
                        className="h-[52px] w-[52px]"
                        rounded="rounded-[8px]"
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 rounded-[8px]"
                        style={{ boxShadow: "var(--tv-cover-ring)" }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center rounded-[8px] bg-black/45 opacity-0 backdrop-blur-[1px] transition-opacity duration-150 group-hover:opacity-100">
                        <PlayTriangleIcon className="h-4 w-4 text-white" />
                      </span>
                    </button>

                    <div className="relative flex h-[52px] min-w-0 flex-1 flex-col justify-center">
                      <button
                        type="button"
                        onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                        className="block w-full truncate text-left text-[13.5px] leading-snug font-medium text-[var(--tv-text)]"
                      >
                        {song.title}
                      </button>
                      <div className="mt-0.5 truncate text-xs leading-snug text-[var(--tv-text-muted)]">
                        <ArtistLinks
                          platform={song.platform}
                          artists={song.artists}
                          fallbackText={song.artist}
                          primaryArtistId={song.primaryArtistId}
                          linkClassName="transition-colors hover:text-[var(--tv-text)]"
                        />
                      </div>

                      {/* Apple Music text-aligned hairline divider (hidden on bottom row & on row hover) */}
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none absolute right-0 -bottom-2.5 left-0 border-b border-[var(--tv-border)] transition-opacity group-hover:opacity-0 ${
                          isLastOverall ? "hidden" : isBottomRowInTwoCol ? "sm:hidden" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Apple Music Section Shelf: Recommended Playlists */}
      {section === "discover" && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <Link
              to={`/playlists?platform=${platform}`}
              className="group inline-flex items-center gap-0.5 text-[19px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[20px]"
            >
              <span>推荐歌单</span>
              <ChevronRight className="h-5 w-5 text-[var(--tv-text-subtle)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[var(--tv-text)]" />
            </Link>
          </div>
          {playlistsLoading ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-5">
              {["rp1", "rp2", "rp3", "rp4", "rp5"].map((id) => (
                <div key={id} className="space-y-2">
                  <div className="aspect-square w-full animate-pulse rounded-[11px] bg-[var(--tv-surface)]" />
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-[var(--tv-surface)]" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--tv-surface)]" />
                </div>
              ))}
            </div>
          ) : recPlaylistsQuery.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--tv-surface)] px-4 py-3.5 text-xs">
              <div className="space-y-0.5">
                <div className="font-medium text-[var(--tv-text)]">未能加载推荐歌单</div>
                <div className="text-[var(--tv-text-muted)]">
                  {recPlaylistsQuery.error instanceof Error ? recPlaylistsQuery.error.message : "请稍后重试"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void recPlaylistsQuery.refetch()}
                className="rounded-lg bg-[var(--tv-accent)] px-3.5 py-1.5 font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
              >
                重试
              </button>
            </div>
          ) : recPlaylists.length === 0 ? (
            <div className="rounded-xl bg-[var(--tv-surface)]/60 px-4 py-6 text-center text-xs text-[var(--tv-text-muted)]">
              暂无推荐歌单
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-5">
              {recPlaylists.slice(0, 10).map((pl) => {
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
                        <span className="truncate">{pl.creatorName}</span>
                        {pl.trackCount > 0 && (
                          <>
                            <span className="opacity-50">·</span>
                            <span className="shrink-0 tabular-nums">{pl.trackCount} 首</span>
                          </>
                        )}
                      </>
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Full Dense Track Table */}
      {!activeQuery.isError && !songsLoading && songs.length > 0 && (
        <section className="space-y-3.5">
          <h2 className="text-[19px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[20px]">
            全部曲目
          </h2>
          <SongTable songs={songs} showHeaderMeta={false} showPlatformBadge={section !== "discover"} />
        </section>
      )}
    </div>
  );
}
