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

type CreatePlaylistTransferInput = TransferImportRequest & {
  ownerKey: string;
};

type CreatePlaylistTransferDeps = {
  loadSourceTracks?: (input: CreatePlaylistTransferInput) => Promise<TransferTrack[]>;
  searchTargetTracks: (track: TransferTrack, targetProvider: TransferTargetProvider) => Promise<ProviderTrack[]>;
  checkAvailability?: (candidate: MatchCandidate) => Promise<{ status: TransferTrackResult["status"]; reason: string } | null>;
  saveJob: (job: PlaylistTransferJob) => Promise<PlaylistTransferJob>;
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
  if (input.sourceProvider === "text") {
    return parseTextPlaylist(input.text ?? "");
  }

  if (input.sourceProvider === "csv") {
    return parseCsvPlaylist(input.text ?? "");
  }

  if (!deps.loadSourceTracks) {
    throw new Error("当前来源平台没有配置歌单读取能力");
  }

  return deps.loadSourceTracks(input);
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

export async function createPlaylistTransferJob(input: CreatePlaylistTransferInput, deps: CreatePlaylistTransferDeps) {
  const sourceTracks = await loadInputTracks(input, deps);
  const seen = new Set<string>();
  const results: TransferTrackResult[] = [];

  for (const sourceTrack of sourceTracks) {
    const duplicateKey = normalizeDuplicateKey(sourceTrack);
    if (seen.has(duplicateKey)) {
      results.push({
        sourceTrack,
        status: "duplicate",
        candidates: [],
        reason: "导入列表中已存在相同歌名和歌手"
      });
      continue;
    }
    seen.add(duplicateKey);

    if (input.targetProvider === "text") {
      results.push({
        sourceTrack,
        status: "matched",
        candidates: []
      });
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

  return deps.saveJob(job);
}
