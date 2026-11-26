import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import { type TouchEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type PlaylistSummary, getPlatformDisplayName, getSongKey, sanitizeExternalUrl } from "#shared";
import { ArtistLinks, PlaylistCard } from "../../entities/music/index.js";
import { findFirstPlayableSong } from "../../entities/song/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { usePlatformParam } from "../../shared/hooks/use-platform-param.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";
import { SongTable, useStandaloneSongMenu } from "../../widgets/song-table/index.js";

function toHeroCoverUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return url
    .replace(/param=\d+y\d+/, "param=800y800")
    .replace(/T002R\d+x\d+/, "T002R800x800")
    .replace(/\/(stdmusic|custom|mcommon)\/(?:240|400)\//, "/$1/480/");
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
  const songsLoading = activeQuery.isLoading || (section === "discover" && !platformReady);
  const playlistsLoading = recPlaylistsQuery.isLoading || !platformReady;
  const isRefreshing = activeQuery.isFetching || (section === "discover" && recPlaylistsQuery.isFetching);

  const allTracksSectionRef = useRef<HTMLElement | null>(null);
  const platformMenuRef = useRef<HTMLDivElement | null>(null);
  const pullStartYRef = useRef<number | null>(null);
  const [platformMenuOpen, setPlatformMenuOpen] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const quickPickMenu = useStandaloneSongMenu(quickPicks);

  useEffect(() => {
    if (!platformMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (platformMenuRef.current && !platformMenuRef.current.contains(event.target as Node)) {
        setPlatformMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlatformMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [platformMenuOpen]);

  const triggerRefresh = () => {
    void activeQuery.refetch();
    if (section === "discover") void recPlaylistsQuery.refetch();
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, [role='menu'], [data-discover-carousel='true']")) {
      pullStartYRef.current = null;
      return;
    }
    const mainScrollEl = event.currentTarget.closest("main");
    if (mainScrollEl && mainScrollEl.scrollTop > 2) {
      pullStartYRef.current = null;
      return;
    }
    pullStartYRef.current = event.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const startY = pullStartYRef.current;
    if (startY === null) return;
    const currentY = event.touches[0]?.clientY ?? startY;
    const delta = currentY - startY;
    if (delta > 8) {
      setPullDistance(Math.min(80, Math.round(delta * 0.55)));
    } else if (pullDistance > 0) {
      setPullDistance(0);
    }
  };

  const handleTouchEnd = () => {
    if (pullDistance >= 52 && !isRefreshing) {
      triggerRefresh();
    }
    pullStartYRef.current = null;
    setPullDistance(0);
  };

  const platformLabel = getPlatformDisplayName(platform);
  const showcaseCards: Array<{
    id: string;
    eyebrow: string;
    heading: string;
    title: string;
    subtitle: string;
    coverUrl?: string;
    ctaLabel: string;
    desktopVisible: boolean;
    loading?: boolean;
    onPrimaryAction: () => void;
    onOpenCard?: () => void;
  }> = [
    {
      id: "hero-lead",
      eyebrow: section === "daily" ? "FOR YOU · 个性化推荐" : `精选推荐 · ${platformLabel}`,
      heading: section === "daily" ? "每日私享歌单" : "今日新歌精选",
      title: leadSong?.title ?? (section === "daily" ? "每日推荐" : "今日新歌精选"),
      subtitle: `${leadSong?.artist ? `${leadSong.artist} · ` : ""}共 ${songs.length} 首精选曲目`,
      coverUrl: toHeroCoverUrl(leadSong?.coverUrl),
      ctaLabel: "播放全部",
      desktopVisible: true,
      onPrimaryAction: () => {
        const first = findFirstPlayableSong(songs);
        if (!first) {
          toast.info("当前列表中的歌曲均不可播放");
          return;
        }
        void audioEngine.playTrack(first, { queue: songs });
      },
    },
  ];

  if (section === "discover" && recPlaylists.length > 0) {
    for (const pl of recPlaylists.slice(0, 3)) {
      const key = `${pl.platform}:${pl.id}`;
      showcaseCards.push({
        id: `pl-${key}`,
        eyebrow: `甄选歌单 · ${platformLabel}`,
        heading: "编辑精选歌单",
        title: pl.name,
        subtitle: `${pl.creatorName}${pl.trackCount > 0 ? ` · ${pl.trackCount} 首` : ""}`,
        coverUrl: toHeroCoverUrl(pl.coverUrl),
        ctaLabel: "播放",
        desktopVisible: false,
        loading: playingPlaylistKey === key,
        onPrimaryAction: () => void handlePlayPlaylist(pl),
        onOpenCard: () =>
          navigate(`/playlists/${pl.platform}/${encodeURIComponent(pl.id)}`, {
            state: { playlist: pl },
          }),
      });
    }
  } else {
    for (const extraSong of songs.slice(1, 3)) {
      showcaseCards.push({
        id: `song-${getSongKey(extraSong)}`,
        eyebrow: section === "daily" ? "今日心选单曲" : `新歌主打 · ${platformLabel}`,
        heading: "热门新发单曲",
        title: extraSong.title,
        subtitle: `${extraSong.artist}${extraSong.album ? ` · ${extraSong.album}` : ""}`,
        coverUrl: toHeroCoverUrl(extraSong.coverUrl),
        ctaLabel: "播放",
        desktopVisible: false,
        onPrimaryAction: () => void audioEngine.playTrack(extraSong, { queue: songs }),
      });
    }
  }

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="space-y-6 sm:space-y-10"
    >
      {/* Mobile Pull-to-Refresh Pill Indicator */}
      {pullDistance > 12 && (
        <div
          className="flex items-center justify-center transition-all sm:hidden"
          style={{ height: `${Math.min(40, pullDistance)}px` }}
        >
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-surface)] px-3 py-1 text-[11px] font-medium text-[var(--tv-text-muted)] shadow-xs">
            <RefreshCw
              className={`h-3 w-3 ${pullDistance >= 52 ? "rotate-180 text-[var(--tv-accent)]" : ""} transition-transform`}
            />
            {pullDistance >= 52 ? "松开刷新推荐" : "下拉刷新"}
          </span>
        </div>
      )}

      {/* Clean 2-Layer Mobile Header (Row 1: 发现 + 网易云 ▾ + A Avatar; Row 2: Full-Width Segmented Bar) */}
      <div
        data-custom-avatar-inset="true"
        className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-3 sm:flex sm:items-end sm:justify-between sm:gap-4 sm:border-b sm:border-[var(--tv-border)] sm:pb-3.5"
      >
        <h1 className="text-[30px] leading-none font-extrabold tracking-tight text-[var(--tv-text)] sm:text-[34px]">
          发现
        </h1>

        <div className="col-span-2 row-start-2 sm:col-span-1 sm:row-auto sm:ml-auto">
          <SegmentedTabs
            fullWidthOnMobile
            value={section}
            onChange={setSection}
            items={[
              { id: "discover", label: "新歌速递" },
              { id: "daily", label: "每日推荐" },
            ]}
          />
        </div>

        <div className="col-start-2 row-start-1 flex min-h-8 items-center justify-self-end pr-[42px] sm:col-auto sm:row-auto sm:gap-2 md:pr-0">
          {/* Mobile (< sm): single compact '网易云 ▾' dropdown pill + refresh inside popover */}
          <div ref={platformMenuRef} className="relative sm:hidden">
            {section === "discover" ? (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={platformMenuOpen}
                onClick={() => setPlatformMenuOpen((v) => !v)}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--tv-lcd-bg)] px-3 text-xs font-semibold text-[var(--tv-text)] ring-1 ring-[var(--tv-sidebar-border)] ring-inset transition-colors active:scale-95"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    platform === "netease"
                      ? "bg-[var(--tv-netease)]"
                      : platform === "qq"
                        ? "bg-[var(--tv-qq)]"
                        : "bg-[var(--tv-kugou)]"
                  }`}
                />
                <span>{platform === "netease" ? "网易云" : platform === "qq" ? "QQ 音乐" : "酷狗"}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-[var(--tv-text-subtle)] transition-transform ${
                    platformMenuOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={triggerRefresh}
                className="inline-flex h-8 items-center gap-1 rounded-full bg-[var(--tv-lcd-bg)] px-2.5 text-xs font-medium text-[var(--tv-text-muted)] ring-1 ring-[var(--tv-sidebar-border)] ring-inset active:scale-95"
                aria-label="刷新每日推荐"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                <span>刷新</span>
              </button>
            )}

            {platformMenuOpen && section === "discover" && (
              <div
                role="menu"
                aria-label="选择推荐音源"
                className="tv-popover-in absolute top-full right-0 mt-1.5 w-40 rounded-2xl border border-[var(--tv-glass-border)] bg-[var(--tv-drawer-glass-bg)] p-1.5 shadow-[var(--tv-glass-shadow)] backdrop-blur-[28px] backdrop-saturate-[190%]"
                style={{ zIndex: "var(--tv-z-dropdown)" }}
              >
                {(
                  [
                    { id: "netease", label: "网易云音乐", dot: "bg-[var(--tv-netease)]" },
                    { id: "qq", label: "QQ 音乐", dot: "bg-[var(--tv-qq)]" },
                    { id: "kugou", label: "酷狗音乐", dot: "bg-[var(--tv-kugou)]" },
                  ] as const
                ).map((item) => {
                  const selected = platform === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      onClick={() => {
                        setPlatform(item.id);
                        setPlatformMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors ${
                        selected
                          ? "bg-[var(--tv-nav-active)] font-semibold text-[var(--tv-text)]"
                          : "font-medium text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)]"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
                        {item.label}
                      </span>
                      {selected && <Check className="h-3.5 w-3.5 text-[var(--tv-accent)]" />}
                    </button>
                  );
                })}
                <div className="my-1" style={{ borderTop: "0.5px solid var(--tv-ios-hairline)" }} />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlatformMenuOpen(false);
                    triggerRefresh();
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
                  刷新推荐
                </button>
              </div>
            )}
          </div>

          {/* Desktop (>= sm): inline platform segmented tabs + refresh button */}
          <div className="hidden items-center gap-2 sm:flex">
            {section === "discover" && (
              <SegmentedTabs
                compact
                value={platform}
                onChange={setPlatform}
                items={[
                  { id: "netease", label: "网易云" },
                  { id: "qq", label: "QQ 音乐" },
                  { id: "kugou", label: "酷狗音乐" },
                ]}
              />
            )}

            <button
              type="button"
              onClick={triggerRefresh}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
              title="刷新"
              aria-label="刷新列表"
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
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
        <section className="grid grid-cols-1 items-end gap-7 lg:grid-cols-[1.05fr_1fr]">
          {/* Left: Tall iOS Apple Music Showcase Carousel (scroll-pl-4 keeps Card 1 aligned at 16px, never snapped into -mx-4) */}
          <div className="min-w-0">
            <div
              data-discover-carousel="true"
              className="tv-no-scrollbar -mx-4 flex scroll-px-4 snap-x snap-mandatory gap-3 overflow-x-auto px-4 after:w-1 after:shrink-0 sm:mx-0 sm:scroll-px-0 sm:px-0 sm:after:hidden lg:block"
            >
              {showcaseCards.map((card) => {
                const safeBackdropUrl = sanitizeExternalUrl(card.coverUrl);
                return (
                  <div
                    key={card.id}
                    className={`snap-start space-y-2 ${
                      showcaseCards.length > 1
                        ? "w-[calc(100vw-3.25rem)] max-w-[364px] shrink-0 sm:w-[320px] lg:w-full lg:max-w-none"
                        : "w-full"
                    } ${card.desktopVisible ? "" : "lg:hidden"}`}
                  >
                    <div className="min-w-0 pr-2">
                      <div className="truncate text-[11px] font-semibold tracking-wider text-[var(--tv-text-subtle)] uppercase">
                        {card.eyebrow}
                      </div>
                      <div className="mt-0.5 truncate text-[16.5px] font-bold tracking-tight text-[var(--tv-text)]">
                        {card.heading}
                      </div>
                    </div>

                    <div className="group relative flex h-[312px] flex-col justify-between overflow-hidden rounded-[16px] bg-[#18181d] text-white shadow-xl sm:h-[304px]">
                      {/* Layer 1: Softly blurred ambient cover backdrop (dissolves any raw cover white borders) */}
                      {safeBackdropUrl && (
                        <img
                          src={safeBackdropUrl}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-80 blur-[36px] saturate-[165%] transition-transform duration-700 group-hover:scale-[1.32]"
                        />
                      )}
                      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/18 via-black/30 to-black/84" />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 rounded-[16px]"
                        style={{ boxShadow: "inset 0 0 0 0.5px rgba(255, 255, 255, 0.14)" }}
                      />

                      {/* Layer 2: Complete uncropped 1:1 square artwork centerpiece */}
                      <div className="relative flex flex-1 items-center justify-center pt-4">
                        <button
                          type="button"
                          onClick={card.onOpenCard ?? card.onPrimaryAction}
                          className="relative rounded-[12px] transition-transform duration-500 ease-out group-hover:scale-[1.03] active:scale-95"
                          aria-label={`${card.ctaLabel} ${card.title}`}
                        >
                          <CoverArt
                            src={card.coverUrl}
                            alt={card.title}
                            darkBackdrop
                            rounded="rounded-[12px]"
                            className="h-[168px] w-[168px] shadow-[0_20px_44px_-10px_rgba(0,0,0,0.72)] ring-1 ring-white/18 sm:h-[164px] sm:w-[164px]"
                          />
                        </button>
                      </div>

                      {/* Layer 3: Bottom caption + vertically centered Play pill */}
                      <div className="relative flex items-center justify-between gap-3.5 bg-gradient-to-t from-black/78 via-black/42 to-transparent px-4.5 pt-4 pb-4">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <h2 className="truncate text-[17px] font-bold tracking-tight text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)] sm:text-lg">
                            {card.title}
                          </h2>
                          <p className="truncate text-xs text-white/80 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]">
                            {card.subtitle}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={card.onPrimaryAction}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/22 px-3.5 py-2 text-xs font-semibold text-white ring-1 ring-white/28 backdrop-blur-xl transition-all duration-200 hover:scale-[1.03] hover:bg-white hover:text-[#111113] active:scale-95"
                        >
                          {card.loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <PlayTriangleIcon className="h-3.5 w-3.5" />
                          )}
                          {card.ctaLabel}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Borderless Apple Music Track List on Pure Canvas (iOS 0.5px text-inset hairlines + trailing ··· menu) */}
          <div className="space-y-1.5">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => allTracksSectionRef.current?.scrollIntoView({ behavior: "smooth" })}
                className="group inline-flex items-center gap-0.5 text-[18px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[17px]"
              >
                <span>{section === "daily" ? "今日主打" : "最新单曲"}</span>
                <ChevronRight className="h-4.5 w-4.5 text-[var(--tv-text-subtle)] transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-[var(--tv-text)]" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 sm:gap-x-6">
              {quickPicks.map((song, idx) => {
                const rowKey = `${getSongKey(song)}-${idx}`;
                const menuOpen = quickPickMenu.openRowKey === rowKey;
                const isBottomRowInTwoCol = idx >= quickPicks.length - 2;
                const isLastOverall = idx === quickPicks.length - 1;
                return (
                  <div
                    key={rowKey}
                    className="group relative flex items-center gap-3 rounded-xl px-1 py-2 text-left transition-colors sm:px-2 hover:bg-[var(--tv-surface-hover)]"
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

                    <div className="relative flex min-h-[52px] min-w-0 flex-1 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                          className="block w-full truncate text-left text-[14px] leading-snug font-medium text-[var(--tv-text)] sm:text-[13.5px]"
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
                      </div>

                      <div className="shrink-0" onPointerDown={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => quickPickMenu.openMenu(song, idx, e.currentTarget)}
                          title="更多操作"
                          aria-label={`更多操作 ${song.title}`}
                          aria-expanded={menuOpen}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--tv-text-subtle)]/75 transition-all hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] active:scale-95 ${
                            menuOpen
                              ? "bg-[var(--tv-surface-active)] text-[var(--tv-text)] opacity-100"
                              : "opacity-80 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                          }`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </div>

                      {/* iOS 0.5px text-aligned inset hairline divider (starts at text left edge, never under cover) */}
                      <span
                        aria-hidden="true"
                        style={{ borderBottom: "0.5px solid var(--tv-ios-hairline)" }}
                        className={`pointer-events-none absolute right-0 -bottom-2 left-0 transition-opacity group-hover:opacity-0 ${
                          isLastOverall ? "hidden" : isBottomRowInTwoCol ? "sm:hidden" : ""
                        }`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {quickPickMenu.menuPortal}
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
        <section ref={allTracksSectionRef} className="scroll-mt-14 space-y-3.5">
          <h2 className="text-[19px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[20px]">
            全部曲目
          </h2>
          <SongTable songs={songs} showHeaderMeta={false} showPlatformBadge={section !== "discover"} />
        </section>
      )}
    </div>
  );
}
