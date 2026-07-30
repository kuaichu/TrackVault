import type { Song, TransferSourceProvider, TransferTrack } from "./types";

export function getPlaylistSourceKey(provider: "qq" | "netease", playlistId: string) {
  return `${provider}:${playlistId.trim()}`;
}

export function isCurrentPlaylistSourceRequest(requestId: number, currentRequestId: number, requestKey: string, currentKey: string) {
  return requestId === currentRequestId && requestKey === currentKey;
}

export function getPlaylistSourceBlockReason(input: { provider: TransferSourceProvider; playlistId: string; loadedPlaylistKey: string; loading: boolean; error: string; songs: Song[]; selectedSongIds: string[] }) {
  if (input.provider !== "qq" && input.provider !== "netease") return "";
  if (input.loading) return "来源歌曲仍在读取，请稍候。";
  if (input.error) return "来源歌曲读取失败，请重新加载。";
  if (input.loadedPlaylistKey !== getPlaylistSourceKey(input.provider, input.playlistId)) return "请等待当前歌单歌曲读取完成。";
  if (input.songs.length === 0) return "来源歌单没有可迁移的歌曲。";
  if (input.selectedSongIds.length === 0) return "请至少选择一首要迁移的歌曲。";
  return "";
}

function parseDurationSeconds(duration: string | undefined) {
  if (!duration) return undefined;
  const parts = duration.split(":").map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  return parts[0] * 60 + parts[1];
}

export function buildSelectedSourceTracks(provider: "qq" | "netease", songs: Song[], selectedSongIds: string[]): TransferTrack[] {
  const selected = new Set(selectedSongIds);
  return songs.filter((song) => selected.has(song.id)).map((song) => ({
    source: provider,
    sourceTrackId: song.providerSongId ?? song.id,
    title: song.title,
    artists: song.artists?.map((artist) => artist.name).filter(Boolean) ?? [song.artist].filter(Boolean),
    album: song.album || undefined,
    durationSeconds: parseDurationSeconds(song.duration)
  }));
}
