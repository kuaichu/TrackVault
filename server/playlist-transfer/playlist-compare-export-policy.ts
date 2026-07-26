import { Buffer } from "node:buffer";

export const PLAYLIST_COMPARE_EXPORT_LIMITS = Object.freeze({
  items: 5_000,
  statuses: 5,
  itemIndexes: 5_000,
  artistsPerTrack: 20,
  reasonsPerItem: 20,
  textBytes: 2 * 1024 * 1024
});

export type PlaylistCompareExportLimitResource = keyof typeof PLAYLIST_COMPARE_EXPORT_LIMITS;

export class PlaylistCompareExportLimitError extends Error {
  constructor(
    readonly resource: PlaylistCompareExportLimitResource,
    readonly maximum: number
  ) {
    super("Playlist compare export limit exceeded");
    this.name = "PlaylistCompareExportLimitError";
  }
}

type PlaylistCompareExportLimitInput = {
  result: unknown;
  statuses: unknown;
  itemIndexes?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertArrayLimit(
  resource: PlaylistCompareExportLimitResource,
  value: unknown,
  maximum: number
) {
  if (Array.isArray(value) && value.length > maximum) {
    throw new PlaylistCompareExportLimitError(resource, maximum);
  }
}

function addTextBytes(value: unknown, state: { total: number }) {
  if (typeof value !== "string") {
    return;
  }
  state.total += Buffer.byteLength(value, "utf8");
  if (state.total > PLAYLIST_COMPARE_EXPORT_LIMITS.textBytes) {
    throw new PlaylistCompareExportLimitError("textBytes", PLAYLIST_COMPARE_EXPORT_LIMITS.textBytes);
  }
}

function assertTrackLimits(value: unknown, textBytes: { total: number }) {
  if (!isRecord(value)) {
    return;
  }
  assertArrayLimit("artistsPerTrack", value.artists, PLAYLIST_COMPARE_EXPORT_LIMITS.artistsPerTrack);
  addTextBytes(value.sourceTrackId, textBytes);
  addTextBytes(value.title, textBytes);
  if (Array.isArray(value.artists)) {
    for (const artist of value.artists) {
      addTextBytes(artist, textBytes);
    }
  }
  addTextBytes(value.album, textBytes);
  addTextBytes(value.rawText, textBytes);
}

export function assertPlaylistCompareExportSelectorsWithinLimits(statuses: unknown, itemIndexes?: unknown) {
  assertArrayLimit("statuses", statuses, PLAYLIST_COMPARE_EXPORT_LIMITS.statuses);
  assertArrayLimit("itemIndexes", itemIndexes, PLAYLIST_COMPARE_EXPORT_LIMITS.itemIndexes);
}

export function assertPlaylistCompareExportResultWithinLimits(result: unknown) {
  if (!isRecord(result) || !Array.isArray(result.items)) {
    return;
  }

  const textBytes = { total: 0 };
  if (isRecord(result.left)) {
    addTextBytes(result.left.playlistId, textBytes);
    addTextBytes(result.left.playlistName, textBytes);
  }
  if (isRecord(result.right)) {
    addTextBytes(result.right.playlistId, textBytes);
    addTextBytes(result.right.playlistName, textBytes);
  }
  addTextBytes(result.createdAt, textBytes);

  assertArrayLimit("items", result.items, PLAYLIST_COMPARE_EXPORT_LIMITS.items);
  for (const item of result.items) {
    if (!isRecord(item)) {
      continue;
    }
    assertArrayLimit("reasonsPerItem", item.reasons, PLAYLIST_COMPARE_EXPORT_LIMITS.reasonsPerItem);
    if (Array.isArray(item.reasons)) {
      for (const reason of item.reasons) {
        addTextBytes(reason, textBytes);
      }
    }
    assertTrackLimits(item.leftTrack, textBytes);
    assertTrackLimits(item.rightTrack, textBytes);
  }
}

export function assertPlaylistCompareExportWithinLimits(input: PlaylistCompareExportLimitInput) {
  assertPlaylistCompareExportSelectorsWithinLimits(input.statuses, input.itemIndexes);
  assertPlaylistCompareExportResultWithinLimits(input.result);
}

export function toPlaylistCompareExportLimitResponse(error: PlaylistCompareExportLimitError) {
  return {
    code: "PLAYLIST_COMPARE_EXPORT_LIMIT_EXCEEDED",
    message: "歌单对比导出数据超过允许上限。",
    limit: {
      resource: error.resource,
      maximum: error.maximum
    }
  };
}
