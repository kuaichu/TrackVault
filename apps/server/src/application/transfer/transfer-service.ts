import type {
  AuditIssueItem,
  CompareResult,
  CompareStatus,
  ExportFormat,
  ExportPayload,
  ImportAuditResult,
  JobView,
  MusicPlatform,
  Song,
  StartCompareInput,
  StartImportAuditInput,
  StartTransferInput,
  TransferAvailability,
  TransferResult,
  TransferTrack,
  TransferTrackResult,
  UpdateTransferSelectionInput,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError, isAppError } from "../../domain/errors.js";
import type {
  AudioResolveTarget,
  CreatePlaylistResult,
  MusicProviderAdapter,
  ProviderAuthContext,
  ProviderRegistry,
} from "../../domain/ports/music-provider.js";
import {
  type ProviderCandidateTrack,
  buildTransferDedupKey,
  comparePlaylistsAsync,
  matchTransferTrack,
  summarizeTransferResults,
} from "../../domain/transfer/matcher.js";
import {
  formatCompareExport,
  formatImportAuditExport,
  formatTransferExport,
  parseCsvPlaylistWithStats,
  parseTextPlaylistWithStats,
} from "../../domain/transfer/text-and-csv.js";
import type { CredentialRepository } from "../../infrastructure/db/repositories/credential-repository.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";

const MAX_TRANSFER_TRACKS = 1000;
const MAX_SELECTED_SCAN_TRACKS = 10_000;
const MAX_COMPARE_TRACKS = 1500;

