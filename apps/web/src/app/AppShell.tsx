import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import {
  type FormEvent,
  type ReactNode,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import type { AuthStatus, UserSummary } from "#shared";
import { useJobsQuery } from "../entities/job/index.js";
import {
  PlayerBar,
  RightDrawer,
  audioEngine,
  loadFullscreenPlayer,
  usePlayerStore,
} from "../features/player/index.js";
import { api } from "../shared/api/endpoints.js";
import {
  registerInertSynchronizer,
  setElementInert,
  useIsOverlayViewport,
  useModalFocusTrap,
} from "../shared/hooks/use-modal-focus-trap.js";
import { useSettingsQuery } from "../shared/hooks/use-settings-query.js";
import { useThemeStore } from "../shared/store/theme-store.js";
import { toast } from "../shared/store/toast-store.js";
import {
  SessionServicesProvider,
  resetSessionServices,
  useHasSessionServices,
} from "./SessionServicesProvider.js";

const LazyFullscreenPlayer = lazy(loadFullscreenPlayer);

const EDITABLE_TARGET_SELECTOR = "input, textarea, select, [contenteditable='true']";
const INTERACTIVE_SHORTCUT_SELECTOR =
  "button, a, input, textarea, select, summary, [contenteditable='true'], [role='button'], [role='link'], [role='slider'], [role='switch'], [role='checkbox'], [role='tab'], [role='menuitem'], [role='combobox']";

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

function AppShellInner({
  user,
  children,
  onSessionCleared,
}: {
  user: UserSummary;
  children: ReactNode;
  onSessionCleared?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const bottomBarsRef = useRef<HTMLDivElement | null>(null);
  const mobileDrawerRef = useRef<HTMLDialogElement | null>(null);
  const [quickQuery, setQuickQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const resolvedTheme = useThemeStore((s) => s.resolved);
  const toggleLightDark = useThemeStore((s) => s.toggleLightDark);
  const fullscreenOpen = usePlayerStore((s) => s.fullscreenOpen);
  const drawerOpen = usePlayerStore((s) => s.drawerOpen);
  const isMobileViewport = useIsOverlayViewport(768);
  const isDrawerOverlay = useIsOverlayViewport(1280);
  const prevMobileViewportRef = useRef(isMobileViewport);

  // U04: Auto-close mobile navigation drawer when viewport widens across the 768px (md:) breakpoint
  useEffect(() => {
    const wasMobile = prevMobileViewportRef.current;
    prevMobileViewportRef.current = isMobileViewport;
    if (
      mobileMenuOpen &&
      !isMobileViewport &&
      (wasMobile || (typeof window !== "undefined" && typeof window.matchMedia === "function"))
    ) {
      setMobileMenuOpen(false);
    }
  }, [isMobileViewport, mobileMenuOpen]);

  const effectiveMobileMenuOpen =
    mobileMenuOpen &&
    (isMobileViewport || (typeof window !== "undefined" && typeof window.matchMedia !== "function"));
  const hasModalOverlay = fullscreenOpen || effectiveMobileMenuOpen || (drawerOpen && isDrawerOverlay);
  const hasModalOverlayRef = useRef(hasModalOverlay);
  hasModalOverlayRef.current = hasModalOverlay;

  useLayoutEffect(() => {
    setElementInert(workspaceShellRef.current, hasModalOverlay);
    setElementInert(bottomBarsRef.current, hasModalOverlay);
  }, [hasModalOverlay]);

  useLayoutEffect(() => {
    return registerInertSynchronizer(() => {
      const inert = hasModalOverlayRef.current;
      setElementInert(workspaceShellRef.current, inert);
      setElementInert(bottomBarsRef.current, inert);
    });
  }, []);

  useModalFocusTrap(mobileDrawerRef, effectiveMobileMenuOpen && !fullscreenOpen, {
    onClose: () => setMobileMenuOpen(false),
  });

  const pathname = location.pathname;
  useEffect(() => {
    if (pathname) {
      setMobileMenuOpen(false);
    }
  }, [pathname]);

  const settingsQuery = useSettingsQuery();
  const activeDownloadsQuery = useJobsQuery("download");

  const runningDownloadCount =
    activeDownloadsQuery.data?.jobs.filter((j) => j.status === "running" || j.status === "queued").length ??
    0;

  // Global desktop player shortcuts (Space, Alt+Arrow, '/' to search)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const isEditable =
        (target instanceof HTMLElement && target.isContentEditable) ||
        Boolean(target?.closest(EDITABLE_TARGET_SELECTOR));

      if (event.code === "Space") {
        if (isEditable || Boolean(target?.closest(INTERACTIVE_SHORTCUT_SELECTOR))) {
          return;
        }
        event.preventDefault();
        void audioEngine.togglePlay();
        return;
      }

      if (isEditable) return;

      if (event.code === "ArrowRight" && event.altKey) {
        void audioEngine.playNext();
      } else if (event.code === "ArrowLeft" && event.altKey) {
        void audioEngine.playPrevious();
      } else if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const playerState = usePlayerStore.getState();
        if (playerState.fullscreenOpen || mobileMenuOpen || (playerState.drawerOpen && isDrawerOverlay)) {
          return;
        }
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen, isDrawerOverlay]);

  const logoutMutation = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      if (onSessionCleared) {
        onSessionCleared();
        toast.info("已退出登录");
        return;
      }
      resetSessionServices(queryClient);
      toast.info("已退出登录");
      queryClient.setQueryData<AuthStatus>(["auth-status"], (prev) => ({
        initialized: prev?.initialized ?? true,
        authenticated: false,
        user: null,
      }));
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth-status" });
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "退出登录失败，请重试");
    },
  });

  const addSearchHistoryMutation = useMutation({
    mutationFn: (keyword: string) => api.addSearchHistory(keyword),
    onSuccess: (res) => {
      queryClient.setQueryData(["search-history"], res);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "保存搜索历史失败");
    },
  });

  const handleQuickSearch = (e: FormEvent) => {
    e.preventDefault();
    const clean = quickQuery.trim();
    if (!clean) return;
    const loadedMode = settingsQuery.data?.settings.providerMode;
    addSearchHistoryMutation.mutate(clean);
    const modeSuffix = loadedMode ? `&mode=${encodeURIComponent(loadedMode)}` : "";
    navigate(`/search?q=${encodeURIComponent(clean)}${modeSuffix}`);
  };

  const renderSidebarContent = (showCloseButton = false) => {
    const closeDrawerOnClick = showCloseButton ? () => setMobileMenuOpen(false) : undefined;
    return (
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
                  onClick={closeDrawerOnClick}
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

        <div className="tv-pb-safe border-t border-[var(--tv-border)] px-3 pt-2.5 [--tv-safe-pb-base:0.625rem] space-y-1">
          <NavLink
            to="/settings"
            onClick={closeDrawerOnClick}
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
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-[var(--tv-bg)] text-[var(--tv-text)]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div ref={workspaceShellRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <aside className="hidden w-[220px] shrink-0 flex-col border-r border-[var(--tv-border)] bg-[var(--tv-sidebar)] select-none md:flex">
            {renderSidebarContent(false)}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <header
              className="tv-pt-safe flex min-h-13 shrink-0 items-center justify-between gap-2.5 border-b border-[var(--tv-border)] bg-[var(--tv-header-bg)] px-3.5 pb-2 [--tv-safe-pt-base:0.5rem] backdrop-blur-xl md:min-h-14 md:gap-4 md:px-6"
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
                    aria-label="搜索歌曲、歌手或专辑"
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
        </div>

        <RightDrawer backgroundInert={fullscreenOpen || effectiveMobileMenuOpen} />
      </div>

      <div ref={bottomBarsRef} className="shrink-0">
        <PlayerBar />

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
      </div>

      {effectiveMobileMenuOpen && (
        <div className="fixed inset-0 flex md:hidden" style={{ zIndex: "var(--tv-z-modal)" }}>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="fixed inset-0 bg-black/55 backdrop-blur-xs"
            aria-label="关闭菜单遮罩"
          />
          <dialog
            ref={mobileDrawerRef}
            open
            aria-modal="true"
            aria-label="导航菜单"
            className="relative m-0 flex h-full max-h-none w-[264px] max-w-[82vw] flex-col border-0 border-r border-[var(--tv-border)] bg-[var(--tv-sidebar)] p-0 text-[var(--tv-text)] shadow-2xl select-none"
          >
            {renderSidebarContent(true)}
          </dialog>
        </div>
      )}

      {fullscreenOpen && (
        <Suspense fallback={null}>
          <LazyFullscreenPlayer />
        </Suspense>
      )}
    </div>
  );
}

export function AppShell(props: {
  user: UserSummary;
  children: ReactNode;
  onSessionCleared?: () => void;
}) {
  const hasSessionServices = useHasSessionServices();
  if (hasSessionServices) {
    return <AppShellInner {...props} />;
  }
  return (
    <SessionServicesProvider>
      <AppShellInner {...props} />
    </SessionServicesProvider>
  );
}
