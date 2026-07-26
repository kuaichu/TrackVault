import type {
  PlaylistCompareItem,
  PlaylistCompareRequest,
  PlaylistCompareResult,
  PlaylistCompareStatus
} from "./playlist-compare.js";
import type {
  PlaylistCompareJob,
  PlaylistCompareJobProgress,
  PlaylistCompareJobStatus
} from "./playlist-compare-job.js";
import { toPublicTransferTrack } from "./public-dto.js";
import type { PublicTransferTrack, TransferSourceProvider } from "./types.js";

export type PublicPlaylistCompareItem = {
  status: PlaylistCompareStatus;
  leftTrack?: PublicTransferTrack;
  rightTrack?: PublicTransferTrack;
  score: number;
  reasons: string[];
};

export type PublicPlaylistCompareResult = {
  left: {
    provider: TransferSourceProvider;
    playlistId?: string;
    playlistName: string;
    total: number;
  };
  right: {
    provider: TransferSourceProvider;
    playlistId?: string;
    playlistName: string;
    total: number;
  };
  items: PublicPlaylistCompareItem[];
  summary: {
    totalLeft: number;
    totalRight: number;
    exact: number;
    sameTitleDifferentArtist: number;
    similarTitle: number;
    leftOnly: number;
    rightOnly: number;
  };
  createdAt: string;
};

