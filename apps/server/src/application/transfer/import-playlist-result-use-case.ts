import type { ImportAuditResult, MusicPlatform, TransferResult } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type { CreatePlaylistResult, ProviderRegistry } from "../../domain/ports/music-provider.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";

const PLAYLIST_URL_TEMPLATES: Record<MusicPlatform, string> = {
  netease: "https://music.163.com/#/playlist?id={id}",
  qq: "https://y.qq.com/n/ryqq/playlist/{id}",
};

export function buildProviderPlaylistUrl(platform: MusicPlatform, playlistId: string): string {
  const template = PLAYLIST_URL_TEMPLATES[platform];
  return template.replace("{id}", encodeURIComponent(playlistId));
}

async function importTracksIntoTargetPlaylist(params: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  actor: ActorContext;
  platform: MusicPlatform;
  trackIds: string[];
  existingPlaylistId?: string;
  newPlaylistName: string;
  appendPlaylistName: string;
}): Promise<CreatePlaylistResult & { skippedCount: number }> {
  const {
    providers,
    authResolver,
    actor,
    platform,
    trackIds,
    existingPlaylistId,
    newPlaylistName,
    appendPlaylistName,
  } = params;
  const adapter = providers.get(platform);
  const auth = authResolver.buildPersonalAuth(actor, platform);

  if (existingPlaylistId) {
    if (!adapter.addTracksToPlaylist) {
      throw new AppError(
        "FEATURE_UNSUPPORTED",
        `${platform === "qq" ? "QQ 音乐" : platform} 暂不支持向已有歌单追加曲目。`,
      );
    }
    const { addedCount } = await adapter.addTracksToPlaylist(existingPlaylistId, trackIds, auth);
    return {
      playlistId: existingPlaylistId,
      playlistName: appendPlaylistName,
      playlistUrl: buildProviderPlaylistUrl(platform, existingPlaylistId),
      addedCount,
      skippedCount: Math.max(0, trackIds.length - addedCount),
    };
  }

  if (!adapter.createPlaylistWithTracks) {
    throw new AppError("FEATURE_UNSUPPORTED", `${platform} 暂不支持直接建单导入。`);
  }
  const created = await adapter.createPlaylistWithTracks(newPlaylistName, trackIds, auth);
  return {
    ...created,
    skippedCount: Math.max(0, trackIds.length - created.addedCount),
  };
}

export async function importTransferResultToPlatformUseCase(deps: {
  providers: ProviderRegistry;
  authResolver: ProviderAuthResolver;
  jobs: BackgroundJobManager;
  actor: ActorContext;
  jobId: string;
  options: { name?: string; existingPlaylistId?: string };
}): Promise<CreatePlaylistResult & { skippedCount: number }> {
  const { providers, authResolver, jobs, actor, jobId, options } = deps;
  const record = jobs.getOwnedJob(actor, jobId);
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

    return importTracksIntoTargetPlaylist({
      providers,
      authResolver,
      actor,
      platform: data.targetProvider,
      trackIds,
      existingPlaylistId,
      newPlaylistName: options.name?.trim() || `${data.playlistName} 转换结果`,
      appendPlaylistName: options.name?.trim() || data.playlistName,
    });
  }

  if (record.kind === "import_audit") {
    const data = record.result as ImportAuditResult;
    if (data.playableTrackIds.length === 0) {
      throw new AppError("VALIDATION_ERROR", "没有正常可播歌曲可以创建新歌单。");
    }

    return importTracksIntoTargetPlaylist({
      providers,
      authResolver,
      actor,
      platform: "netease",
      trackIds: data.playableTrackIds,
      existingPlaylistId,
      newPlaylistName: options.name?.trim() || `${data.playlistName} - 正常歌曲`,
      appendPlaylistName: options.name?.trim() || data.playlistName,
    });
  }

  throw new AppError("VALIDATION_ERROR", "该任务类型不支持直接导入歌单。");
}
