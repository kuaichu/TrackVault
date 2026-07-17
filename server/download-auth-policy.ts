export type DownloadAuthProvider = "netease" | "qqmusic";
export type DownloadAuthRequirement = DownloadAuthProvider | "unsupported";

export type DownloadAuthState = {
  hasNeteaseDownloadCredential: boolean;
  hasQqMusicDownloadCredential: boolean;
};

export type DownloadSongLike = {
  source: string;
};

export function getDownloadAuthRequirement(song: DownloadSongLike): DownloadAuthRequirement {
  if (song.source === "qqmusic") {
    return "qqmusic";
  }

  if (song.source === "netease" || song.source.startsWith("netease-")) {
    return "netease";
  }

  return "unsupported";
}

export function canDownloadSong(song: DownloadSongLike, authState: DownloadAuthState) {
  const requirement = getDownloadAuthRequirement(song);
  if (requirement === "unsupported") {
    return {
      allowed: false as const,
      requirement,
      unsupportedSource: song.source || "(empty)"
    };
  }

  const allowed = requirement === "netease"
    ? authState.hasNeteaseDownloadCredential
    : authState.hasQqMusicDownloadCredential;

  return allowed
    ? { allowed: true as const, requirement }
    : { allowed: false as const, requirement, missingProvider: requirement };
}

export function getMissingDownloadProviders(songs: DownloadSongLike[], authState: DownloadAuthState): {
  missingProviders: DownloadAuthProvider[];
  unsupportedSources: string[];
} {
  const missingProviders = new Set<DownloadAuthProvider>();
  const unsupportedSources = new Set<string>();

  for (const song of songs) {
    const result = canDownloadSong(song, authState);
    if (result.allowed) {
      continue;
    }

    if (result.requirement === "unsupported") {
      unsupportedSources.add(result.unsupportedSource);
    } else {
      missingProviders.add(result.missingProvider);
    }
  }

  return {
    missingProviders: (["netease", "qqmusic"] as const).filter((provider) => missingProviders.has(provider)),
    unsupportedSources: [...unsupportedSources]
  };
}