function songToTransferTrack(song: Song): TransferTrack {
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
 * T04: Distinguishes "belongs to VIP catalog" (`status === "vip", locked === false` -> playable for VIP user)
 * from "locked for current account" (`locked === true` -> vip_only).
 */
function songToAvailability(song: Song): TransferAvailability {
  const playback = song.availability?.playback;
  if (!playback) return "playable";
  if (playback.status === "copyright") return "copyright_unavailable";
  if (playback.locked) {
    if (playback.status === "vip" || playback.status === "paid_album" || playback.status === "restricted") {
      return "vip_only";
    }
    return "copyright_unavailable";
  }
  return "playable";
}

function songToCandidate(song: Song): ProviderCandidateTrack {
  return {
    provider: song.platform,
    id: song.id,
    mediaId: song.mediaId,
    title: song.title,
    artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
    album: song.album,
    durationSeconds: song.durationSeconds,
    availability: songToAvailability(song),
  };
}

interface LoadedSourceBundle {
  tracks: TransferTrack[];
  sourceTotal: number;
  truncated: boolean;
  sourceMetaByKey: Map<string, { availability: TransferAvailability; mediaId?: string }>;
}

interface LoadedProviderPlaylist {
  songs: Song[];
  sourceTotal: number;
  truncated: boolean;
}

function buildTransferSubtitle(
  summary: TransferResult["summary"],
  sourceTotal?: number,
  truncated?: boolean,
): string {
  const base = `共 ${summary.total} 首 · 匹配 ${summary.matched} · 待确认 ${summary.manualReview}`;
  if (truncated && sourceTotal && sourceTotal > summary.total) {
    return `${base}（已截取前 ${summary.total}/${sourceTotal} 首）`;
  }
  return base;
}

export class TransferService {
  readonly #providers: ProviderRegistry;
  readonly #credentials: CredentialRepository;
  readonly #jobs: BackgroundJobManager;

  constructor(deps: {
    providers: ProviderRegistry;
    credentials: CredentialRepository;
    jobs: BackgroundJobManager;
  }) {
    this.#providers = deps.providers;
    this.#credentials = deps.credentials;
    this.#jobs = deps.jobs;
  }

  #buildAuth(actor: ActorContext, platform: MusicPlatform, signal?: AbortSignal): ProviderAuthContext {
    const binding =
      typeof this.#credentials.getBindingView === "function"
        ? this.#credentials.getBindingView(actor.userId, platform)
        : null;
    return {
      platform,
      cookie: this.#credentials.getDecryptedCookie(actor.userId, platform),
      scopeKey: actor.userId,
      accountUid: binding?.accountUid ?? null,
      signal,
    };
  }

  /**
   * C015: Read-only public candidate search/probe auth context for transfer/audit matching.
   * NEVER used for reading private user playlists or creating/modifying playlists.
   */
  #buildPublicSearchAuth(
    actor: ActorContext,
    platform: MusicPlatform,
    signal?: AbortSignal,
  ): ProviderAuthContext {
    const personal = this.#buildAuth(actor, platform, signal);
    if (personal.cookie) return personal;
    if (actor.trustedFallback && typeof this.#credentials.getDecryptedSystemFallbackCookie === "function") {
      const fallbackCookie = this.#credentials.getDecryptedSystemFallbackCookie(platform);
      if (fallbackCookie) {
        return {
          platform,
          cookie: fallbackCookie,
          scopeKey: "system-fallback",
          accountUid: null,
          signal,
        };
      }
    }
    return personal;
  }

  async #fetchProviderPlaylistBounded(
    adapter: MusicProviderAdapter,
    playlistId: string,
    auth: ProviderAuthContext,
    cap: number,
  ): Promise<LoadedProviderPlaylist> {
    // Request cap + 1 so truncation is detected even when mocks only implement getAllPlaylistTracks
    const fetched = await adapter.getAllPlaylistTracks(playlistId, auth, cap + 1);
    const songs = fetched.slice(0, cap);
    let sourceTotal = fetched.length;

    if (typeof adapter.getPlaylistTracks === "function") {
      try {
        const page = await adapter.getPlaylistTracks(playlistId, { page: 1, limit: 1 }, auth);
        if (typeof page.total === "number" && Number.isFinite(page.total)) {
          sourceTotal = Math.max(sourceTotal, page.total);
        }
      } catch {
        // Non-fatal: keep fetched count
      }
    }

    return {
      songs,
      sourceTotal,
      truncated: sourceTotal > songs.length,
    };
  }

  /**
   * T09: Actively probes real stream availability via adapter.resolveAudio when checkAvailability === true.
   * Returns null when probing is unsupported or fails due to transient/auth errors so metadata fallback holds.
   */
  async #probeTrackAvailability(
    adapter: MusicProviderAdapter,
    target: AudioResolveTarget,
    auth: ProviderAuthContext,
  ): Promise<TransferAvailability | null> {
    if (typeof adapter.resolveAudio !== "function") return null;
    try {
      const resolved = await adapter.resolveAudio(target, "standard", "playback", auth);
      if (typeof resolved.url === "string" && resolved.url.trim().length === 0) {
        return "copyright_unavailable";
      }
      return resolved.trial ? "trial_only" : "playable";
    } catch (error) {
      if (isAppError(error)) {
        if (error.code === "COPYRIGHT_UNAVAILABLE") return "copyright_unavailable";
        if (error.code === "TRIAL_ONLY") return "trial_only";
        if (error.code === "VIP_REQUIRED") return "vip_only";
      }
      return null;
    }
  }

  async #matchWithOptionalProbe(
    track: TransferTrack,
    candidates: ProviderCandidateTrack[],
    targetAdapter: MusicProviderAdapter,
    targetAuth: ProviderAuthContext,
    checkAvailability: boolean,
  ): Promise<TransferTrackResult> {
    const working = candidates.map((c) => ({ ...c }));
    let matched = matchTransferTrack(track, working);

    if (!checkAvailability || typeof targetAdapter.resolveAudio !== "function") {
      return matched;
    }

    const probedIds = new Set<string>();
    const probeCandidateById = async (targetId: string): Promise<boolean> => {
      if (probedIds.has(targetId)) return false;
      probedIds.add(targetId);
      const candidate = working.find((c) => c.id === targetId);
      if (!candidate) return false;
      const probed = await this.#probeTrackAvailability(
        targetAdapter,
        {
          id: candidate.id,
          mediaId: candidate.mediaId,
          title: candidate.title,
          durationSeconds: candidate.durationSeconds,
        },
        targetAuth,
      );
      if (probed && probed !== candidate.availability) {
        candidate.availability = probed;
        return true;
      }
      return false;
    };

    // 1. Verify statically playable selected candidates (downgrade if actually trial/unavailable)
    while (matched.status === "matched" && matched.selectedCandidate) {
      const targetId = matched.selectedCandidate.targetTrackId;
      if (probedIds.has(targetId)) break;
      const changed = await probeCandidateById(targetId);
      if (!changed) break;
      matched = matchTransferTrack(track, working);
      if (matched.status === "matched" && matched.selectedCandidate?.targetTrackId === targetId) {
        break;
      }
    }

    // 2. T09: Also probe high-confidence (>= 85) statically locked/unavailable candidates when checkAvailability === true
    if (matched.status !== "matched" && matched.selectedCandidate) {
      const highConfidenceIds = matched.candidates
        .filter((c) => c.confidenceScore >= 85)
        .map((c) => c.targetTrackId);
      for (const targetId of highConfidenceIds) {
        const changed = await probeCandidateById(targetId);
        if (changed) {
          matched = matchTransferTrack(track, working);
          if (matched.status === "matched") {
            break;
          }
        }
      }
    }

    return matched;
  }

  async #loadSourceTracks(
    actor: ActorContext,
    input: StartTransferInput,
    signal?: AbortSignal,
  ): Promise<LoadedSourceBundle> {
    const sourceMetaByKey = new Map<string, { availability: TransferAvailability; mediaId?: string }>();
    const requestedIds = input.selectedSourceTrackIds
      ? [...new Set(input.selectedSourceTrackIds.map((id) => id.trim()).filter(Boolean))]
      : [];
    const selectedSet = requestedIds.length > 0 ? new Set(requestedIds) : null;

    if (input.sourceTracks && input.sourceTracks.length > 0) {
      if (selectedSet) {
        const seen = new Set<string>();
        const filtered: TransferTrack[] = [];
        for (const item of input.sourceTracks) {
          const tid = item.sourceTrackId?.trim();
          if (tid && selectedSet.has(tid) && !seen.has(tid) && filtered.length < MAX_TRANSFER_TRACKS) {
            seen.add(tid);
            filtered.push(item);
          }
        }
        return {
          tracks: filtered,
          sourceTotal: selectedSet.size,
          truncated: filtered.length < selectedSet.size,
          sourceMetaByKey,
        };
      }
      const sourceTotal = input.sourceTracks.length;
      const tracks = input.sourceTracks.slice(0, MAX_TRANSFER_TRACKS);
      return { tracks, sourceTotal, truncated: sourceTotal > tracks.length, sourceMetaByKey };
    }

    if (input.sourceProvider === "text") {
      const parsed = parseTextPlaylistWithStats(input.rawText ?? "", MAX_TRANSFER_TRACKS);
      return { ...parsed, sourceMetaByKey };
    }
    if (input.sourceProvider === "csv") {
      const parsed = parseCsvPlaylistWithStats(input.rawText ?? "", MAX_TRANSFER_TRACKS);
      return { ...parsed, sourceMetaByKey };
    }

    if (!input.playlistId) {
      throw new AppError("VALIDATION_ERROR", "请提供源歌单 ID。");
    }

    const sourceAdapter = this.#providers.get(input.sourceProvider);
    const sourceAuth = this.#buildAuth(actor, input.sourceProvider, signal);
    const loaded = await this.#fetchProviderPlaylistBounded(
      sourceAdapter,
      input.playlistId,
      sourceAuth,
      MAX_TRANSFER_TRACKS,
    );

    if (selectedSet) {
      // T11: Reconcile against the deduplicated requested selection set; scan further when >1,000 playlist had selected tracks past index 999
      const collectSelected = (songs: readonly Song[]): Song[] => {
        const seen = new Set<string>();
        const picked: Song[] = [];
        for (const song of songs) {
          if (selectedSet.has(song.id) && !seen.has(song.id) && picked.length < MAX_TRANSFER_TRACKS) {
            seen.add(song.id);
            picked.push(song);
          }
        }
        return picked;
      };

      let filteredSongs = collectSelected(loaded.songs);
      const targetCollectCount = Math.min(selectedSet.size, MAX_TRANSFER_TRACKS);
      if (filteredSongs.length < targetCollectCount && loaded.truncated) {
        const deepScanned = await sourceAdapter.getAllPlaylistTracks(
          input.playlistId,
          sourceAuth,
          MAX_SELECTED_SCAN_TRACKS,
        );
        filteredSongs = collectSelected(deepScanned);
      }

      for (const song of filteredSongs) {
        sourceMetaByKey.set(`${song.platform}:${song.id}`, {
          availability: songToAvailability(song),
          mediaId: song.mediaId,
        });
      }

      return {
        tracks: filteredSongs.map(songToTransferTrack),
        sourceTotal: selectedSet.size,
        truncated: filteredSongs.length < selectedSet.size,
        sourceMetaByKey,
      };
    }

    for (const song of loaded.songs) {
      sourceMetaByKey.set(`${song.platform}:${song.id}`, {
        availability: songToAvailability(song),
        mediaId: song.mediaId,
      });
    }

    return {
      tracks: loaded.songs.map(songToTransferTrack),
      sourceTotal: loaded.sourceTotal,
      truncated: loaded.truncated,
      sourceMetaByKey,
    };
  }

  startTransferJob(actor: ActorContext, input: StartTransferInput): JobView {
    const playlistName = input.playlistName?.trim() || "歌单互转任务";

    return this.#jobs.enqueue({
      actor,
      kind: "transfer",
      title: playlistName,
      subtitle: `${input.sourceProvider} → ${input.targetProvider}`,
      maxUserConcurrency: 2,
      runner: async (handle) => {
        handle.updateProgress(5, "加载源曲目列表...");
        const {
          tracks: sourceTracks,
          sourceTotal,
          truncated,
          sourceMetaByKey,
        } = await this.#loadSourceTracks(actor, input, handle.signal);

        if (sourceTracks.length === 0) {
          throw new AppError("VALIDATION_ERROR", "源歌单或文本中没有解析到有效歌曲。");
        }

        const targetAdapter = this.#providers.get(input.targetProvider);
        const targetAuth = this.#buildPublicSearchAuth(actor, input.targetProvider, handle.signal);
        const seenKeys = new Set<string>();
        const results: TransferTrackResult[] = [];
        const shouldProbe = Boolean(input.checkAvailability);

        for (let i = 0; i < sourceTracks.length; i += 1) {
          if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "任务已取消。");
          const track = sourceTracks[i];
          if (!track) continue;

          // T03: Dedup by platform track ID first; preserve version tags when ID is absent
          const dedupKey = buildTransferDedupKey(track);
          if (seenKeys.has(dedupKey)) {
            results.push({
              sourceTrack: track,
              status: "duplicate",
              candidates: [],
              reason: "重复曲目已跳过",
            });
            continue;
          }
          seenKeys.add(dedupKey);

          // T05: Same-platform shortcut preserves true source availability instead of hardcoding "playable"
          if (track.source === input.targetProvider && track.sourceTrackId) {
            const sourceMeta = sourceMetaByKey.get(`${track.source}:${track.sourceTrackId}`);
            const candidate: ProviderCandidateTrack = {
              provider: input.targetProvider,
              id: track.sourceTrackId,
              mediaId: sourceMeta?.mediaId,
              title: track.title,
              artists: track.artists,
              album: track.album,
              durationSeconds: track.durationSeconds,
              availability: sourceMeta?.availability ?? "playable",
            };
            results.push(
              await this.#matchWithOptionalProbe(track, [candidate], targetAdapter, targetAuth, shouldProbe),
            );
          } else {
            const searchQuery = `${track.title} ${track.artists[0] ?? ""}`.trim();
            try {
              const found = await targetAdapter.searchTracks(searchQuery, targetAuth, 8);
              results.push(
                await this.#matchWithOptionalProbe(
                  track,
                  found.map(songToCandidate),
                  targetAdapter,
                  targetAuth,
                  shouldProbe,
                ),
              );
            } catch (error) {
              // Single track network failure must NOT abort the entire batch
              results.push({
                sourceTrack: track,
                status: "not_found",
                candidates: [],
                reason: error instanceof Error ? `搜索失败：${error.message}` : "搜索请求异常",
              });
            }
          }

          const pct = Math.min(96, Math.round(((i + 1) / sourceTracks.length) * 90) + 5);
          handle.updateProgress(pct, `已匹配 ${i + 1}/${sourceTracks.length} 首`);
        }

        const summary = summarizeTransferResults(results);
        const processedCount = results.length;
        const unprocessedCount = Math.max(0, sourceTotal - processedCount);
        const result: TransferResult = {
          sourceProvider: input.sourceProvider,
          targetProvider: input.targetProvider,
          playlistName,
          summary,
          results,
          sourceTotal,
          processedCount,
          unprocessedCount,
          truncated,
        };

        return {
          result,
          subtitle: buildTransferSubtitle(summary, sourceTotal, truncated),
        };
      },
    });
  }

  /**
   * F15: Persists user manual review selection (choose candidate / skip / reset),
   * recalculates summary statistics, and broadcasts `job_updated` via SSE.
   */
  updateTransferTrackSelection(
    actor: ActorContext,
    jobId: string,
    input: UpdateTransferSelectionInput,
  ): JobView {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.kind !== "transfer") {
      throw new AppError("VALIDATION_ERROR", "仅跨平台互转任务支持人工确认曲目。");
    }
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，无法更新曲目确认状态。");
    }

    const data = record.result as TransferResult;
    const item = data.results[input.index];
    if (!item) {
      throw new AppError("VALIDATION_ERROR", "目标曲目序号超出范围。");
    }

    let updatedItem: TransferTrackResult;
    if (input.action === "select") {
      if (!input.targetTrackId) {
        throw new AppError("VALIDATION_ERROR", "请选择要确认的候选曲目。");
      }
      const chosen = item.candidates.find((c) => c.targetTrackId === input.targetTrackId);
      if (!chosen) {
        throw new AppError("VALIDATION_ERROR", "所选候选曲目不存在于该条目的候选列表中。");
      }
      updatedItem = {
        ...item,
        status: "matched",
        selectedCandidate: chosen,
        reason: "已人工确认",
      };
    } else if (input.action === "skip") {
      updatedItem = {
        ...item,
        status: "skipped",
        selectedCandidate: undefined,
        reason: "已人工跳过",
      };
    } else {
      updatedItem = {
        ...item,
        status: item.candidates.length > 0 ? "manual_review" : "not_found",
        selectedCandidate: undefined,
        reason: item.candidates.length > 0 ? "存在相似候选，建议人工确认" : "目标平台未找到匹配候选",
      };
    }

    const nextResults = data.results.map((entry, idx) => (idx === input.index ? updatedItem : entry));
    const nextSummary = summarizeTransferResults(nextResults);
    const nextResult: TransferResult = {
      ...data,
      summary: nextSummary,
      results: nextResults,
    };

    return this.#jobs.updateOwnedJobResult(actor, jobId, {
      result: nextResult,
      subtitle: buildTransferSubtitle(nextSummary, nextResult.sourceTotal, nextResult.truncated),
    });
  }

  startImportAuditJob(actor: ActorContext, input: StartImportAuditInput): JobView {
    const playlistName = input.playlistName?.trim() || `网易云歌单 ${input.playlistId}`;

    return this.#jobs.enqueue({
      actor,
      kind: "import_audit",
      title: `可用性审计 · ${playlistName}`,
      subtitle: "准备扫描...",
      maxUserConcurrency: 1,
      runner: async (handle) => {
        const netease = this.#providers.get("netease");
        const auth = this.#buildAuth(actor, "netease", handle.signal);
        const searchAuth = this.#buildPublicSearchAuth(actor, "netease", handle.signal);

        handle.updateProgress(5, "拉取歌单曲目...");
        const loaded = await this.#fetchProviderPlaylistBounded(
          netease,
          input.playlistId,
          auth,
          input.maxTracks,
        );
        const songs = loaded.songs;
        if (songs.length === 0) {
          throw new AppError("VALIDATION_ERROR", "该歌单没有可扫描的曲目。");
        }

        const playableTrackIds: string[] = [];
        const issues: AuditIssueItem[] = [];
        const shouldProbe = Boolean(input.checkAvailability);

        for (let i = 0; i < songs.length; i += 1) {
          if (handle.signal.aborted) throw new AppError("INTERNAL_ERROR", "审计任务已取消。");
          const song = songs[i];
          if (!song) continue;

          const status = song.availability?.playback.status ?? "available";
          const locked = Boolean(song.availability?.playback.locked);

          // T04: VIP tracks with `locked === false` are playable for the current VIP account
          let staticIssueType: AuditIssueItem["issueType"] | null = null;
          let reason = song.availability?.playback.reason ?? "曲目当前不可直接完整播放";

          if (status === "copyright") {
            staticIssueType = "copyright_unavailable";
          } else if (locked) {
            // B27: Preserve distinct paid_album / restricted categories instead of collapsing all to vip_only
            if (status === "paid_album") staticIssueType = "paid_album";
            else if (status === "restricted") staticIssueType = "restricted";
            else staticIssueType = "vip_only";
          }

          let issueType: AuditIssueItem["issueType"] | null = staticIssueType;

          // T09: When checkAvailability is explicitly enabled, probe real audio stream even for statically locked songs
          if (shouldProbe) {
            const probed = await this.#probeTrackAvailability(
              netease,
              {
                id: song.id,
                mediaId: song.mediaId,
                title: song.title,
                durationSeconds: song.durationSeconds,
              },
              searchAuth,
            );
            if (probed === "playable") {
              issueType = null;
            } else if (probed === "trial_only") {
              issueType = "trial_only";
              reason = "实测音源仅提供试听片段";
            } else if (probed === "copyright_unavailable") {
              issueType = "copyright_unavailable";
              reason = "实测音源无可用版权";
            } else if (probed === "vip_only") {
              issueType =
                staticIssueType === "paid_album" || staticIssueType === "restricted"
                  ? staticIssueType
                  : "vip_only";
              if (!staticIssueType) {
                reason = "实测音源需要会员权限";
              }
            }
          }

          if (!issueType) {
            playableTrackIds.push(song.id);
          } else {
            let replacements: AuditIssueItem["replacements"] = [];
            try {
              const found = await netease.searchTracks(
                `${song.title} ${song.artist}`,
                searchAuth,
                input.candidateLimit + 2,
              );
              const matched = matchTransferTrack(
                songToTransferTrack(song),
                found.filter((f) => f.id !== song.id).map(songToCandidate),
              );
              replacements = matched.candidates.slice(0, input.candidateLimit);
            } catch {
              replacements = [];
            }

            issues.push({
              trackId: song.id,
              title: song.title,
              artists: song.artists?.length ? song.artists.map((a) => a.name) : [song.artist],
              album: song.album,
              issueType,
              reason,
              replacements,
            });
          }

          handle.updateProgress(
            Math.min(96, Math.round(((i + 1) / songs.length) * 90) + 5),
            `已扫描 ${i + 1}/${songs.length} 首`,
          );
        }

        const unprocessedCount = Math.max(0, loaded.sourceTotal - songs.length);
        const result: ImportAuditResult = {
          playlistId: input.playlistId,
          playlistName,
          scannedCount: songs.length,
          playableCount: playableTrackIds.length,
          issueCount: issues.length,
          playableTrackIds,
          issues,
          sourceTotal: loaded.sourceTotal,
          unprocessedCount,
          truncated: loaded.truncated,
        };

        const truncNote = loaded.truncated
          ? `（源歌单共 ${loaded.sourceTotal} 首，已截取前 ${songs.length} 首）`
          : "";
        return {
          result,
          subtitle: `扫描 ${result.scannedCount} 首 · 正常 ${result.playableCount} · 异常 ${result.issueCount}${truncNote}`,
        };
      },
    });
  }

  startCompareJob(actor: ActorContext, input: StartCompareInput): JobView {
    const leftName = input.leftPlaylistName?.trim() || `${input.leftProvider} 歌单 ${input.leftPlaylistId}`;
    const rightName =
      input.rightPlaylistName?.trim() || `${input.rightProvider} 歌单 ${input.rightPlaylistId}`;

    return this.#jobs.enqueue({
      actor,
      kind: "compare",
      title: `对比 · ${leftName} vs ${rightName}`,
      subtitle: "加载两侧歌单...",
      maxUserConcurrency: 2,
      runner: async (handle) => {
        const [leftLoaded, rightLoaded] = await Promise.all([
          this.#fetchProviderPlaylistBounded(
            this.#providers.get(input.leftProvider),
            input.leftPlaylistId,
            this.#buildAuth(actor, input.leftProvider, handle.signal),
            MAX_COMPARE_TRACKS,
          ),
          this.#fetchProviderPlaylistBounded(
            this.#providers.get(input.rightProvider),
            input.rightPlaylistId,
            this.#buildAuth(actor, input.rightProvider, handle.signal),
            MAX_COMPARE_TRACKS,
          ),
        ]);

        handle.updateProgress(25, "比对曲目...");
        const result = await comparePlaylistsAsync({
          left: {
            provider: input.leftProvider,
            playlistId: input.leftPlaylistId,
            playlistName: leftName,
            tracks: leftLoaded.songs.map(songToTransferTrack),
            sourceTotal: leftLoaded.sourceTotal,
            unprocessedCount: Math.max(0, leftLoaded.sourceTotal - leftLoaded.songs.length),
            truncated: leftLoaded.truncated,
          },
          right: {
            provider: input.rightProvider,
            playlistId: input.rightPlaylistId,
            playlistName: rightName,
            tracks: rightLoaded.songs.map(songToTransferTrack),
            sourceTotal: rightLoaded.sourceTotal,
            unprocessedCount: Math.max(0, rightLoaded.sourceTotal - rightLoaded.songs.length),
            truncated: rightLoaded.truncated,
          },
          signal: handle.signal,
          onProgress: (pct) => handle.updateProgress(Math.round(25 + pct * 0.72), `比对进度 ${pct}%`),
        });

        const truncSuffix =
          leftLoaded.truncated || rightLoaded.truncated ? "（部分超长歌单已截取前 1500 首）" : "";
        return {
          result,
          subtitle: `一致 ${result.summary.exact} · 仅左 ${result.summary.leftOnly} · 仅右 ${result.summary.rightOnly}${truncSuffix}`,
        };
      },
    });
  }

  exportJob(
    actor: ActorContext,
    jobId: string,
    format: ExportFormat,
    statuses?: readonly CompareStatus[],
  ): ExportPayload {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，无法导出。");
    }

    if (record.kind === "transfer") {
      return formatTransferExport(record.result as TransferResult, format);
    }
    if (record.kind === "compare") {
      return formatCompareExport(record.result as CompareResult, format, statuses);
    }
    if (record.kind === "import_audit") {
      return formatImportAuditExport(record.result as ImportAuditResult, format);
    }

    throw new AppError("VALIDATION_ERROR", "该任务类型不支持文本导出。");
  }

  async importTransferResultToPlatform(
    actor: ActorContext,
    jobId: string,
    options: { name?: string; existingPlaylistId?: string },
  ): Promise<CreatePlaylistResult & { skippedCount: number }> {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，不能导入歌单。");
    }

    const existingPlaylistId = options.existingPlaylistId?.trim();

    if (record.kind === "transfer") {
      const data = record.result as TransferResult;
      const trackIds = data.results
        .filter((r) => r.status === "matched" && r.selectedCandidate?.targetTrackId)
        .map((r) => r.selectedCandidate?.targetTrackId ?? "")
        .filter(Boolean);

      if (trackIds.length === 0) {
        throw new AppError("VALIDATION_ERROR", "没有已匹配的歌曲可供导入。");
      }

      const adapter = this.#providers.get(data.targetProvider);
      const auth = this.#buildAuth(actor, data.targetProvider);

      // T10: When caller explicitly specifies existingPlaylistId, NEVER silently fall through to creating a new playlist
      if (existingPlaylistId) {
        if (!adapter.addTracksToPlaylist) {
          throw new AppError(
            "FEATURE_UNSUPPORTED",
            `${data.targetProvider === "qq" ? "QQ 音乐" : data.targetProvider} 暂不支持向已有歌单追加曲目。`,
          );
        }
        const { addedCount } = await adapter.addTracksToPlaylist(existingPlaylistId, trackIds, auth);
        return {
          playlistId: existingPlaylistId,
          playlistName: options.name?.trim() || data.playlistName,
          playlistUrl:
            data.targetProvider === "netease"
              ? `https://music.163.com/#/playlist?id=${encodeURIComponent(existingPlaylistId)}`
              : `https://y.qq.com/n/ryqq/playlist/${encodeURIComponent(existingPlaylistId)}`,
          addedCount,
          // B28: Count skipped among attempted matched tracks rather than mixing matched/total denominators
          skippedCount: Math.max(0, trackIds.length - addedCount),
        };
      }

      if (!adapter.createPlaylistWithTracks) {
        throw new AppError("FEATURE_UNSUPPORTED", `${data.targetProvider} 暂不支持直接建单导入。`);
      }
      const created = await adapter.createPlaylistWithTracks(
        options.name?.trim() || `${data.playlistName} 转换结果`,
        trackIds,
        auth,
      );
      return { ...created, skippedCount: Math.max(0, trackIds.length - created.addedCount) };
    }

    if (record.kind === "import_audit") {
      const data = record.result as ImportAuditResult;
      if (data.playableTrackIds.length === 0) {
        throw new AppError("VALIDATION_ERROR", "没有正常可播歌曲可以创建新歌单。");
      }
      const adapter = this.#providers.get("netease");
      const auth = this.#buildAuth(actor, "netease");

      // T10: Support existingPlaylistId for import_audit too (explicitly reject if unsupported)
      if (existingPlaylistId) {
        if (!adapter.addTracksToPlaylist) {
          throw new AppError("FEATURE_UNSUPPORTED", "暂不支持向已有网易云歌单追加曲目。");
        }
        const { addedCount } = await adapter.addTracksToPlaylist(
          existingPlaylistId,
          data.playableTrackIds,
          auth,
        );
        return {
          playlistId: existingPlaylistId,
          playlistName: options.name?.trim() || data.playlistName,
          playlistUrl: `https://music.163.com/#/playlist?id=${encodeURIComponent(existingPlaylistId)}`,
          addedCount,
          skippedCount: Math.max(0, data.playableTrackIds.length - addedCount),
        };
      }

      if (!adapter.createPlaylistWithTracks) {
        throw new AppError("FEATURE_UNSUPPORTED", "暂不支持网易云建单。");
      }
      const created = await adapter.createPlaylistWithTracks(
        options.name?.trim() || `${data.playlistName} - 正常歌曲`,
        data.playableTrackIds,
        auth,
      );
      return { ...created, skippedCount: Math.max(0, data.playableTrackIds.length - created.addedCount) };
    }

    throw new AppError("VALIDATION_ERROR", "该任务类型不支持直接导入歌单。");
  }
}
