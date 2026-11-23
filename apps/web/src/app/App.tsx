import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import type { AuthStatus, StartupView, UserSummary } from "#shared";
import { AlbumDetailPage } from "../features/album/AlbumDetailPage.js";
import { ArtistDetailPage } from "../features/artist/ArtistDetailPage.js";
import { AuthGatePage } from "../features/auth/AuthGatePage.js";
import { ChartDetailPage, ChartsPage } from "../features/charts/ChartsPage.js";
import { DiscoverPage } from "../features/discover/DiscoverPage.js";
import { DownloadsPage } from "../features/downloads/DownloadsPage.js";
import { PersonalFmPage } from "../features/fm/PersonalFmPage.js";
import { CloudPage, HistoryPage } from "../features/library/CloudAndHistoryPage.js";
import { PlaylistDetailPage, PlaylistsPage } from "../features/library/PlaylistsPage.js";
import { audioEngine } from "../features/player/engine/audio-engine.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { TransferPage } from "../features/transfer/TransferPage.js";
import { api } from "../shared/api/endpoints.js";
import { ApiClientError, setUnauthorizedHandler } from "../shared/api/http-client.js";
import { clearPendingDirectLinkJobs } from "../shared/hooks/use-job-events.js";
import { useToastStore } from "../shared/store/toast-store.js";
import { EmptyState, ToastContainer } from "../shared/ui/primitives.js";
import { AppShell } from "./AppShell.js";

const STARTUP_VIEW_ROUTES: Record<StartupView, string> = {
  discover: "/discover",
  search: "/search",
  playlists: "/playlists",
  downloads: "/downloads",
};

function StartupRedirect() {
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

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

  useEffect(() => {
    return () => {
      void userQueryClient.cancelQueries();
      userQueryClient.clear();
    };
  }, [userQueryClient]);

  return (
    <QueryClientProvider client={userQueryClient}>
      <AppShell user={user} onSessionCleared={onSessionCleared}>
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
      </AppShell>
    </QueryClientProvider>
  );
}

function AuthenticatedApp() {
  const authQueryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null>(null);

  const clearAuthSession = useCallback(() => {
    audioEngine.stop();
    clearPendingDirectLinkJobs();
    // F02: Clear global toasts (such as 8s direct-link notifications) across session boundaries
    useToastStore.getState().clear();
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
      audioEngine.stop();
      clearPendingDirectLinkJobs();
      if (activeUserId !== null) {
        useToastStore.getState().clear();
      }
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
