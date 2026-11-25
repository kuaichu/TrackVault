import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import type { AuthStatus, StartupView, UserSummary } from "#shared";
import { AuthGatePage } from "../pages/auth/index.js";
import { DiscoverPage } from "../pages/discover/index.js";
import { SearchPage } from "../pages/search/index.js";
import { api } from "../shared/api/endpoints.js";
import { ApiClientError, setUnauthorizedHandler } from "../shared/api/http-client.js";
import { useSettingsQuery } from "../shared/hooks/use-settings-query.js";
import { EmptyState, ToastContainer } from "../shared/ui/primitives.js";
import { AppShell } from "./AppShell.js";
import { SessionServicesProvider, resetSessionServices } from "./SessionServicesProvider.js";

const AlbumDetailPage = lazy(() =>
  import("../pages/album/index.js").then((m) => ({ default: m.AlbumDetailPage })),
);
const ArtistDetailPage = lazy(() =>
  import("../pages/artist/index.js").then((m) => ({ default: m.ArtistDetailPage })),
);
const ChartsPage = lazy(() => import("../pages/charts/index.js").then((m) => ({ default: m.ChartsPage })));
const ChartDetailPage = lazy(() =>
  import("../pages/charts/index.js").then((m) => ({ default: m.ChartDetailPage })),
);
const DownloadsPage = lazy(() =>
  import("../pages/downloads/index.js").then((m) => ({ default: m.DownloadsPage })),
);
const PersonalFmPage = lazy(() =>
  import("../pages/fm/index.js").then((m) => ({ default: m.PersonalFmPage })),
);
const CloudPage = lazy(() =>
  import("../pages/library/CloudAndHistoryPage.js").then((m) => ({ default: m.CloudPage })),
);
const HistoryPage = lazy(() =>
  import("../pages/library/CloudAndHistoryPage.js").then((m) => ({ default: m.HistoryPage })),
);
const PlaylistsPage = lazy(() =>
  import("../pages/library/PlaylistsPage.js").then((m) => ({ default: m.PlaylistsPage })),
);
const PlaylistDetailPage = lazy(() =>
  import("../pages/library/PlaylistsPage.js").then((m) => ({ default: m.PlaylistDetailPage })),
);
const SettingsPage = lazy(() =>
  import("../pages/settings/index.js").then((m) => ({ default: m.SettingsPage })),
);
const TransferPage = lazy(() =>
  import("../pages/transfer/index.js").then((m) => ({ default: m.TransferPage })),
);

const STARTUP_VIEW_ROUTES: Record<StartupView, string> = {
  discover: "/discover",
  search: "/search",
  playlists: "/playlists",
  downloads: "/downloads",
};

function StartupRedirect() {
  const settingsQuery = useSettingsQuery();

  if (settingsQuery.isLoading && !settingsQuery.data) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-xs text-[var(--tv-text-muted)]">
        正在载入启动页...
      </div>
    );
  }

  const startupView = settingsQuery.data?.settings.startupView ?? "discover";
  const target = STARTUP_VIEW_ROUTES[startupView] ?? "/discover";
  return <Navigate to={target} replace />;
}

function NotFoundPage() {
  return (
    <EmptyState
      title="404 · 页面未找到"
      description="你访问的地址不存在或已被移除，请返回首页继续浏览。"
      action={
        <Link
          to="/"
          className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)]"
        >
          返回首页
        </Link>
      }
    />
  );
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}

