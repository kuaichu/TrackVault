import { useQuery } from "@tanstack/react-query";
import type { Song } from "#shared";
import { api } from "../../../shared/api/endpoints.js";

/**
 * Shared lyrics query keyed strictly by `(platform, id, mediaId)` so track switches
 * across platforms or cloud/QQ mediaId variants never collide in cache.
 */
export function useTrackLyricsQuery(track: Song | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["lyrics", track?.platform, track?.id, track?.mediaId ?? null] as const,
    queryFn: () => (track ? api.getLyrics(track.platform, track.id, track.mediaId) : null),
    enabled: Boolean(enabled && track),
  });
}
