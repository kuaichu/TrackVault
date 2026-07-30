export type PublicProvider = "netease" | "qq";

export type AppRoute =
  | { kind: "root" }
  | { kind: "top"; page: "discover" | "search" | "playlists" | "cloud" | "transfer" | "downloads" | "history" | "settings" | "account"; query?: string }
  | { kind: "playlist"; provider: PublicProvider; id: string }
  | { kind: "artist"; provider: "netease"; id: string }
  | { kind: "album"; provider: "netease"; id: string }
  | { kind: "unknown" };

const topPages = new Set(["discover", "search", "playlists", "cloud", "transfer", "downloads", "history", "settings", "account"]);

function decodeSegment(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export function parseAppRoute(pathname: string, search = ""): AppRoute {
  if (pathname === "/" || pathname === "") return { kind: "root" };
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 1 && topPages.has(parts[0])) {
    const page = parts[0] as Extract<AppRoute, { kind: "top" }>['page'];
    const query = page === "search" ? new URLSearchParams(search).get("q")?.trim() || undefined : undefined;
    return { kind: "top", page, query };
  }

  const id = decodeSegment(parts[2]);
  if (parts.length === 3 && parts[0] === "playlists" && (parts[1] === "netease" || parts[1] === "qq") && id) {
    return { kind: "playlist", provider: parts[1], id };
  }
  if (parts.length === 3 && parts[0] === "artists" && parts[1] === "netease" && id) {
    return { kind: "artist", provider: "netease", id };
  }
  if (parts.length === 3 && parts[0] === "albums" && parts[1] === "netease" && id) {
    return { kind: "album", provider: "netease", id };
  }
  return { kind: "unknown" };
}

export function topRoute(page: Extract<AppRoute, { kind: "top" }>['page']) {
  return `/${page}`;
}

export function searchRoute(query: string) {
  const trimmed = query.trim();
  return trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search";
}

export function detailRoute(kind: "playlists", provider: PublicProvider, id: string): string;
export function detailRoute(kind: "artists" | "albums", provider: "netease", id: string): string;
export function detailRoute(kind: "playlists" | "artists" | "albums", provider: PublicProvider, id: string) {
  return `/${kind}/${provider}/${encodeURIComponent(id.trim())}`;
}
