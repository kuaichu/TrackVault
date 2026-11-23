import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Compass,
  Download,
  History,
  ListMusic,
  LogOut,
  Menu,
  Moon,
  Radio,
  Search,
  Settings,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { UserSummary } from "#shared";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { PlayerBar } from "../features/player/components/PlayerBar.js";
import { RightDrawer } from "../features/player/components/RightDrawer.js";
import { audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlayerStore } from "../features/player/store/player-store.js";
import { api } from "../shared/api/endpoints.js";
import { useJobEvents } from "../shared/hooks/use-job-events.js";
import { useThemeStore } from "../shared/store/theme-store.js";
import { toast } from "../shared/store/toast-store.js";

const NAV_GROUPS = [
  {
    title: "浏览",
    items: [
      { to: "/discover", label: "发现", icon: Compass },
      { to: "/charts", label: "排行榜", icon: TrendingUp },
      { to: "/fm", label: "私人漫游", icon: Radio },
      { to: "/search", label: "搜索", icon: Search },
    ],
  },
  {
    title: "资料库",
    items: [
      { to: "/playlists", label: "歌单", icon: ListMusic },
      { to: "/cloud", label: "云盘", icon: Cloud },
      { to: "/history", label: "最近播放", icon: History },
    ],
  },
  {
    title: "工具",
    items: [
      { to: "/downloads", label: "下载管理", icon: Download },
      { to: "/transfer", label: "歌单迁移", icon: ArrowLeftRight },
    ],
  },
] as const;

const MOBILE_TABS = [
  { to: "/discover", label: "发现", icon: Compass },
  { to: "/charts", label: "排行", icon: TrendingUp },
  { to: "/search", label: "搜索", icon: Search },
  { to: "/playlists", label: "歌单", icon: ListMusic },
] as const;

