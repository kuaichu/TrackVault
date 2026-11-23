import {
  type CompareResult,
  type CompareStatus,
  type ExportFormat,
  type ExportPayload,
  type ImportAuditResult,
  type TransferResult,
  type TransferTrack,
  escapeCsvCell,
  sanitizeDownloadFilename,
} from "#shared";

/**
 * Full RFC4180-compliant CSV parser (handles quoted fields, escaped quotes, embedded commas and CRLF).
 * Fixes legacy naive line.split(",") that broke round-tripping TrackVault's own exports.
 */
export function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  const normalized = raw.replace(/^\uFEFF/, "");
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i] ?? "";
    const next = normalized[i + 1] ?? "";

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\r" && next === "\n") {
      row.push(cell.trim());
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      row.push(cell.trim());
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  row.push(cell.trim());
  if (row.some((item) => item.length > 0)) {
    rows.push(row);
  }
  return rows;
}

export function parseCsvPlaylist(raw: string, maxTracks = 1000): TransferTrack[] {
  const rows = parseCsvRows(raw);
  if (rows.length === 0) return [];

  const firstRow = rows[0] ?? [];
  const lowerHeaders = firstRow.map((h) => h.toLowerCase());
  const hasHeader = lowerHeaders.some((h) =>
    ["title", "歌名", "歌曲", "源歌名", "name", "artist", "歌手", "源歌手"].includes(h),
  );

  let titleCol = 0;
  let artistCol = 1;
  let albumCol = 2;

  if (hasHeader) {
    const foundTitle = lowerHeaders.findIndex((h) => ["title", "歌名", "歌曲", "源歌名", "name"].includes(h));
    const foundArtist = lowerHeaders.findIndex((h) => ["artist", "artists", "歌手", "源歌手"].includes(h));
    const foundAlbum = lowerHeaders.findIndex((h) => ["album", "专辑", "源专辑"].includes(h));
    if (foundTitle >= 0) titleCol = foundTitle;
    if (foundArtist >= 0) artistCol = foundArtist;
    if (foundAlbum >= 0) albumCol = foundAlbum;
  }

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const tracks: TransferTrack[] = [];

  for (const cols of dataRows) {
    if (tracks.length >= maxTracks) break;
    const title = (cols[titleCol] ?? "").replace(/^'/, "").trim();
    if (!title) continue;
    const rawArtists = (cols[artistCol] ?? "").replace(/^'/, "").trim();
    const album = (cols[albumCol] ?? "").replace(/^'/, "").trim() || undefined;
    const artists = rawArtists
      ? rawArtists
          .split(/\s*[/、;&]\s*/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

    tracks.push({ source: "csv", title, artists, album });
  }

  return tracks;
}

const IGNORED_TEXT_PREFIXES = [
  "#",
  "歌单：",
  "来源：",
  "目标：",
  "总数：",
  "已匹配：",
  "待确认：",
  "未找到：",
  "不可用：",
  "重复：",
  "统计：",
  "---",
];

export function parseTextPlaylist(raw: string, maxTracks = 1000): TransferTrack[] {
  const tracks: TransferTrack[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (tracks.length >= maxTracks) break;
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === "无") continue;
    if (IGNORED_TEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;

    // Strip leading numbering like "1. " or "01) " or "- "
    const body = trimmed.replace(/^(?:\d+[.)、]\s*|[-*•]\s*)/, "").trim();
    if (!body) continue;

    // Split by explicit track delimiters (" - ", " — ", "\t", " | ") without breaking commas inside titles/artists
    const parts = body
      .split(/\s+[-—–|]\s+|\t+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const title = parts[0] ?? body;
    const rawArtists = parts[1] ?? "";
    const album = parts[2] || undefined;
    const artists = rawArtists
      ? rawArtists
          .split(/\s*[/、;&]\s*/)
          .map((a) => a.trim())
          .filter(Boolean)
      : [];

    tracks.push({ source: "text", title, artists, album });
  }

  return tracks;
}

export function formatTransferExport(result: TransferResult, format: ExportFormat): ExportPayload {
  const safeBase = sanitizeDownloadFilename(`${result.playlistName}-transfer`, "playlist-transfer");

  if (format === "json") {
    return {
      filename: `${safeBase}.json`,
      mimeType: "application/json; charset=utf-8",
      content: JSON.stringify(result, null, 2),
    };
  }

  if (format === "csv") {
    const header = ["源歌名", "源歌手", "源专辑", "匹配状态", "目标歌名", "目标歌手", "置信度", "说明"]
      .map(escapeCsvCell)
      .join(",");
    const lines = result.results.map((item) =>
      [
        item.sourceTrack.title,
        item.sourceTrack.artists.join(" / "),
        item.sourceTrack.album ?? "",
        item.status,
        item.selectedCandidate?.title ?? "",
        item.selectedCandidate?.artists.join(" / ") ?? "",
        item.selectedCandidate?.confidenceScore ?? "",
        item.reason ?? "",
      ]
        .map(escapeCsvCell)
        .join(","),
    );
    return {
      filename: `${safeBase}.csv`,
      mimeType: "text/csv; charset=utf-8",
      content: `\uFEFF${[header, ...lines].join("\r\n")}`,
    };
  }

  if (format === "text") {
    const lines = result.results.map((item, idx) => {
      const artists = item.sourceTrack.artists.join(" / ");
      const album = item.sourceTrack.album ? ` - ${item.sourceTrack.album}` : "";
      return `${idx + 1}. ${item.sourceTrack.title}${artists ? ` - ${artists}` : ""}${album}`;
    });
    return {
      filename: `${safeBase}.txt`,
      mimeType: "text/plain; charset=utf-8",
      content: lines.join("\n"),
    };
  }

  const mdLines = [
    `# 歌单互转报告：${result.playlistName}`,
    "",
    `- 来源：${result.sourceProvider} -> 目标：${result.targetProvider}`,
    `- 总数：${result.summary.total} | 匹配：${result.summary.matched} | 待确认：${result.summary.manualReview} | 未找到：${result.summary.notFound} | 不可用：${result.summary.unavailable}`,
    "",
    ...result.results.map((item, idx) => {
      const target = item.selectedCandidate
        ? ` -> ${item.selectedCandidate.title} (${item.selectedCandidate.confidenceScore}分)`
        : "";
      return `${idx + 1}. [${item.status}] ${item.sourceTrack.title} - ${item.sourceTrack.artists.join(" / ")}${target}`;
    }),
  ];
  return {
    filename: `${safeBase}.md`,
    mimeType: "text/markdown; charset=utf-8",
    content: mdLines.join("\n"),
  };
}

export function formatCompareExport(
  result: CompareResult,
  format: ExportFormat,
  statuses?: readonly CompareStatus[],
): ExportPayload {
  const allowed = statuses && statuses.length > 0 ? new Set(statuses) : null;
  const items = allowed ? result.items.filter((item) => allowed.has(item.status)) : result.items;
  const safeBase = sanitizeDownloadFilename(
    `${result.left.playlistName}-vs-${result.right.playlistName}`,
    "playlist-compare",
  );

  if (format === "json") {
    return {
      filename: `${safeBase}.json`,
      mimeType: "application/json; charset=utf-8",
      content: JSON.stringify({ ...result, items }, null, 2),
    };
  }

  if (format === "csv") {
    const header = ["状态", "相似度", "左侧歌名", "左侧歌手", "右侧歌名", "右侧歌手", "说明"]
      .map(escapeCsvCell)
      .join(",");
    const rows = items.map((item) =>
      [
        item.status,
        item.score,
        item.left?.title ?? "",
        item.left?.artists.join(" / ") ?? "",
        item.right?.title ?? "",
        item.right?.artists.join(" / ") ?? "",
        item.reason ?? "",
      ]
        .map(escapeCsvCell)
        .join(","),
    );
    return {
      filename: `${safeBase}.csv`,
      mimeType: "text/csv; charset=utf-8",
      content: `\uFEFF${[header, ...rows].join("\r\n")}`,
    };
  }

  const lines = items.map((item, idx) => {
    const track = item.left ?? item.right;
    if (!track) return "";
    return `${idx + 1}. ${track.title}${track.artists.length ? ` - ${track.artists.join(" / ")}` : ""}`;
  });

  if (format === "text") {
    return {
      filename: `${safeBase}.txt`,
      mimeType: "text/plain; charset=utf-8",
      content: lines.filter(Boolean).join("\n"),
    };
  }

  return {
    filename: `${safeBase}.md`,
    mimeType: "text/markdown; charset=utf-8",
    content: [
      `# 歌单对比报告：${result.left.playlistName} vs ${result.right.playlistName}`,
      "",
      `- 完全一致：${result.summary.exact} | 同名异唱：${result.summary.sameTitleDifferentArtist} | 相似：${result.summary.similarTitle} | 仅左侧：${result.summary.leftOnly} | 仅右侧：${result.summary.rightOnly}`,
      "",
      ...items.map(
        (item, idx) =>
          `${idx + 1}. [${item.status}] ${item.left?.title ?? "(无)"} <-> ${item.right?.title ?? "(无)"}`,
      ),
    ].join("\n"),
  };
}

export function formatImportAuditExport(result: ImportAuditResult, format: ExportFormat): ExportPayload {
  const safeBase = sanitizeDownloadFilename(`${result.playlistName}-audit`, "import-audit");

  if (format === "json") {
    return {
      filename: `${safeBase}.json`,
      mimeType: "application/json; charset=utf-8",
      content: JSON.stringify(result, null, 2),
    };
  }

  if (format === "csv") {
    const header = ["歌名", "歌手", "专辑", "问题类型", "原因", "推荐替换"].map(escapeCsvCell).join(",");
    const rows = result.issues.map((issue) =>
      [
        issue.title,
        issue.artists.join(" / "),
        issue.album ?? "",
        issue.issueType,
        issue.reason,
        issue.replacements[0]
          ? `${issue.replacements[0].title} - ${issue.replacements[0].artists.join(" / ")}`
          : "",
      ]
        .map(escapeCsvCell)
        .join(","),
    );
    return {
      filename: `${safeBase}.csv`,
      mimeType: "text/csv; charset=utf-8",
      content: `\uFEFF${[header, ...rows].join("\r\n")}`,
    };
  }

  const lines = result.issues.map(
    (issue, idx) => `${idx + 1}. ${issue.title} - ${issue.artists.join(" / ")} (${issue.reason})`,
  );
  return {
    filename: `${safeBase}.${format === "markdown" ? "md" : "txt"}`,
    mimeType: format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    content: [
      `# 歌单可用性审计：${result.playlistName}`,
      `已扫描：${result.scannedCount} | 正常可播：${result.playableCount} | 异常：${result.issueCount}`,
      "",
      ...lines,
    ].join("\n"),
  };
}
