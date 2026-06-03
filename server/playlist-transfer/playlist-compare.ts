import type { TransferExportFormat, TransferExportResult, TransferSourceProvider, TransferTrack } from "./types.js";

export type PlaylistCompareStatus =
  | "exact"
  | "same_title_different_artist"
  | "similar_title"
  | "left_only"
  | "right_only";

export type PlaylistCompareSide = {
  provider: TransferSourceProvider;
  playlistId?: string;
  playlistName: string;
  tracks: TransferTrack[];
};

export type PlaylistCompareItem = {
  status: PlaylistCompareStatus;
  leftTrack?: TransferTrack;
  rightTrack?: TransferTrack;
  score: number;
  reasons: string[];
};

export type PlaylistCompareResult = {
  left: Omit<PlaylistCompareSide, "tracks"> & { total: number };
  right: Omit<PlaylistCompareSide, "tracks"> & { total: number };
  items: PlaylistCompareItem[];
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

export type PlaylistCompareProgressPhase = "comparing" | "completed";

export type PlaylistCompareProgress = {
  phase: PlaylistCompareProgressPhase;
  processed: number;
  total: number;
  exact: number;
  sameTitleDifferentArtist: number;
  similarTitle: number;
  leftOnly: number;
  rightOnly: number;
  currentTitle?: string;
};

export type PlaylistCompareRequest = {
  leftProvider: TransferSourceProvider;
  leftPlaylistId?: string;
  leftPlaylistName?: string;
  leftText?: string;
  rightProvider: TransferSourceProvider;
  rightPlaylistId?: string;
  rightPlaylistName?: string;
  rightText?: string;
};

function normalizeStrict(value: string | undefined) {
  return (value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[\s·・._\-—:：'"]/g, "")
    .trim();
}

function normalizeCore(value: string | undefined) {
  return normalizeStrict(value).replace(/[（(].*?[）)]/g, "");
}

function normalizeArtists(artists: string[]) {
  return artists.map(normalizeStrict).filter(Boolean);
}

function hasArtistOverlap(leftArtists: string[], rightArtists: string[]) {
  const left = normalizeArtists(leftArtists);
  const right = normalizeArtists(rightArtists);
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  return left.some((leftArtist) =>
    right.some((rightArtist) => leftArtist === rightArtist || leftArtist.includes(rightArtist) || rightArtist.includes(leftArtist))
  );
}

function compareTrackPair(leftTrack: TransferTrack, rightTrack: TransferTrack): PlaylistCompareItem | null {
  const leftTitle = normalizeStrict(leftTrack.title);
  const rightTitle = normalizeStrict(rightTrack.title);
  const leftCoreTitle = normalizeCore(leftTrack.title);
  const rightCoreTitle = normalizeCore(rightTrack.title);
  const artistOverlap = hasArtistOverlap(leftTrack.artists, rightTrack.artists);
  const durationClose =
    Number.isFinite(leftTrack.durationSeconds) &&
    Number.isFinite(rightTrack.durationSeconds) &&
    Math.abs(Number(leftTrack.durationSeconds) - Number(rightTrack.durationSeconds)) <= 3;

  if (leftTitle && leftTitle === rightTitle && artistOverlap) {
    return {
      status: "exact",
      leftTrack,
      rightTrack,
      score: durationClose ? 100 : 96,
      reasons: durationClose ? ["歌名一致", "歌手匹配", "时长接近"] : ["歌名一致", "歌手匹配"]
    };
  }

  if (leftTitle && leftTitle === rightTitle) {
    return {
      status: "same_title_different_artist",
      leftTrack,
      rightTrack,
      score: durationClose ? 92 : 88,
      reasons: durationClose ? ["歌名一致", "歌手不同", "时长接近"] : ["歌名一致", "歌手不同"]
    };
  }

  if (leftCoreTitle && rightCoreTitle && (leftCoreTitle === rightCoreTitle || leftCoreTitle.includes(rightCoreTitle) || rightCoreTitle.includes(leftCoreTitle))) {
    const score = artistOverlap ? 82 : 72;
    return {
      status: "similar_title",
      leftTrack,
      rightTrack,
      score: durationClose ? score + 5 : score,
      reasons: durationClose ? ["歌名相似", artistOverlap ? "歌手匹配" : "歌手不同", "时长接近"] : ["歌名相似", artistOverlap ? "歌手匹配" : "歌手不同"]
    };
  }

  return null;
}

function statusPriority(status: PlaylistCompareStatus) {
  switch (status) {
    case "exact":
      return 4;
    case "same_title_different_artist":
      return 3;
    case "similar_title":
      return 2;
    case "left_only":
    case "right_only":
      return 1;
  }
}

function findBestRightMatch(leftTrack: TransferTrack, rightTracks: TransferTrack[], usedRightIndexes: Set<number>) {
  let best: { index: number; item: PlaylistCompareItem } | null = null;

  for (let index = 0; index < rightTracks.length; index += 1) {
    if (usedRightIndexes.has(index)) {
      continue;
    }

    const item = compareTrackPair(leftTrack, rightTracks[index]);
    if (!item) {
      continue;
    }

    if (
      !best ||
      statusPriority(item.status) > statusPriority(best.item.status) ||
      (statusPriority(item.status) === statusPriority(best.item.status) && item.score > best.item.score)
    ) {
      best = { index, item };
    }
  }

  return best;
}

function buildCompareProgress(
  phase: PlaylistCompareProgressPhase,
  items: PlaylistCompareItem[],
  processed: number,
  total: number,
  currentTitle?: string
): PlaylistCompareProgress {
  return {
    phase,
    processed,
    total,
    exact: items.filter((item) => item.status === "exact").length,
    sameTitleDifferentArtist: items.filter((item) => item.status === "same_title_different_artist").length,
    similarTitle: items.filter((item) => item.status === "similar_title").length,
    leftOnly: items.filter((item) => item.status === "left_only").length,
    rightOnly: items.filter((item) => item.status === "right_only").length,
    currentTitle
  };
}

export function comparePlaylists(
  input: { left: PlaylistCompareSide; right: PlaylistCompareSide },
  options: { onProgress?: (progress: PlaylistCompareProgress) => void } = {}
): PlaylistCompareResult {
  const items: PlaylistCompareItem[] = [];
  const usedRightIndexes = new Set<number>();
  const total = input.left.tracks.length;
  options.onProgress?.(buildCompareProgress("comparing", items, 0, total));

  for (const [index, leftTrack] of input.left.tracks.entries()) {
    const best = findBestRightMatch(leftTrack, input.right.tracks, usedRightIndexes);
    if (!best) {
      items.push({
        status: "left_only",
        leftTrack,
        score: 0,
        reasons: ["仅左侧歌单存在"]
      });
      options.onProgress?.(buildCompareProgress("comparing", items, index + 1, total, leftTrack.title));
      continue;
    }

    usedRightIndexes.add(best.index);
    items.push(best.item);
    options.onProgress?.(buildCompareProgress("comparing", items, index + 1, total, leftTrack.title));
  }

  input.right.tracks.forEach((rightTrack, index) => {
    if (usedRightIndexes.has(index)) {
      return;
    }

    items.push({
      status: "right_only",
      rightTrack,
      score: 0,
      reasons: ["仅右侧歌单存在"]
    });
  });
  options.onProgress?.(buildCompareProgress("completed", items, total, total));

  return {
    left: {
      provider: input.left.provider,
      playlistId: input.left.playlistId,
      playlistName: input.left.playlistName,
      total: input.left.tracks.length
    },
    right: {
      provider: input.right.provider,
      playlistId: input.right.playlistId,
      playlistName: input.right.playlistName,
      total: input.right.tracks.length
    },
    items,
    summary: {
      totalLeft: input.left.tracks.length,
      totalRight: input.right.tracks.length,
      exact: items.filter((item) => item.status === "exact").length,
      sameTitleDifferentArtist: items.filter((item) => item.status === "same_title_different_artist").length,
      similarTitle: items.filter((item) => item.status === "similar_title").length,
      leftOnly: items.filter((item) => item.status === "left_only").length,
      rightOnly: items.filter((item) => item.status === "right_only").length
    },
    createdAt: new Date().toISOString()
  };
}

function artistsText(artists: string[] | undefined) {
  return artists && artists.length > 0 ? artists.join(" / ") : "未知歌手";
}

function trackText(track: TransferTrack | undefined) {
  if (!track) {
    return "";
  }

  return `${track.title} - ${artistsText(track.artists)}${track.album ? ` - ${track.album}` : ""}`;
}

function statusLabel(status: PlaylistCompareStatus) {
  switch (status) {
    case "exact":
      return "完全一样";
    case "same_title_different_artist":
      return "歌名相同但歌手不同";
    case "similar_title":
      return "歌名相似";
    case "left_only":
      return "仅左侧存在";
    case "right_only":
      return "仅右侧存在";
  }
}

function getExportTrack(item: PlaylistCompareItem) {
  if (item.status === "right_only") {
    return item.rightTrack;
  }

  return item.leftTrack ?? item.rightTrack;
}

function csvValue(value: string | number | undefined) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function formatMarkdown(result: PlaylistCompareResult, statuses: PlaylistCompareStatus[]) {
  const lines = [
    `# ${result.left.playlistName} vs ${result.right.playlistName} 歌单对比`,
    "",
    `左侧：${result.left.playlistName}（${result.left.total} 首）`,
    `右侧：${result.right.playlistName}（${result.right.total} 首）`,
    `生成时间：${result.createdAt}`,
    "",
    `完全一样：${result.summary.exact}`,
    `歌名相同但歌手不同：${result.summary.sameTitleDifferentArtist}`,
    `歌名相似：${result.summary.similarTitle}`,
    `仅左侧存在：${result.summary.leftOnly}`,
    `仅右侧存在：${result.summary.rightOnly}`,
    ""
  ];

  for (const status of statuses) {
    const matches = result.items.filter((item) => item.status === status);
    lines.push(`## ${statusLabel(status)}`);
    if (matches.length === 0) {
      lines.push("无", "");
      continue;
    }

    matches.forEach((item, index) => {
      const right = item.rightTrack ? ` -> ${trackText(item.rightTrack)}` : "";
      lines.push(`${index + 1}. ${trackText(getExportTrack(item))}${right}（${item.reasons.join("、")}）`);
    });
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function formatText(result: PlaylistCompareResult, statuses: PlaylistCompareStatus[]) {
  const lines: string[] = [];
  for (const status of statuses) {
    const matches = result.items.filter((item) => item.status === status);
    if (matches.length === 0) {
      continue;
    }

    lines.push(`# ${statusLabel(status)}`);
    matches.forEach((item) => {
      lines.push(trackText(getExportTrack(item)));
    });
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

function formatCsv(result: PlaylistCompareResult, statuses: PlaylistCompareStatus[]) {
  const rows = [["status", "left_title", "left_artists", "left_album", "right_title", "right_artists", "right_album", "score", "reasons"]];

  for (const item of result.items.filter((entry) => statuses.includes(entry.status))) {
    rows.push([
      statusLabel(item.status),
      item.leftTrack?.title ?? "",
      artistsText(item.leftTrack?.artists),
      item.leftTrack?.album ?? "",
      item.rightTrack?.title ?? "",
      artistsText(item.rightTrack?.artists),
      item.rightTrack?.album ?? "",
      String(item.score),
      item.reasons.join("、")
    ]);
  }

  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

export function formatPlaylistCompareExport(
  result: PlaylistCompareResult,
  format: TransferExportFormat,
  statuses: PlaylistCompareStatus[]
): TransferExportResult {
  const defaultStatuses: PlaylistCompareStatus[] = ["exact", "same_title_different_artist", "similar_title", "left_only", "right_only"];
  const safeStatuses = statuses.length > 0 ? statuses : defaultStatuses;
  const baseName = `${result.left.playlistName}-vs-${result.right.playlistName}-compare`;

  if (format === "json") {
    return {
      filename: `${baseName}.json`,
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify({
        ...result,
        items: result.items.filter((item) => safeStatuses.includes(item.status))
      }, null, 2)
    };
  }

  if (format === "csv") {
    return {
      filename: `${baseName}.csv`,
      contentType: "text/csv; charset=utf-8",
      content: formatCsv(result, safeStatuses)
    };
  }

  if (format === "text") {
    return {
      filename: `${baseName}.txt`,
      contentType: "text/plain; charset=utf-8",
      content: formatText(result, safeStatuses)
    };
  }

  return {
    filename: `${baseName}.md`,
    contentType: "text/markdown; charset=utf-8",
    content: formatMarkdown(result, safeStatuses)
  };
}
