import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  Cloud,
  Compass,
  Disc3,
  Download,
  History,
  ListMusic,
  LogOut,
  Search,
  Settings,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import type { UserSummary } from "#shared";
import { FullscreenPlayer } from "../features/player/components/FullscreenPlayer.js";
import { PlayerBar } from "../features/player/components/PlayerBar.js";
import { RightDrawer } from "../features/player/components/RightDrawer.js";
import { audioEngine } from "../features/player/engine/audio-engine.js";
import { usePlayerStore } from "../features/player/store/player-store.js";
import { api } from "../shared/api/endpoints.js";
import { useJobEvents } from "../shared/hooks/use-job-events.js";
import { toast } from "../shared/store/toast-store.js";

const NAV_ITEMS = [
  { to: "/discover", label: "发现音乐", icon: Compass },
  { to: "/search", label: "搜索曲库", icon: Search },
  { to: "/playlists", label: "我的歌单", icon: ListMusic },
  { to: "/cloud", label: "网易云盘", icon: Cloud },
  { to: "/history", label: "播放历史", icon: History },
  { to: "/downloads", label: "下载中心", icon: Download },
  { to: "/transfer", label: "歌单互转", icon: ArrowLeftRight },
  { to: "/settings", label: "设置与绑定", icon: Settings },
] as const;

export function AppShell({ user, children }: { user: UserSummary; children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [quickQuery, setQuickQuery] = useState("");
  const setPlayerPatch = usePlayerStore((s) => s.setStatePatch);

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

  // Stable global playback shortcuts (registered once, never torn down on timeupdate)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
      toast.info("已安全登出");
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
  });

  const handleQuickSearch = (e: FormEvent) => {
    e.preventDefault();
    const clean = quickQuery.trim();
    if (!clean) return;
    navigate(`/search?q=${encodeURIComponent(clean)}&mode=aggregate`);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--tv-bg)] text-[var(--tv-text)]">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--tv-border)] bg-[var(--tv-surface)]">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-400/15 text-amber-400">
              <Disc3 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white">TrackVault</div>
              <div className="text-[10px] text-[var(--tv-text-subtle)]">v2.0 Private Studio</div>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2.5 py-2 space-y-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-amber-400/15 text-amber-300"
                      : "text-[var(--tv-text-muted)] hover:bg-white/5 hover:text-white"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="border-t border-[var(--tv-border)] p-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-white">{user.username}</div>
              <div className="text-[10px] text-[var(--tv-text-subtle)]">
                {user.role === "admin" ? "管理员" : "成员"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => logoutMutation.mutate()}
              className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-rose-500/15 hover:text-rose-300"
              title="安全登出"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </aside>

        {/* Main Workspace */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex items-center justify-between gap-4 border-b border-[var(--tv-border)] bg-[var(--tv-bg)]/80 px-6 py-3 backdrop-blur-md">
            <form onSubmit={handleQuickSearch} className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--tv-text-subtle)]" />
              <input
                type="text"
                value={quickQuery}
                onChange={(e) => setQuickQuery(e.target.value)}
                placeholder="快速搜索网易云 / QQ 音乐..."
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] py-1.5 pl-9 pr-3 text-xs text-white focus:border-amber-400/60 focus:outline-none"
              />
            </form>
          </header>

          <main className="flex-1 overflow-y-auto px-6 py-6">
            <div className="mx-auto max-w-6xl">{children}</div>
          </main>
        </div>

        <RightDrawer />
      </div>

      <PlayerBar />
      <FullscreenPlayer />
    </div>
  );
}
