import crypto from "node:crypto";
import { matchTransferTrack, summarizeTransferResults } from "./matcher.js";
import { parseTextPlaylist } from "./text-parser.js";
import type {
  MatchCandidate,
  PlaylistTransferJob,
  ProviderTrack,
  TransferImportRequest,
  TransferTargetProvider,
  TransferTrack,
  TransferTrackResult
} from "./types.js";

export type CreatePlaylistTransferInput = TransferImportRequest & {
  ownerKey: string;
};

export type PlaylistTransferProgressPhase = "loading" | "matching" | "saving" | "completed";

export type PlaylistTransferProgress = {
  phase: PlaylistTransferProgressPhase;
  processed: number;
  total: number;
  matched: number;
  manualReview: number;
  notFound: number;
  unavailable: number;
  duplicate: number;
  skipped: number;
  currentTitle?: string;
};

export type CreatePlaylistTransferDeps = {
  loadSourceTracks?: (input: CreatePlaylistTransferInput) => Promise<TransferTrack[]>;
  searchTargetTracks: (track: TransferTrack, targetProvider: TransferTargetProvider) => Promise<ProviderTrack[]>;
  checkAvailability?: (candidate: MatchCandidate) => Promise<{ status: TransferTrackResult["status"]; reason: string } | null>;
  saveJob: (job: PlaylistTransferJob) => Promise<PlaylistTransferJob>;
  onProgress?: (progress: PlaylistTransferProgress) => void;
};

function normalizeDuplicateKey(track: TransferTrack) {
  return `${track.title}|${track.artists.join("/")}`
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim();
}

function parseCsvPlaylist(input: string): TransferTrack[] {
  const lines = input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines[0]?.toLocaleLowerCase().includes("title") ? lines.slice(1) : lines;

  return rows.map((line, index) => {
    const [title = "", artist = "", album = ""] = line.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
    return {
      source: "csv" as const,
      sourceTrackId: `csv-${index + 1}`,
      title,
      artists: artist ? artist.split(/\s*(?:\/|、|，|&)\s*/).filter(Boolean) : [],
      album: album || undefined,
      rawText: line
    };
  }).filter((track) => track.title);
}

async function loadInputTracks(input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) {
  let tracks: TransferTrack[];

  if (input.sourceProvider === "text") {
    tracks = parseTextPlaylist(input.text ?? "");
  } else if (input.sourceProvider === "csv") {
    tracks = parseCsvPlaylist(input.text ?? "");
  } else {
    if (!deps.loadSourceTracks) {
      throw new Error("当前来源平台没有配置歌单读取能力");
    }

    tracks = await deps.loadSourceTracks(input);
  }

  const selectedIds = new Set((input.sourceTrackIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (selectedIds.size === 0) {
    return tracks;
  }

  return tracks.filter((track) => track.sourceTrackId && selectedIds.has(track.sourceTrackId));
}

function applyCandidateAvailability(result: TransferTrackResult): TransferTrackResult {
  const availability = result.selectedCandidate?.availability;
  if (result.status !== "matched" || !availability || availability.status === "available") {
    return result;
  }

  return {
    ...result,
    status: availability.status,
    reason: availability.reason ?? "目标平台标记该歌曲不可用"
  };
}

function buildProgress(
  phase: PlaylistTransferProgressPhase,
  results: TransferTrackResult[],
  total: number,
  currentTitle?: string
): PlaylistTransferProgress {
  const summary = summarizeTransferResults(results);

  return {
    phase,
    processed: results.length,
    total,
    matched: summary.matched,
    manualReview: summary.manualReview,
    notFound: summary.notFound,
    unavailable: summary.unavailable,
    duplicate: summary.duplicate,
    skipped: summary.skipped,
    currentTitle
  };
}

export async function createPlaylistTransferJob(input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) {
  deps.onProgress?.(buildProgress("loading", [], 0));
  const sourceTracks = await loadInputTracks(input, deps);
  const seen = new Set<string>();
  const results: TransferTrackResult[] = [];
  deps.onProgress?.(buildProgress("matching", results, sourceTracks.length));

  for (const sourceTrack of sourceTracks) {
    const duplicateKey = normalizeDuplicateKey(sourceTrack);
    if (seen.has(duplicateKey)) {
      results.push({
        sourceTrack,
        status: "duplicate",
        candidates: [],
        reason: "导入列表中已存在相同歌名和歌手"
      });
      deps.onProgress?.(buildProgress("matching", results, sourceTracks.length, sourceTrack.title));
      continue;
    }
    seen.add(duplicateKey);

    if (input.targetProvider === "text") {
      results.push({
        sourceTrack,
        status: "matched",
        candidates: []
      });
      deps.onProgress?.(buildProgress("matching", results, sourceTracks.length, sourceTrack.title));
      continue;
    }

    const candidates = await deps.searchTargetTracks(sourceTrack, input.targetProvider);
    let result = applyCandidateAvailability(matchTransferTrack(sourceTrack, candidates));

    if (input.checkAvailability && result.selectedCandidate && deps.checkAvailability) {
      const availability = await deps.checkAvailability(result.selectedCandidate);
      if (availability) {
        result = {
          ...result,
          status: availability.status,
          reason: availability.reason
        };
      }
    }

    results.push(result);
    deps.onProgress?.(buildProgress("matching", results, sourceTracks.length, sourceTrack.title));
  }

  const now = new Date().toISOString();
  const job: PlaylistTransferJob = {
    id: crypto.randomUUID(),
    ownerKey: input.ownerKey,
    sourceProvider: input.sourceProvider,
    targetProvider: input.targetProvider,
    playlistName: input.playlistName?.trim() || "未命名歌单",
    tracks: results,
    summary: summarizeTransferResults(results),
    createdAt: now,
    updatedAt: now
  };

  deps.onProgress?.(buildProgress("saving", results, sourceTracks.length));
  const savedJob = await deps.saveJob(job);
  deps.onProgress?.(buildProgress("completed", results, sourceTracks.length));
  return savedJob;
}

export function getNeteaseImportTrackIds(job: PlaylistTransferJob) {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const result of job.tracks) {
    const candidate = result.selectedCandidate;
    if (result.status !== "matched" || candidate?.provider !== "netease" || !candidate.targetTrackId) {
      continue;
    }

    if (seen.has(candidate.targetTrackId)) {
      continue;
    }

    seen.add(candidate.targetTrackId);
    ids.push(candidate.targetTrackId);
  }

  return ids;
}
