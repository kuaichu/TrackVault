import { useQuery } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type MusicPlatform, sanitizeCssUrl } from "#shared";
import { ArtistLinks } from "../../entities/music/EntityLinks.js";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { CoverArt, EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";
import { audioEngine } from "../player/engine/audio-engine.js";

export function DiscoverPage() {
  const navigate = useNavigate();
  const [section, setSection] = useState<"discover" | "daily">("discover");
  const [platform, setPlatform] = useState<MusicPlatform>("netease");

  const discoverQuery = useQuery({
    queryKey: ["discover", platform],
    queryFn: () => api.getDiscover(platform),
    enabled: section === "discover",
  });

  const recPlaylistsQuery = useQuery({
    queryKey: ["discover-playlists", platform],
    queryFn: () => api.getRecommendedPlaylists(platform),
    enabled: section === "discover",
  });

  const dailyQuery = useQuery({
    queryKey: ["daily-recommend"],
    queryFn: () => api.getDailyRecommend(),
    enabled: section === "daily",
  });

  const activeQuery = section === "discover" ? discoverQuery : dailyQuery;
  const songs = activeQuery.data?.songs ?? [];
  const recPlaylists = recPlaylistsQuery.data?.playlists ?? [];
  const leadSong = songs[0];
  const quickPicks = songs.slice(0, 4);
  const heroBg = sanitizeCssUrl(leadSong?.coverUrl);

  return (
    <div className="space-y-7 sm:space-y-9">
      {/* Editorial Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
        <div className="flex flex-wrap items-center gap-3 sm:gap-5">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)] sm:text-[28px]">发现</h1>
          <SegmentedTabs
            value={section}
            onChange={setSection}
            items={[
              { id: "discover", label: "新歌速递" },
              { id: "daily", label: "每日推荐" },
            ]}
          />
        </div>

        <div className="flex items-center gap-2">
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            title="刷新"
            aria-label="刷新列表"
          >
            <RefreshCw className={`h-4 w-4 ${activeQuery.isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {activeQuery.isError ? (
        <EmptyState
          title="暂时无法获取推荐曲目"
          description={
            activeQuery.error instanceof Error
              ? activeQuery.error.message
              : "请先在设置中绑定网易云或 QQ 音乐账号"
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
      ) : activeQuery.isLoading ? (
        <div className="space-y-6">
          <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr]">
            <div className="h-44 animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
            <div className="grid grid-cols-2 gap-3">
              {["sk1", "sk2", "sk3", "sk4"].map((id) => (
                <div key={id} className="h-[82px] animate-pulse rounded-xl bg-[var(--tv-surface)]" />
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
        <>
          {/* YesPlayMusic-inspired Featured Hero + 2x2 Quick Picks */}
          <section className="grid gap-5 lg:grid-cols-[1.12fr_1fr]">
            <div className="group relative flex min-h-[176px] flex-col justify-between overflow-hidden rounded-2xl bg-[#1a1a1e] p-6 text-white">
              {heroBg && (
                <div
                  className="pointer-events-none absolute inset-0 scale-110 bg-cover bg-center opacity-55 blur-2xl saturate-150 transition-transform duration-700 group-hover:scale-125"
                  style={{ backgroundImage: `url("${heroBg}")` }}
                />
              )}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-black/75 via-black/45 to-black/25" />

              <div className="relative flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-widest text-white/65">
                    {section === "daily" ? "FOR YOU" : platform === "netease" ? "NETEASE" : "QQ MUSIC"}
                  </div>
                  <h2 className="mt-1.5 text-2xl font-bold tracking-tight">
                    {section === "daily" ? "每日推荐" : "今日新歌精选"}
                  </h2>
                  <p className="mt-1 text-xs text-white/70">
                    共 {songs.length} 首 · 从「{leadSong?.title}」开始收听
                  </p>
                </div>

                {leadSong && (
                  <CoverArt
                    src={leadSong.coverUrl}
                    alt={leadSong.title}
                    className="hidden h-20 w-20 shadow-2xl sm:block"
                    rounded="rounded-xl"
                  />
                )}
              </div>

              <div className="relative mt-5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (leadSong) void audioEngine.playTrack(leadSong, { queue: songs });
                  }}
                  className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-xs font-semibold text-[#111113] shadow-lg transition-transform hover:scale-[1.03] active:scale-95"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  播放全部
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {quickPicks.map((song) => (
                <div
                  key={`${song.platform}:${song.id}`}
                  className="group flex items-center gap-3 rounded-xl bg-[var(--tv-surface)] p-2.5 text-left transition-colors hover:bg-[var(--tv-surface-active)]"
                >
                  <button
                    type="button"
                    onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                    className="relative shrink-0"
                    aria-label={`播放 ${song.title}`}
                  >
                    <CoverArt
                      src={song.coverUrl}
                      alt={song.title}
                      className="h-14 w-14"
                      rounded="rounded-lg"
                    />
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                      <Play className="h-4 w-4 fill-white text-white" />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                      className="block w-full truncate text-left text-[13.5px] font-semibold text-[var(--tv-text)] hover:text-[var(--tv-accent)]"
                    >
                      {song.title}
                    </button>
                    <div className="mt-0.5 truncate text-xs text-[var(--tv-text-muted)]">
                      <ArtistLinks
                        platform={song.platform}
                        artists={song.artists}
                        fallbackText={song.artist}
                        primaryArtistId={song.primaryArtistId}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* YesPlayMusic-inspired Recommended Playlists Shelf */}
          {section === "discover" && recPlaylists.length > 0 && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold tracking-tight text-[var(--tv-text)]">推荐歌单</h2>
                <Link
                  to="/charts"
                  className="text-xs font-medium text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                >
                  查看排行榜 ›
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-6 md:grid-cols-5">
                {recPlaylists.slice(0, 10).map((pl) => (
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
                      <span className="absolute bottom-2.5 right-2.5 flex h-9 w-9 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="ml-0.5 h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <div className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                      {pl.name}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Full Dense Track Table */}
          <section className="space-y-3">
            <h2 className="text-lg font-bold tracking-tight text-[var(--tv-text)]">全部曲目</h2>
            <SongTable songs={songs} />
          </section>
        </>
      )}
    </div>
  );
}
