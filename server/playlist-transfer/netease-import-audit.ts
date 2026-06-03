import type { MatchCandidate, ProviderTrack, TransferTrack } from "./types.js";

export type NeteaseRawPlaylistTrack = {
  id: number | string;
  name?: string;
  ar?: Array<{ name?: string }>;
  al?: { name?: string };
  dt?: number;
  st?: number;
  resourceState?: boolean;
  noCopyrightRcmd?: {
    type?: number;
    typeDesc?: string;
  } | null;
};

export type NeteaseRawPrivilege = {
  id?: number | string;
  st?: number;
  pl?: number;
  dl?: number;
  fee?: number;
};

export type NeteaseAuditSourceEntry = {
  track: NeteaseRawPlaylistTrack;
  privilege?: NeteaseRawPrivilege;
};

export type NeteaseImportAuditStatus = "replaceable" | "needs_review" | "unusable";

export type NeteaseImportAuditItem = {
  originalTrackId: string;
  sourceTrack: TransferTrack;
  unusableReason: string;
  status: NeteaseImportAuditStatus;
  candidates: MatchCandidate[];
  selectedCandidate?: MatchCandidate;
  reason?: string;
};

export type NeteaseImportedPlaylistAudit = {
  playlistId: string;
  playlistName: string;
  scannedCount: number;
  summary: {
    total: number;
    playable: number;
    suspect: number;
    replaceable: number;
    needsReview: number;
    unusable: number;
  };
  playableTrackIds: string[];
  playableTextPlaylist: string;
  items: NeteaseImportAuditItem[];
  textPlaylist: string;
  unusableText: string;
  markdownReport: string;
};

export type NeteaseImportAuditProgress = {
  scanned: number;
  total: number;
  suspect: number;
  replaceable: number;
  needsReview: number;
  unusable: number;
  currentTitle?: string;
};

type CandidateAvailabilityStatus = "copyright_unavailable" | "vip_only" | "trial_only";

type BuildNeteaseImportedPlaylistAuditInput = {
  playlistId: string;
  playlistName: string;
  tracks: NeteaseAuditSourceEntry[];
  candidateLimit?: number;
  searchCandidates: (track: TransferTrack) => Promise<ProviderTrack[]>;
  checkCandidateAvailability?: (candidate: MatchCandidate) => Promise<{ status: CandidateAvailabilityStatus; reason: string } | null>;
  onProgress?: (progress: NeteaseImportAuditProgress) => void;
  shouldCancel?: () => boolean;
};

function normalizeText(value: string | undefined) {
  return (value ?? "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\s·・._\-—:：'"]/g, "")
    .trim();
}

function normalizeArtists(artists: string[]) {
  return artists.map(normalizeText).filter(Boolean);
}

function hasArtistOverlap(sourceArtists: string[], targetArtists: string[]) {
  const normalizedSource = normalizeArtists(sourceArtists);
  const normalizedTarget = normalizeArtists(targetArtists);
  if (normalizedSource.length === 0 || normalizedTarget.length === 0) {
    return false;
  }

  return normalizedSource.some((sourceArtist) =>
    normalizedTarget.some((targetArtist) => sourceArtist === targetArtist || sourceArtist.includes(targetArtist) || targetArtist.includes(sourceArtist))
  );
}

function rawTrackToTransferTrack(track: NeteaseRawPlaylistTrack): TransferTrack {
  const title = track.name?.trim() || "未知歌曲";
  const artists = track.ar?.map((artist) => artist.name?.trim()).filter((name): name is string => Boolean(name)) ?? [];
  const durationSeconds = Number.isFinite(track.dt) && Number(track.dt) > 0 ? Math.round(Number(track.dt) / 1000) : undefined;

  return {
    source: "netease",
    sourceTrackId: String(track.id),
    title,
    artists,
    album: track.al?.name?.trim() || undefined,
    durationSeconds
  };
}

export function getNeteaseTrackUnusableReason(track: NeteaseRawPlaylistTrack, privilege?: NeteaseRawPrivilege) {
  const copyrightReason = track.noCopyrightRcmd?.typeDesc?.trim();
  if (copyrightReason) {
    return copyrightReason;
  }

  if (typeof privilege?.st === "number" && privilege.st < 0) {
    return "当前账号无播放权限";
  }

  if (typeof track.st === "number" && track.st < 0) {
    return "歌曲状态不可用";
  }

  if (privilege && (privilege.pl ?? 1) <= 0 && (privilege.dl ?? 1) <= 0) {
    return "当前账号无可播放音源";
  }

  if (track.resourceState === false) {
    return "资源暂不可用";
  }

  return null;
}

