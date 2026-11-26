import { useQuery } from "@tanstack/react-query";
import type { MusicPlatform, ProviderCapabilities } from "#shared";
import { api } from "../api/endpoints.js";

export const DEFAULT_PROVIDER_CAPABILITIES: Record<MusicPlatform, ProviderCapabilities> = {
  netease: {
    platform: "netease",
    canLikeSong: true,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: true,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    shareUrlTemplate: "https://music.163.com/#/song?id={id}",
  },
  qq: {
    platform: "qq",
    canLikeSong: false,
    canManagePlaylistTracks: false,
    canCreatePlaylist: false,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: true,
    canQrLogin: true,
    qrLoginChannels: ["mobile", "qq", "wx"],
    shareUrlTemplate: "https://y.qq.com/n/ryqq/songDetail/{id}",
  },
  kugou: {
    platform: "kugou",
    canLikeSong: false,
    canManagePlaylistTracks: true,
    canCreatePlaylist: true,
    canLoadCloudDisk: false,
    canReadComments: true,
    canLikeComments: false,
    canQrLogin: true,
    qrLoginChannels: ["kg_lite", "kg_std", "kg_wx_lite", "kg_wx_std"],
    shareUrlTemplate: "https://www.kugou.com/song/#hash={id}",
  },
};

export function useCapabilitiesQuery() {
  return useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.getCapabilities(),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

export function useCapabilities(): Record<MusicPlatform, ProviderCapabilities> {
  const query = useCapabilitiesQuery();
  if (!query.data?.capabilities) return DEFAULT_PROVIDER_CAPABILITIES;
  return {
    ...DEFAULT_PROVIDER_CAPABILITIES,
    ...query.data.capabilities,
  };
}
