import type { CreatePlaylistTransferDeps } from "./service.js";
import type { ProviderTrack, TransferImportRequest, TransferTrack } from "./types.js";

export type PlaylistTransferRuntimeDependencies = {
  searchNeteaseProviderTracks: (track: TransferTrack) => Promise<ProviderTrack[]>;
  searchQqProviderTracks: (track: TransferTrack) => Promise<ProviderTrack[]>;
  loadNeteasePlaylistTransferTracks: (playlistId: string) => Promise<TransferTrack[]>;
  loadQqPlaylistTransferTracks: (playlistId: string) => Promise<TransferTrack[]>;
  checkNeteaseProviderTrackAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]>;
};

export type PlaylistTransferRuntime = {
  searchTargetTracks: CreatePlaylistTransferDeps["searchTargetTracks"];
  loadSourceTracks: (input: TransferImportRequest) => Promise<TransferTrack[]>;
  checkAvailability: NonNullable<CreatePlaylistTransferDeps["checkAvailability"]>;
};

export function createPlaylistTransferRuntime(
  dependencies: PlaylistTransferRuntimeDependencies
): PlaylistTransferRuntime {
  const searchTargetTracks: PlaylistTransferRuntime["searchTargetTracks"] = async (track, targetProvider) => {
    if ((targetProvider === "netease" || targetProvider === "qq") && track.source === targetProvider && track.sourceTrackId) {
      return [{
        provider: targetProvider,
        id: track.sourceTrackId,
        title: track.title,
        artists: track.artists,
        album: track.album,
        durationSeconds: track.durationSeconds
      }];
    }

    if (targetProvider === "netease") {
      return dependencies.searchNeteaseProviderTracks(track);
    }

    if (targetProvider === "qq") {
      return dependencies.searchQqProviderTracks(track);
    }

    return [];
  };

  const loadSourceTracks: PlaylistTransferRuntime["loadSourceTracks"] = async (input) => {
    if (input.sourceProvider === "netease") {
      if (!input.playlistId) {
        throw new Error("缺少网易云歌单 ID");
      }

      return dependencies.loadNeteasePlaylistTransferTracks(input.playlistId);
    }

    if (input.sourceProvider === "qq") {
      if (!input.playlistId) {
        throw new Error("缺少 QQ 音乐歌单 ID");
      }

      return dependencies.loadQqPlaylistTransferTracks(input.playlistId);
    }

    return [];
  };

  const checkAvailability: PlaylistTransferRuntime["checkAvailability"] = async (candidate) => {
    if (candidate.provider === "netease") {
      return dependencies.checkNeteaseProviderTrackAvailability(candidate);
    }

    return null;
  };

  return {
    searchTargetTracks,
    loadSourceTracks,
    checkAvailability
  };
}