function scoreReplacementCandidate(sourceTrack: TransferTrack, candidate: ProviderTrack) {
  const sourceTitle = normalizeText(sourceTrack.title);
  const candidateTitle = normalizeText(candidate.title);
  const sourceAlbum = normalizeText(sourceTrack.album);
  const candidateAlbum = normalizeText(candidate.album);
  const reasons: string[] = [];
  let score = 0;

  if (sourceTitle && sourceTitle === candidateTitle) {
    score += 80;
    reasons.push("歌名完全一致");
  } else if (sourceTitle && candidateTitle && (sourceTitle.includes(candidateTitle) || candidateTitle.includes(sourceTitle))) {
    score += 45;
    reasons.push("歌名高度相似");
  }

  if (hasArtistOverlap(sourceTrack.artists, candidate.artists)) {
    score += 10;
    reasons.push("歌手匹配");
  } else if (sourceTitle === candidateTitle) {
    score += 5;
    reasons.push("同名不同歌手");
  }

  if (sourceAlbum && candidateAlbum && sourceAlbum === candidateAlbum) {
    score += 5;
    reasons.push("专辑一致");
  }

  if (
    Number.isFinite(sourceTrack.durationSeconds) &&
    Number.isFinite(candidate.durationSeconds) &&
    Math.abs(Number(sourceTrack.durationSeconds) - Number(candidate.durationSeconds)) <= 3
  ) {
    score += 5;
    reasons.push("时长接近");
  }

  return {
    score: Math.min(score, 100),
    reasons
  };
}

function toMatchCandidate(sourceTrack: TransferTrack, candidate: ProviderTrack): MatchCandidate {
  const scored = scoreReplacementCandidate(sourceTrack, candidate);

  return {
    provider: candidate.provider,
    targetTrackId: candidate.id,
    title: candidate.title,
    artists: candidate.artists,
    album: candidate.album,
    durationSeconds: candidate.durationSeconds,
    availability: candidate.availability,
    raw: candidate.raw,
    confidenceScore: scored.score,
    reasons: scored.reasons
  };
}

function formatTrackLine(track: TransferTrack | MatchCandidate) {
  const artists = track.artists.join(" / ") || "未知歌手";
  return `${track.title} - ${artists}`;
}

function hasAccompanimentMarker(title: string | undefined) {
  return /伴奏|instrumental|karaoke|纯音乐/i.test(title ?? "");
}

async function buildReplacementCandidates(input: {
  sourceTrack: TransferTrack;
  originalTrackId: string;
  providerCandidates: ProviderTrack[];
  candidateLimit: number;
  checkCandidateAvailability?: BuildNeteaseImportedPlaylistAuditInput["checkCandidateAvailability"];
}) {
  const seen = new Set<string>();
  const ranked = input.providerCandidates
    .filter((candidate) => candidate.provider === "netease" && candidate.id && candidate.id !== input.originalTrackId)
    .filter((candidate) => hasAccompanimentMarker(input.sourceTrack.title) || !hasAccompanimentMarker(candidate.title))
    .filter((candidate) => {
      if (seen.has(candidate.id)) {
        return false;
      }
      seen.add(candidate.id);
      return true;
    })
    .map((candidate) => toMatchCandidate(input.sourceTrack, candidate))
    .filter((candidate) => candidate.confidenceScore > 0)
    .sort((left, right) => right.confidenceScore - left.confidenceScore)
    .slice(0, input.candidateLimit);

  const checkedCandidates: MatchCandidate[] = [];
  for (const candidate of ranked) {
    let nextCandidate = candidate;
    if (input.checkCandidateAvailability) {
      const availability = await input.checkCandidateAvailability(candidate);
      if (availability) {
        nextCandidate = {
          ...candidate,
          availability: {
            status: availability.status,
            reason: availability.reason
          }
        };
      }
    }

    checkedCandidates.push(nextCandidate);
  }

  return checkedCandidates;
}

function pickAuditStatus(candidates: MatchCandidate[]) {
  const playableCandidates = candidates.filter((candidate) => !candidate.availability || candidate.availability.status === "available");
  const selectedCandidate = playableCandidates[0];

  if (selectedCandidate && selectedCandidate.confidenceScore >= 70) {
    return {
      status: "replaceable" as const,
      selectedCandidate
    };
  }

  if (selectedCandidate) {
    return {
      status: "needs_review" as const,
      selectedCandidate,
      reason: "存在相似候选，需要人工确认"
    };
  }

  return {
    status: "unusable" as const,
    selectedCandidate: undefined,
    reason: candidates.length > 0 ? "找到候选但都不可用或受限" : "未找到可替代版本"
  };
}

