import type { PublicProvider } from "./app-routes";

export function shouldWriteBrowserUrl(currentUrl: string, targetUrl: string) {
  return currentUrl !== targetUrl;
}

export function resultProvider(
  resultSource: string,
  activePlaylistProvider: PublicProvider,
  settingsProvider: "netease" | "qq" | "aggregate"
): PublicProvider | "aggregate" {
  return resultSource === "playlist" ? activePlaylistProvider : settingsProvider;
}

export function playlistTotal(responseTotal: number, playlistTrackCount: number) {
  return responseTotal > 0 ? responseTotal : playlistTrackCount;
}