export type PublicPlaylistCompareJob = {
  id: string;
  status: PlaylistCompareJobStatus;
  input: {
    leftProvider: TransferSourceProvider;
    leftPlaylistId?: string;
    leftPlaylistName?: string;
    leftText?: string;
    rightProvider: TransferSourceProvider;
    rightPlaylistId?: string;
    rightPlaylistName?: string;
    rightText?: string;
  };
  progress: PlaylistCompareJobProgress;
  result?: PublicPlaylistCompareResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

const sourceProviders: TransferSourceProvider[] = ["netease", "qq", "text", "csv"];
const compareStatuses: PlaylistCompareStatus[] = [
  "exact",
  "same_title_different_artist",
  "similar_title",
  "left_only",
  "right_only"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceProvider(value: unknown): value is TransferSourceProvider {
  return typeof value === "string" && sourceProviders.includes(value as TransferSourceProvider);
}

function isCompareStatus(value: unknown): value is PlaylistCompareStatus {
  return typeof value === "string" && compareStatuses.includes(value as PlaylistCompareStatus);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function parseOptionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : typeof value === "string" ? value : null;
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? [...value]
    : null;
}

function parseTrack(value: unknown): PublicTransferTrack | null {
  if (!isRecord(value) || !isSourceProvider(value.source) || typeof value.title !== "string") {
    return null;
  }

  const artists = parseStringArray(value.artists);
  const sourceTrackId = parseOptionalString(value.sourceTrackId);
  const album = parseOptionalString(value.album);
  const rawText = parseOptionalString(value.rawText);
  if (!artists || sourceTrackId === null || album === null || rawText === null) {
    return null;
  }
  if (value.durationSeconds !== undefined && !isFiniteNumber(value.durationSeconds)) {
    return null;
  }

  return {
    source: value.source,
    ...(sourceTrackId === undefined ? {} : { sourceTrackId }),
    title: value.title,
    artists,
    ...(album === undefined ? {} : { album }),
    ...(value.durationSeconds === undefined ? {} : { durationSeconds: value.durationSeconds }),
    ...(rawText === undefined ? {} : { rawText })
  };
}

function parseCompareItem(value: unknown): PublicPlaylistCompareItem | null {
  if (!isRecord(value) || !isCompareStatus(value.status) || !isFiniteNumber(value.score)) {
    return null;
  }

  const reasons = parseStringArray(value.reasons);
  const leftTrack = value.leftTrack === undefined ? undefined : parseTrack(value.leftTrack);
  const rightTrack = value.rightTrack === undefined ? undefined : parseTrack(value.rightTrack);
  if (!reasons || leftTrack === null || rightTrack === null) {
    return null;
  }
  if (value.status === "left_only" && leftTrack === undefined) {
    return null;
  }
  if (value.status === "right_only" && rightTrack === undefined) {
    return null;
  }
  if (
    value.status !== "left_only" &&
    value.status !== "right_only" &&
    (leftTrack === undefined || rightTrack === undefined)
  ) {
    return null;
  }

  return {
    status: value.status,
    ...(leftTrack === undefined ? {} : { leftTrack }),
    ...(rightTrack === undefined ? {} : { rightTrack }),
    score: value.score,
    reasons
  };
}

function parseSide(value: unknown): PublicPlaylistCompareResult["left"] | null {
  if (!isRecord(value) || !isSourceProvider(value.provider) || typeof value.playlistName !== "string" || !isNonNegativeInteger(value.total)) {
    return null;
  }
  const playlistId = parseOptionalString(value.playlistId);
  if (playlistId === null) {
    return null;
  }
  return {
    provider: value.provider,
    ...(playlistId === undefined ? {} : { playlistId }),
    playlistName: value.playlistName,
    total: value.total
  };
}

function parseSummary(value: unknown): PublicPlaylistCompareResult["summary"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const fields = [
    value.totalLeft,
    value.totalRight,
    value.exact,
    value.sameTitleDifferentArtist,
    value.similarTitle,
    value.leftOnly,
    value.rightOnly
  ];
  if (!fields.every(isNonNegativeInteger)) {
    return null;
  }
  return {
    totalLeft: value.totalLeft as number,
    totalRight: value.totalRight as number,
    exact: value.exact as number,
    sameTitleDifferentArtist: value.sameTitleDifferentArtist as number,
    similarTitle: value.similarTitle as number,
    leftOnly: value.leftOnly as number,
    rightOnly: value.rightOnly as number
  };
}

function toPublicCompareItem(item: PlaylistCompareItem): PublicPlaylistCompareItem {
  return {
    status: item.status,
    ...(item.leftTrack === undefined ? {} : { leftTrack: toPublicTransferTrack(item.leftTrack) }),
    ...(item.rightTrack === undefined ? {} : { rightTrack: toPublicTransferTrack(item.rightTrack) }),
    score: item.score,
    reasons: [...item.reasons]
  };
}

export function toPublicPlaylistCompareResult(result: PlaylistCompareResult): PublicPlaylistCompareResult {
  return {
    left: {
      provider: result.left.provider,
      ...(result.left.playlistId === undefined ? {} : { playlistId: result.left.playlistId }),
      playlistName: result.left.playlistName,
      total: result.left.total
    },
    right: {
      provider: result.right.provider,
      ...(result.right.playlistId === undefined ? {} : { playlistId: result.right.playlistId }),
      playlistName: result.right.playlistName,
      total: result.right.total
    },
    items: result.items.map(toPublicCompareItem),
    summary: {
      totalLeft: result.summary.totalLeft,
      totalRight: result.summary.totalRight,
      exact: result.summary.exact,
      sameTitleDifferentArtist: result.summary.sameTitleDifferentArtist,
      similarTitle: result.summary.similarTitle,
      leftOnly: result.summary.leftOnly,
      rightOnly: result.summary.rightOnly
    },
    createdAt: result.createdAt
  };
}

function toPublicCompareInput(input: PlaylistCompareRequest): PublicPlaylistCompareJob["input"] {
  return {
    leftProvider: input.leftProvider,
    ...(input.leftPlaylistId === undefined ? {} : { leftPlaylistId: input.leftPlaylistId }),
    ...(input.leftPlaylistName === undefined ? {} : { leftPlaylistName: input.leftPlaylistName }),
    ...(input.leftText === undefined ? {} : { leftText: input.leftText }),
    rightProvider: input.rightProvider,
    ...(input.rightPlaylistId === undefined ? {} : { rightPlaylistId: input.rightPlaylistId }),
    ...(input.rightPlaylistName === undefined ? {} : { rightPlaylistName: input.rightPlaylistName }),
    ...(input.rightText === undefined ? {} : { rightText: input.rightText })
  };
}

export function toPublicPlaylistCompareJob(job: PlaylistCompareJob): PublicPlaylistCompareJob {
  return {
    id: job.id,
    status: job.status,
    input: toPublicCompareInput(job.input),
    progress: {
      phase: job.progress.phase,
      processed: job.progress.processed,
      total: job.progress.total,
      exact: job.progress.exact,
      sameTitleDifferentArtist: job.progress.sameTitleDifferentArtist,
      similarTitle: job.progress.similarTitle,
      leftOnly: job.progress.leftOnly,
      rightOnly: job.progress.rightOnly,
      ...(job.progress.currentTitle === undefined ? {} : { currentTitle: job.progress.currentTitle })
    },
    ...(job.result === undefined ? {} : { result: toPublicPlaylistCompareResult(job.result) }),
    ...(job.error === undefined ? {} : { error: job.error }),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export function parsePublicPlaylistCompareResult(value: unknown): PublicPlaylistCompareResult | null {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.createdAt !== "string") {
    return null;
  }
  const left = parseSide(value.left);
  const right = parseSide(value.right);
  const summary = parseSummary(value.summary);
  const items = value.items.map(parseCompareItem);
  if (!left || !right || !summary || items.some((item) => item === null)) {
    return null;
  }
  return {
    left,
    right,
    items: items.filter((item): item is PublicPlaylistCompareItem => item !== null),
    summary,
    createdAt: value.createdAt
  };
}
