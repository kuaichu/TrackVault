import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useContext, useEffect, useLayoutEffect, useRef } from "react";
import { clearPendingDirectLinkJobs, useJobEvents } from "../features/downloads/index.js";
import { applyRecordedPlayHistory, audioEngine, beginPlayHistoryRecord } from "../features/player/index.js";
import { api } from "../shared/api/endpoints.js";
import { useSettingsQuery } from "../shared/hooks/use-settings-query.js";
import { useToastStore } from "../shared/store/toast-store.js";

const SessionServicesContext = createContext(false);

export function useHasSessionServices(): boolean {
  return useContext(SessionServicesContext);
}

/**
 * Single authoritative teardown for session-scoped singletons (audio, direct-link probes, toasts).
 */
export function resetSessionServices(queryClient?: QueryClient): void {
  audioEngine.stop();
  clearPendingDirectLinkJobs(queryClient);
  useToastStore.getState().clear();
}

/**
 * Session-scoped service coordinator mounted under `<UserSessionBoundary>`.
 * Unifies SSE job events, play-history query binding, and deterministic settings -> player-state hydration.
 */
export function SessionServicesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const hydratedRef = useRef(false);

  useJobEvents(true);

  useLayoutEffect(() => {
    audioEngine.setPlayHistoryListener(
      (res, meta) => {
        applyRecordedPlayHistory(queryClient, res, meta?.startSeq, meta?.song);
      },
      () => beginPlayHistoryRecord(queryClient),
    );
    return () => {
      audioEngine.setPlayHistoryListener(null);
    };
  }, [queryClient]);

  const settingsQuery = useSettingsQuery();
  const playerStateQuery = useQuery({
    queryKey: ["player-state"],
    queryFn: () => api.getPlayerState(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const defaultPlaybackQuality = settingsQuery.data?.settings.defaultPlaybackQuality;
  const remotePlayerState = playerStateQuery.data?.state;

  useEffect(() => {
    if (defaultPlaybackQuality) {
      audioEngine.syncDefaultPlaybackQuality(defaultPlaybackQuality);
    }
    if (remotePlayerState && !hydratedRef.current) {
      hydratedRef.current = true;
      audioEngine.hydrate(remotePlayerState);
    }
  }, [defaultPlaybackQuality, remotePlayerState]);

  return <SessionServicesContext.Provider value={true}>{children}</SessionServicesContext.Provider>;
}
