import type { PlaylistTransferJob, TransferExportFormat, TransferExportResult, TransferTrackResult } from "./types.js";

function artistsText(artists: string[]) {
  return artists.length > 0 ? artists.join(" / ") : "未知歌手";
}

function sourceTrackText(result: TransferTrackResult) {
  const album = result.sourceTrack.album ? ` - ${result.sourceTrack.album}` : "";
  return `${result.sourceTrack.title} - ${artistsText(result.sourceTrack.artists)}${album}`;
}

function selectedTrackText(result: TransferTrackResult) {
  if (!result.selectedCandidate) {
    return "";
  }

  const album = result.selectedCandidate.album ? ` - ${result.selectedCandidate.album}` : "";
  return `${result.selectedCandidate.title} - ${artistsText(result.selectedCandidate.artists)}${album}`;
}

function statusLabel(result: TransferTrackResult) {
  switch (result.status) {
    case "matched":
      return "已匹配";
    case "manual_review":
      return "待确认";
    case "not_found":
      return "未找到";
    case "copyright_unavailable":
      return "版权不可用";
    case "vip_only":
      return "会员限制";
    case "trial_only":
      return "仅试听片段";
    case "duplicate":
      return "重复";
    case "metadata_conflict":
      return "信息冲突";
    case "skipped":
      return "已跳过";
  }
}

function formatMarkdown(job: PlaylistTransferJob) {
  const matched = job.tracks.filter((track) => track.status === "matched");
  const review = job.tracks.filter((track) => track.status === "manual_review" || track.status === "metadata_conflict");
  const missing = job.tracks.filter((track) => track.status === "not_found");
  const unavailable = job.tracks.filter((track) => track.status === "copyright_unavailable" || track.status === "vip_only" || track.status === "trial_only");

  const lines = [
    `# ${job.playlistName} 歌单互转报告`,
    "",
    `来源：${job.sourceProvider}`,
    `目标：${job.targetProvider}`,
    `生成时间：${job.updatedAt}`,
    "",
    `总数：${job.summary.total}`,
    `已匹配：${job.summary.matched}`,
    `待确认：${job.summary.manualReview}`,
    `未找到：${job.summary.notFound}`,
    `版权 / 权限受限：${job.summary.unavailable}`,
    "",
    "## 已匹配",
    ...formatMarkdownList(matched, true),
    "",
    "## 待确认",
    ...formatMarkdownList(review, false),
    "",
    "## 未找到",
    ...formatMarkdownList(missing, false),
    "",
    "## 版权 / 权限受限",
    ...formatMarkdownList(unavailable, false)
  ];

  return `${lines.join("\n")}\n`;
}

function formatMarkdownList(items: TransferTrackResult[], includeTarget: boolean) {
  if (items.length === 0) {
    return ["无"];
  }

  return items.map((item, index) => {
    const target = includeTarget ? ` -> ${selectedTrackText(item)}` : "";
    const reason = item.reason ? `，原因：${item.reason}` : "";
    return `${index + 1}. ${sourceTrackText(item)}${target}${reason}`;
  });
}

function csvValue(value: string | number | undefined) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function formatCsv(job: PlaylistTransferJob) {
  const rows = [["source_title", "source_artists", "source_album", "status", "target_title", "target_artists", "confidence", "reason"]];

  for (const result of job.tracks) {
    rows.push([
      result.sourceTrack.title,
      artistsText(result.sourceTrack.artists),
      result.sourceTrack.album ?? "",
      statusLabel(result),
      result.selectedCandidate?.title ?? "",
      result.selectedCandidate ? artistsText(result.selectedCandidate.artists) : "",
      result.selectedCandidate?.confidenceScore ?? "",
      result.reason ?? ""
    ].map(String));
  }

  return `${rows.map((row) => row.map(csvValue).join(",")).join("\n")}\n`;
}

function formatText(job: PlaylistTransferJob) {
  return job.tracks.map((result, index) => `${index + 1}. ${sourceTrackText(result)} [${statusLabel(result)}]`).join("\n") + "\n";
}

export function formatTransferExport(job: PlaylistTransferJob, format: TransferExportFormat): TransferExportResult {
  if (format === "json") {
    return {
      filename: `${job.playlistName}-transfer-report.json`,
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(job, null, 2)
    };
  }

  if (format === "csv") {
    return {
      filename: `${job.playlistName}-transfer-report.csv`,
      contentType: "text/csv; charset=utf-8",
      content: formatCsv(job)
    };
  }

  if (format === "text") {
    return {
      filename: `${job.playlistName}-transfer-report.txt`,
      contentType: "text/plain; charset=utf-8",
      content: formatText(job)
    };
  }

  return {
    filename: `${job.playlistName}-transfer-report.md`,
    contentType: "text/markdown; charset=utf-8",
    content: formatMarkdown(job)
  };
}