function formatMarkdownReport(audit: Omit<NeteaseImportedPlaylistAudit, "markdownReport">) {
  const replaceable = audit.items.filter((item) => item.status === "replaceable" && item.selectedCandidate);
  const needsReview = audit.items.filter((item) => item.status === "needs_review");
  const unusable = audit.items.filter((item) => item.status === "unusable");
  const lines = [
    `# ${audit.playlistName} 导入歌单清理报告`,
    "",
    `扫描 ${audit.scannedCount} 首，正常可播 ${audit.summary.playable} 首；识别 ${audit.summary.suspect} 首不可用，可替代 ${audit.summary.replaceable} 首，待确认 ${audit.summary.needsReview} 首，暂无替代 ${audit.summary.unusable} 首。`,
    "",
    "## 正常可播文字歌单",
    audit.playableTextPlaylist || "无",
    "",
    "## 可重新导入文字歌单",
    ...replaceable.map((item) => (item.selectedCandidate ? formatTrackLine(item.selectedCandidate) : "")).filter(Boolean),
    "",
    "## 仍需手动确认",
    ...needsReview.map((item) => {
      const candidate = item.selectedCandidate ? ` -> ${formatTrackLine(item.selectedCandidate)} (${item.selectedCandidate.confidenceScore} 分)` : "";
      return `${formatTrackLine(item.sourceTrack)} (${item.unusableReason})${candidate}`;
    }),
    "",
    "## 暂无可用替代",
    ...unusable.map((item) => `${formatTrackLine(item.sourceTrack)} (${item.unusableReason})`)
  ];

  return lines.join("\n").trim();
}

export async function buildNeteaseImportedPlaylistAudit(input: BuildNeteaseImportedPlaylistAuditInput): Promise<NeteaseImportedPlaylistAudit> {
  const candidateLimit = Math.min(10, Math.max(1, Math.trunc(input.candidateLimit ?? 5)));
  const items: NeteaseImportAuditItem[] = [];
  const playableTrackIds: string[] = [];
  const playableTextLines: string[] = [];
  const playableTrackIdSet = new Set<string>();
  let scanned = 0;

  function assertNotCancelled() {
    if (input.shouldCancel?.()) {
      throw new Error("扫描已取消");
    }
  }

  function reportProgress(currentTitle?: string) {
    input.onProgress?.({
      scanned,
      total: input.tracks.length,
      suspect: items.length,
      replaceable: items.filter((item) => item.status === "replaceable").length,
      needsReview: items.filter((item) => item.status === "needs_review").length,
      unusable: items.filter((item) => item.status === "unusable").length,
      currentTitle
    });
  }

  for (const entry of input.tracks) {
    assertNotCancelled();
    const unusableReason = getNeteaseTrackUnusableReason(entry.track, entry.privilege);
    if (!unusableReason) {
      const trackId = String(entry.track.id);
      if (trackId && !playableTrackIdSet.has(trackId)) {
        playableTrackIdSet.add(trackId);
        playableTrackIds.push(trackId);
        playableTextLines.push(formatTrackLine(rawTrackToTransferTrack(entry.track)));
      }
      scanned += 1;
      reportProgress(entry.track.name?.trim() || "未知歌曲");
      continue;
    }

    const sourceTrack = rawTrackToTransferTrack(entry.track);
    assertNotCancelled();
    const providerCandidates = await input.searchCandidates(sourceTrack);
    assertNotCancelled();
    const candidates = await buildReplacementCandidates({
      sourceTrack,
      originalTrackId: String(entry.track.id),
      providerCandidates,
      candidateLimit,
      checkCandidateAvailability: input.checkCandidateAvailability
    });
    assertNotCancelled();
    const status = pickAuditStatus(candidates);

    items.push({
      originalTrackId: String(entry.track.id),
      sourceTrack,
      unusableReason,
      status: status.status,
      candidates,
      selectedCandidate: status.selectedCandidate,
      reason: status.reason
    });
    scanned += 1;
    reportProgress(sourceTrack.title);
  }

  const summary = {
    total: input.tracks.length,
    playable: playableTrackIds.length,
    suspect: items.length,
    replaceable: items.filter((item) => item.status === "replaceable").length,
    needsReview: items.filter((item) => item.status === "needs_review").length,
    unusable: items.filter((item) => item.status === "unusable").length
  };
  const textPlaylist = items
    .filter((item) => item.status === "replaceable" && item.selectedCandidate)
    .map((item) => item.selectedCandidate ? formatTrackLine(item.selectedCandidate) : "")
    .filter(Boolean)
    .join("\n");
  const unusableText = items
    .filter((item) => item.status === "unusable")
    .map((item) => `${formatTrackLine(item.sourceTrack)}（${item.unusableReason}）`)
    .join("\n");
  const auditWithoutMarkdown = {
    playlistId: input.playlistId,
    playlistName: input.playlistName,
    scannedCount: input.tracks.length,
    summary,
    playableTrackIds,
    playableTextPlaylist: playableTextLines.join("\n"),
    items,
    textPlaylist,
    unusableText
  };

  return {
    ...auditWithoutMarkdown,
    markdownReport: formatMarkdownReport(auditWithoutMarkdown)
  };
}
