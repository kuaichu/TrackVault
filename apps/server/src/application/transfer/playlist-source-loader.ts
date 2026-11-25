import {
  type QualityLevel,
  type ScanStats,
  type Song,
  type StartTransferInput,
  type TransferAvailability,
  type TransferTrack,
  normalizeScanStats,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type {
  MusicProviderAdapter,
  ProviderAuthContext,
  ProviderRegistry,
} from "../../domain/ports/music-provider.js";
import { parseCsvPlaylistWithStats, parseTextPlaylistWithStats } from "../../domain/transfer/text-and-csv.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";

export const MAX_TRANSFER_TRACKS = 1000;
export const MAX_SELECTED_SCAN_TRACKS = 10_000;
export const MAX_COMPARE_TRACKS = 1500;

export function songToTransferTrack(song: Song): TransferTrack {
  return {
    source: song.platform,
    sourceTrackId: song.id,
    title: song.title,
    artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
    album: song.album,
    durationSeconds: song.durationSeconds,
  };
}

/**
 * Distinguishes "belongs to VIP catalog" (`status === "vip", locked === false` -> playable for VIP user)
 * from "locked for current account" (`locked === true` -> vip_only).
 */
export function songToAvailability(song: Song): TransferAvailability {
  const playback = song.availability?.playback;
  if (!playback) return "playable";
  if (playback.status === "copyright") return "copyright_unavailable";
  if (playback.locked) {
    if (playback.status === "paid_album") return "paid_album";
    if (playback.status === "restricted") return "restricted";
    if (playback.status === "vip") return "vip_only";
    return "copyright_unavailable";
  }
  return "playable";
}

export function songToCandidate(song: Song) {
  return {
    provider: song.platform,
    id: song.id,
    mediaId: song.mediaId,
    title: song.title,
    artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
    album: song.album,
    durationSeconds: song.durationSeconds,
    availableLevels: song.availableQualities?.map((q) => q.level),
    availability: songToAvailability(song),
  };
}

export interface LoadedProviderPlaylist {
  songs: Song[];
  sourceTotal: number;
  rawSlotTotal?: number;
  scannedSlotIds?: ReadonlySet<string>;
  beyondScanSlotIds?: ReadonlySet<string>;
  truncated: boolean;
}

export function computeLoadedPlaylistOmissions(
  loaded: LoadedProviderPlaylist,
  cap: number,
): {
  unprocessedCount: number;
  truncatedCount: number;
  missingDetailCount: number;
  scannedSlotCount: number;
} {
  const unprocessedCount = Math.max(0, loaded.sourceTotal - loaded.songs.length);
  const scannedSlotCount = loaded.scannedSlotIds
    ? loaded.scannedSlotIds.size
    : Math.min(loaded.sourceTotal, cap);
  const truncatedCount = loaded.truncated
    ? Math.min(unprocessedCount, Math.max(0, loaded.sourceTotal - scannedSlotCount))
    : 0;
  const missingDetailCount = Math.max(0, unprocessedCount - truncatedCount);
  return { unprocessedCount, truncatedCount, missingDetailCount, scannedSlotCount };
}

export async function fetchProviderPlaylistBounded(
  adapter: MusicProviderAdapter,
  playlistId: string,
  auth: ProviderAuthContext,
  cap: number,
): Promise<LoadedProviderPlaylist> {
  if (typeof adapter.inspectPlaylistTracks === "function") {
    const inspected = await adapter.inspectPlaylistTracks(playlistId, cap, auth);
    return {
      songs: inspected.songs,
      sourceTotal: inspected.totalSlots,
      rawSlotTotal: inspected.totalSlots,
      scannedSlotIds: inspected.scannedSlotIds,
      beyondScanSlotIds: inspected.beyondScanSlotIds,
      truncated: inspected.truncatedSlots,
    };
  }

  // Request cap + 1 so truncation is detected even when mocks only implement getAllPlaylistTracks
  const fetched = await adapter.getAllPlaylistTracks(playlistId, auth, cap + 1);
  const songs = fetched.slice(0, cap);
  let sourceTotal = fetched.length;
  let rawSlotTotal: number | undefined;

  if (typeof adapter.getPlaylistTracks === "function") {
    try {
      const page = await adapter.getPlaylistTracks(playlistId, { page: 1, limit: 1 }, auth);
      if (typeof page.total === "number" && Number.isFinite(page.total)) {
        rawSlotTotal = page.total;
        sourceTotal = Math.max(sourceTotal, page.total);
      }
    } catch {
      // Non-fatal: keep fetched count
    }
  }

  const truncated = fetched.length > cap || (rawSlotTotal !== undefined && rawSlotTotal > cap);
  return {
    songs,
    sourceTotal,
    rawSlotTotal,
    truncated,
  };
}

export interface LoadedSourceBundle {
  tracks: TransferTrack[];
  scanStats: ScanStats;
  hasPlaylistTotal: boolean;
  selectedMode: boolean;
  beyondScanCount?: number;
  sourceMetaByKey: Map<
    string,
    { availability: TransferAvailability; mediaId?: string; availableLevels?: readonly QualityLevel[] }
  >;
}

function collectSelectedTracks<T>(
  items: readonly T[],
  getId: (item: T) => string | undefined,
  selectedSet: ReadonlySet<string>,
  cap: number,
): T[] {
  const seen = new Set<string>();
  const picked: T[] = [];
  for (const item of items) {
    const id = getId(item)?.trim();
    if (id && selectedSet.has(id) && !seen.has(id) && picked.length < cap) {
      seen.add(id);
      picked.push(item);
    }
  }
  return picked;
}

export async function loadTransferSourceTracks(deps: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  actor: ActorContext;
  input: StartTransferInput;
  signal?: AbortSignal;
}): Promise<LoadedSourceBundle> {
  const { providers, authResolver, actor, input, signal } = deps;
  const sourceMetaByKey = new Map<
    string,
    { availability: TransferAvailability; mediaId?: string; availableLevels?: readonly QualityLevel[] }
  >();
  const requestedIds = input.selectedSourceTrackIds
    ? [...new Set(input.selectedSourceTrackIds.map((id) => id.trim()).filter(Boolean))]
    : [];
  const selectedSet = requestedIds.length > 0 ? new Set(requestedIds) : null;

  if (input.sourceTracks && input.sourceTracks.length > 0) {
    if (selectedSet) {
      const filtered = collectSelectedTracks(
        input.sourceTracks,
        (item) => item.sourceTrackId,
        selectedSet,
        MAX_TRANSFER_TRACKS,
      );
      const hitTransferCap = selectedSet.size > MAX_TRANSFER_TRACKS && filtered.length >= MAX_TRANSFER_TRACKS;
      const unprocessedCount = Math.max(0, selectedSet.size - filtered.length);
      const truncatedCount = hitTransferCap
        ? Math.min(unprocessedCount, Math.max(0, selectedSet.size - MAX_TRANSFER_TRACKS))
        : 0;
      const missingDetailCount = Math.max(0, unprocessedCount - truncatedCount);
      return {
        tracks: filtered,
        scanStats: normalizeScanStats({
          playlistTotal: input.sourceTracks.length,
          sourceTotal: selectedSet.size,
          processedCount: filtered.length,
          unprocessedCount,
          missingDetailCount,
          truncatedCount,
          truncated: hitTransferCap,
        }),
        hasPlaylistTotal: true,
        selectedMode: true,
        sourceMetaByKey,
      };
    }

    const sourceTotal = input.sourceTracks.length;
    const tracks = input.sourceTracks.slice(0, MAX_TRANSFER_TRACKS);
    return {
      tracks,
      scanStats: normalizeScanStats({
        playlistTotal: sourceTotal,
        sourceTotal,
        scannedSlotCount: tracks.length,
        processedCount: tracks.length,
        unprocessedCount: Math.max(0, sourceTotal - tracks.length),
        missingDetailCount: 0,
        truncatedCount: Math.max(0, sourceTotal - tracks.length),
        truncated: sourceTotal > tracks.length,
      }),
      hasPlaylistTotal: false,
      selectedMode: false,
      sourceMetaByKey,
    };
  }

  if (input.sourceProvider === "text" || input.sourceProvider === "csv") {
    const parsed =
      input.sourceProvider === "text"
        ? parseTextPlaylistWithStats(input.rawText ?? "", MAX_TRANSFER_TRACKS)
        : parseCsvPlaylistWithStats(input.rawText ?? "", MAX_TRANSFER_TRACKS);
    const truncatedCount = parsed.truncated ? Math.max(0, parsed.sourceTotal - parsed.tracks.length) : 0;
    return {
      tracks: parsed.tracks,
      scanStats: normalizeScanStats({
        playlistTotal: parsed.sourceTotal,
        sourceTotal: parsed.sourceTotal,
        scannedSlotCount: parsed.tracks.length,
        processedCount: parsed.tracks.length,
        unprocessedCount: Math.max(0, parsed.sourceTotal - parsed.tracks.length),
        missingDetailCount: 0,
        truncatedCount,
        truncated: parsed.truncated,
      }),
      hasPlaylistTotal: false,
      selectedMode: false,
      sourceMetaByKey,
    };
  }

  if (!input.playlistId) {
    throw new AppError("VALIDATION_ERROR", "请提供源歌单 ID。");
  }

  const sourceAdapter = providers.get(input.sourceProvider);
  const sourceAuth = authResolver.buildPersonalAuth(actor, input.sourceProvider, signal);
  const loaded = await fetchProviderPlaylistBounded(
    sourceAdapter,
    input.playlistId,
    sourceAuth,
    MAX_TRANSFER_TRACKS,
  );

  if (selectedSet) {
    let filteredSongs = collectSelectedTracks(loaded.songs, (s) => s.id, selectedSet, MAX_TRANSFER_TRACKS);
    const targetCollectCount = Math.min(selectedSet.size, MAX_TRANSFER_TRACKS);
    let finalScannedSlotIds = loaded.scannedSlotIds;
    let finalBeyondScanSlotIds = loaded.beyondScanSlotIds;
    let scanExhaustedPlaylist = !loaded.truncated;

    const getMissingSelectedIds = (picked: readonly Song[]): string[] => {
      const pickedSet = new Set(picked.map((s) => s.id));
      return [...selectedSet].filter((id) => !pickedSet.has(id));
    };

    const initialMissingIds = getMissingSelectedIds(filteredSongs);
    const shouldDeepScan =
      filteredSongs.length < targetCollectCount &&
      loaded.truncated &&
      (!loaded.beyondScanSlotIds ||
        initialMissingIds.some((id) => !loaded.scannedSlotIds?.has(id) && loaded.beyondScanSlotIds?.has(id)));

    if (shouldDeepScan) {
      if (typeof sourceAdapter.inspectPlaylistTracks === "function") {
        const deepInspected = await sourceAdapter.inspectPlaylistTracks(
          input.playlistId,
          MAX_SELECTED_SCAN_TRACKS,
          sourceAuth,
        );
        filteredSongs = collectSelectedTracks(
          deepInspected.songs,
          (s) => s.id,
          selectedSet,
          MAX_TRANSFER_TRACKS,
        );
        finalScannedSlotIds = deepInspected.scannedSlotIds;
        finalBeyondScanSlotIds = deepInspected.beyondScanSlotIds;
        scanExhaustedPlaylist = !deepInspected.truncatedSlots;
      } else {
        const deepScanned = await sourceAdapter.getAllPlaylistTracks(
          input.playlistId,
          sourceAuth,
          MAX_SELECTED_SCAN_TRACKS,
        );
        filteredSongs = collectSelectedTracks(deepScanned, (s) => s.id, selectedSet, MAX_TRANSFER_TRACKS);
        scanExhaustedPlaylist =
          loaded.rawSlotTotal !== undefined
            ? loaded.rawSlotTotal <= MAX_SELECTED_SCAN_TRACKS
            : deepScanned.length < MAX_SELECTED_SCAN_TRACKS;
      }
    }

    for (const song of filteredSongs) {
      sourceMetaByKey.set(`${song.platform}:${song.id}`, {
        availability: songToAvailability(song),
        mediaId: song.mediaId,
        availableLevels: song.availableQualities?.map((q) => q.level),
      });
    }

    const finalMissingIds = getMissingSelectedIds(filteredSongs);
    const beyondScanCount =
      finalScannedSlotIds && finalBeyondScanSlotIds
        ? finalMissingIds.filter((id) => !finalScannedSlotIds.has(id) && finalBeyondScanSlotIds.has(id))
            .length
        : !scanExhaustedPlaylist
          ? finalMissingIds.length
          : 0;

    const hitTransferCap =
      selectedSet.size > MAX_TRANSFER_TRACKS && filteredSongs.length >= MAX_TRANSFER_TRACKS;
    const truncatedByScan = filteredSongs.length < targetCollectCount && beyondScanCount > 0;
    const unprocessedCount = Math.max(0, selectedSet.size - filteredSongs.length);
    const truncatedCount = hitTransferCap
      ? Math.min(unprocessedCount, Math.max(0, selectedSet.size - MAX_TRANSFER_TRACKS))
      : truncatedByScan
        ? Math.min(unprocessedCount, beyondScanCount)
        : 0;
    const missingDetailCount = Math.max(0, unprocessedCount - truncatedCount);

    return {
      tracks: filteredSongs.map(songToTransferTrack),
      scanStats: normalizeScanStats({
        playlistTotal: loaded.sourceTotal,
        sourceTotal: selectedSet.size,
        scannedSlotCount: finalScannedSlotIds
          ? finalScannedSlotIds.size
          : filteredSongs.length + missingDetailCount,
        processedCount: filteredSongs.length,
        unprocessedCount,
        missingDetailCount,
        truncatedCount,
        beyondScanCount,
        truncated: hitTransferCap || truncatedByScan,
      }),
      hasPlaylistTotal: true,
      selectedMode: true,
      beyondScanCount,
      sourceMetaByKey,
    };
  }

  for (const song of loaded.songs) {
    sourceMetaByKey.set(`${song.platform}:${song.id}`, {
      availability: songToAvailability(song),
      mediaId: song.mediaId,
      availableLevels: song.availableQualities?.map((q) => q.level),
    });
  }

  const wholeOmissions = computeLoadedPlaylistOmissions(loaded, MAX_TRANSFER_TRACKS);
  return {
    tracks: loaded.songs.map(songToTransferTrack),
    scanStats: normalizeScanStats({
      playlistTotal: loaded.sourceTotal,
      sourceTotal: loaded.sourceTotal,
      scannedSlotCount: wholeOmissions.scannedSlotCount,
      processedCount: loaded.songs.length,
      unprocessedCount: wholeOmissions.unprocessedCount,
      missingDetailCount: wholeOmissions.missingDetailCount,
      truncatedCount: wholeOmissions.truncatedCount,
      truncated: loaded.truncated,
    }),
    hasPlaylistTotal: false,
    selectedMode: false,
    sourceMetaByKey,
  };
}
