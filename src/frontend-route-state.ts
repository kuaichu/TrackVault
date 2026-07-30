import type { PublicProvider } from "./app-routes";

export function shouldWriteBrowserUrl(currentUrl: string, pendingUrl: string | null, targetUrl: string) {
  return currentUrl !== targetUrl && pendingUrl !== targetUrl;
}

export function resultProvider(
  resultSource: string,
  activePlaylistProvider: PublicProvider,
  settingsProvider: "netease" | "qq" | "aggregate"
): PublicProvider | "aggregate" {
  return resultSource === "playlist" ? activePlaylistProvider : settingsProvider;
}

export function playlistTotals(responseTotal: number, sourceTotal: number | undefined, playlistTrackCount: number) {
  return { matchTotal: responseTotal, sourceTotal: sourceTotal ?? playlistTrackCount };
}

export function requiresNeteasePlaybackAuth(neteaseLoggedIn: boolean, songSource: string | null | undefined) {
  return !neteaseLoggedIn && songSource !== "qqmusic";
}

export function detailBackFallback(historyIndex: number) {
  return historyIndex > 0 ? null : "/discover";
}