export function AppShell({ user, children }: { user: UserSummary; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const setPlayerPatch = usePlayerStore((s) => s.setStatePatch);
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const toggleLightDark = useThemeStore((s) => s.toggleLightDark);

  // Close mobile drawer automatically when route changes
  const pathname = location.pathname;
  useEffect(() => {
    if (pathname) {
      setMobileMenuOpen(false);
    }
  }, [pathname]);

  // Connect single SSE stream for real-time job progress updates
  useJobEvents(true);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const playerStateQuery = useQuery({
    queryKey: ["player-state"],
    queryFn: () => api.getPlayerState(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const activeDownloadsQuery = useQuery({
    queryKey: ["jobs", "download"],
    queryFn: () => api.listJobs("download"),
  });

  const runningDownloadCount =
    activeDownloadsQuery.data?.jobs.filter((j) => j.status === "running" || j.status === "queued").length ??
    0;

  useEffect(() => {
    if (settingsQuery.data?.settings.defaultPlaybackQuality) {
      setPlayerPatch({
        defaultPlaybackQuality: settingsQuery.data.settings.defaultPlaybackQuality,
      });
    }
  }, [settingsQuery.data?.settings.defaultPlaybackQuality, setPlayerPatch]);

  useEffect(() => {
    if (playerStateQuery.data?.state) {
      audioEngine.hydrate(playerStateQuery.data.state);
    }
  }, [playerStateQuery.data?.state]);

  // Global desktop player shortcuts (Space, Alt+Arrow, '/' to search, Escape closes mobile menu)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void audioEngine.togglePlay();
      } else if (event.code === "ArrowRight" && event.altKey) {
        void audioEngine.playNext();
      } else if (event.code === "ArrowLeft" && event.altKey) {
        void audioEngine.playPrevious();
      } else if (event.key === "/" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      audioEngine.stop();
      queryClient.clear();
      toast.info("已退出登录");
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });

  const handleQuickSearch = (e: FormEvent) => {
    e.preventDefault();
    const clean = quickQuery.trim();
    if (!clean) return;
    navigate(`/search?q=${encodeURIComponent(clean)}&mode=aggregate`);
  };

  const renderSidebarContent = (showCloseButton = false) => (
    <>
      <div className="flex h-14 items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--tv-accent)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--tv-sidebar)]" />
          </span>
          <span className="text-[15px] font-bold tracking-tight text-[var(--tv-text)]">TrackVault</span>
        </div>
        {showCloseButton && (
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-md p-1.5 text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            aria-label="关闭导航菜单"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-2 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="space-y-0.5">
            <div className="px-2.5 pb-1 text-[11px] font-medium text-[var(--tv-text-subtle)]">
              {group.title}
            </div>
            {group.items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-lg px-2.5 py-[8px] text-[13.5px] transition-colors ${
                    isActive
                      ? "bg-[var(--tv-accent-soft)] font-semibold text-[var(--tv-accent)]"
                      : "font-medium text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                  }`
                }
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-[16px] w-[16px] shrink-0 stroke-[1.9]" />
                  {label}
                </span>
                {to === "/downloads" && runningDownloadCount > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--tv-accent)] px-1 text-[10px] font-semibold text-[var(--tv-accent-fg)] tabular-nums">
                    {runningDownloadCount}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Pinned bottom settings + user bar */}
      <div className="tv-pb-safe border-t border-[var(--tv-border)] px-3 py-2.5 space-y-1">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-2.5 py-[8px] text-[13.5px] transition-colors ${
              isActive
                ? "bg-[var(--tv-accent-soft)] font-semibold text-[var(--tv-accent)]"
                : "font-medium text-[var(--tv-text-muted)] hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            }`
          }
        >
          <Settings className="h-[16px] w-[16px] shrink-0 stroke-[1.9]" />
          设置与绑定
        </NavLink>

        <div className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--tv-surface-active)] text-[11px] font-semibold uppercase text-[var(--tv-text)]">
              {user.username.slice(0, 1)}
            </span>
            <span className="truncate text-xs font-medium text-[var(--tv-text)]">{user.username}</span>
          </div>
          <button
            type="button"
            onClick={() => logoutMutation.mutate()}
            className="rounded-md p-1 text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-danger)]"
            title="退出登录"
            aria-label="退出登录"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--tv-bg)] text-[var(--tv-text)]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop Left Navigation Rail */}
        <aside className="hidden w-[220px] shrink-0 flex-col border-r border-[var(--tv-border)] bg-[var(--tv-sidebar)] select-none md:flex">
          {renderSidebarContent(false)}
        </aside>

        {/* Mobile Slide-Over Navigation Drawer */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 flex md:hidden" style={{ zIndex: "var(--tv-z-modal)" }}>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="fixed inset-0 bg-black/55 backdrop-blur-xs"
              aria-label="关闭菜单遮罩"
            />
            <aside className="relative flex h-full w-[264px] max-w-[82vw] flex-col border-r border-[var(--tv-border)] bg-[var(--tv-sidebar)] shadow-2xl select-none">
              {renderSidebarContent(true)}
            </aside>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Sticky Top Bar (compact on mobile, YesPlayMusic/Feishin style on desktop) */}
          <header
            className="tv-pt-safe flex h-13 shrink-0 items-center justify-between gap-2.5 border-b border-[var(--tv-border)] bg-[var(--tv-header-bg)] px-3.5 backdrop-blur-xl md:h-14 md:gap-4 md:px-6"
            style={{ zIndex: "var(--tv-z-sticky)" }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 md:max-w-lg md:gap-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] md:hidden"
                aria-label="打开导航菜单"
              >
                <Menu className="h-5 w-5" />
              </button>

              <div className="hidden items-center gap-0.5 sm:flex">
                <button
                  type="button"
                  onClick={() => navigate(-1)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                  title="后退"
                  aria-label="后退"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => navigate(1)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                  title="前进"
                  aria-label="前进"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleQuickSearch} className="relative min-w-0 flex-1 md:max-w-sm">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--tv-text-subtle)]" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={quickQuery}
                  onChange={(e) => setQuickQuery(e.target.value)}
                  placeholder="搜索歌曲、歌手或专辑"
                  className="h-8 w-full rounded-lg bg-[var(--tv-surface)] pl-8 pr-3 text-[13px] text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] transition-colors focus:bg-[var(--tv-surface-elevated)] focus:ring-1 focus:ring-[var(--tv-border-strong)] focus:outline-none sm:pr-8"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-[var(--tv-border)] px-1 text-[10px] font-mono text-[var(--tv-text-subtle)] sm:inline">
                  /
                </kbd>
              </form>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={toggleLightDark}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                title={resolvedTheme === "dark" ? "切换浅色模式" : "切换深色模式"}
                aria-label="切换明暗主题"
              >
                {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 md:px-7 md:py-6">
            <div className="mx-auto max-w-[1280px]">{children}</div>
          </main>
        </div>

        <RightDrawer />
      </div>

      {/* Persistent Player Bar (Desktop full bar / Mobile mini bar) */}
      <PlayerBar />

      {/* Mobile Bottom Tab Bar (Apple Music / Spotify style) */}
      <nav
        className="tv-pb-safe grid shrink-0 grid-cols-5 border-t border-[var(--tv-border)] bg-[var(--tv-player-bg)] backdrop-blur-2xl select-none md:hidden"
        style={{ zIndex: "var(--tv-z-sticky)" }}
        aria-label="移动端主导航"
      >
        {MOBILE_TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors ${
                isActive ? "text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)]"
              }`
            }
          >
            <Icon className="h-[18px] w-[18px] stroke-[1.9]" />
            <span>{label}</span>
          </NavLink>
        ))}

        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className={`relative flex flex-col items-center justify-center gap-0.5 py-2 text-[10.5px] font-medium transition-colors ${
            mobileMenuOpen ? "text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)]"
          }`}
        >
          <span className="relative">
            <Menu className="h-[18px] w-[18px] stroke-[1.9]" />
            {runningDownloadCount > 0 && (
              <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-[var(--tv-accent)]" />
            )}
          </span>
          <span>更多</span>
        </button>
      </nav>

      <FullscreenPlayer />
    </div>
  );
}