function UserSessionBoundary({
  user,
  onSessionCleared,
}: {
  user: UserSummary;
  onSessionCleared: () => void;
}) {
  const [userQueryClient] = useState(() => createAppQueryClient());
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (!mountedRef.current) {
          resetSessionServices(userQueryClient);
          void userQueryClient.cancelQueries();
          userQueryClient.clear();
        }
      });
    };
  }, [userQueryClient]);

  return (
    <QueryClientProvider client={userQueryClient}>
      <SessionServicesProvider>
        <AppShell user={user} onSessionCleared={onSessionCleared}>
          <Suspense
            fallback={
              <div className="flex min-h-[240px] items-center justify-center text-xs text-[var(--tv-text-muted)]">
                正在载入页面...
              </div>
            }
          >
            <Routes>
              <Route path="/" element={<StartupRedirect />} />
              <Route path="/discover" element={<DiscoverPage />} />
              <Route path="/charts" element={<ChartsPage />} />
              <Route path="/charts/:platform/:id" element={<ChartDetailPage />} />
              <Route path="/fm" element={<PersonalFmPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/artist/:platform/:id" element={<ArtistDetailPage />} />
              <Route path="/album/:platform/:id" element={<AlbumDetailPage />} />
              <Route path="/playlists" element={<PlaylistsPage />} />
              <Route path="/playlists/:platform/:id" element={<PlaylistDetailPage />} />
              <Route path="/cloud" element={<CloudPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/downloads" element={<DownloadsPage />} />
              <Route path="/transfer" element={<TransferPage />} />
              <Route path="/settings" element={<SettingsPage user={user} />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </AppShell>
      </SessionServicesProvider>
    </QueryClientProvider>
  );
}

function AuthenticatedApp() {
  const authQueryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null>(null);

  const clearAuthSession = useCallback(() => {
    prevUserIdRef.current = null;
    resetSessionServices();
    authQueryClient.setQueryData<AuthStatus>(["auth-status"], (prev) => ({
      initialized: prev?.initialized ?? true,
      authenticated: false,
      user: null,
    }));
    void authQueryClient.invalidateQueries({ queryKey: ["auth-status"] });
  }, [authQueryClient]);

  useEffect(() => {
    setUnauthorizedHandler(clearAuthSession);
    return () => setUnauthorizedHandler(null);
  }, [clearAuthSession]);

  const authQuery = useQuery({
    queryKey: ["auth-status"],
    queryFn: ({ signal }) => api.getAuthStatus(signal),
    staleTime: 60_000,
    retry: false,
  });

  const activeUserId = authQuery.data?.authenticated ? (authQuery.data.user?.id ?? null) : null;
  useEffect(() => {
    const prev = prevUserIdRef.current;
    if (prev !== null && prev !== activeUserId) {
      resetSessionServices();
    }
    prevUserIdRef.current = activeUserId;
  }, [activeUserId]);

  if (authQuery.isLoading) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-[var(--tv-bg)] text-sm text-[var(--tv-text-muted)]">
        正在载入曲库...
      </div>
    );
  }

  if (authQuery.isError || !authQuery.data) {
    const message = authQuery.error instanceof Error ? authQuery.error.message : "无法获取服务认证状态。";
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-4 bg-[var(--tv-bg)] px-6 text-center">
        <div className="space-y-1.5">
          <h1 className="text-base font-semibold text-[var(--tv-text)]">无法连接 TrackVault 服务</h1>
          <p className="max-w-sm text-xs text-[var(--tv-text-muted)]">{message}</p>
        </div>
        <button
          type="button"
          onClick={() => void authQuery.refetch()}
          className="rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)]"
        >
          重试连接
        </button>
      </div>
    );
  }

  const status = authQuery.data;
  if (!status.authenticated || !status.user) {
    return <AuthGatePage initialized={status.initialized} />;
  }

  return <UserSessionBoundary key={status.user.id} user={status.user} onSessionCleared={clearAuthSession} />;
}

export function AppContent() {
  const [authQueryClient] = useState(() => createAppQueryClient());

  useEffect(() => {
    return () => {
      void authQueryClient.cancelQueries();
      authQueryClient.clear();
    };
  }, [authQueryClient]);

  return (
    <QueryClientProvider client={authQueryClient}>
      <AuthenticatedApp />
      <ToastContainer />
    </QueryClientProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
