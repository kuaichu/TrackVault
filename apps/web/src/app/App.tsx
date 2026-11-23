import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGatePage } from "../features/auth/AuthGatePage.js";
import { DiscoverPage } from "../features/discover/DiscoverPage.js";
import { DownloadsPage } from "../features/downloads/DownloadsPage.js";
import { CloudPage, HistoryPage } from "../features/library/CloudAndHistoryPage.js";
import { PlaylistDetailPage, PlaylistsPage } from "../features/library/PlaylistsPage.js";
import { SearchPage } from "../features/search/SearchPage.js";
import { SettingsPage } from "../features/settings/SettingsPage.js";
import { TransferPage } from "../features/transfer/TransferPage.js";
import { api } from "../shared/api/endpoints.js";
import { setUnauthorizedHandler } from "../shared/api/http-client.js";
import { ToastContainer } from "../shared/ui/primitives.js";
import { AppShell } from "./AppShell.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function AuthenticatedApp() {
  const qc = useQueryClient();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void qc.invalidateQueries({ queryKey: ["auth-status"] });
    });
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  const authQuery = useQuery({
    queryKey: ["auth-status"],
    queryFn: () => api.getAuthStatus(),
    staleTime: 60_000,
    retry: false,
  });

  if (authQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--tv-bg)] text-sm text-[var(--tv-text-muted)]">
        正在连接 TrackVault v2...
      </div>
    );
  }

  const status = authQuery.data;
  if (!status || !status.authenticated || !status.user) {
    return <AuthGatePage initialized={Boolean(status?.initialized)} />;
  }

  return (
    <AppShell user={status.user}>
      <Routes>
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/playlists" element={<PlaylistsPage />} />
        <Route path="/playlists/:platform/:id" element={<PlaylistDetailPage />} />
        <Route path="/cloud" element={<CloudPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/downloads" element={<DownloadsPage />} />
        <Route path="/transfer" element={<TransferPage />} />
        <Route path="/settings" element={<SettingsPage user={status.user} />} />
        <Route path="*" element={<Navigate to="/discover" replace />} />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthenticatedApp />
        <ToastContainer />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
