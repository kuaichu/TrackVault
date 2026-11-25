import { type Song, getSongKey } from "#shared";
import { isSongPlayable } from "../../../entities/song/index.js";
import { toast } from "../../../shared/store/toast-store.js";
import { usePlayerStore } from "../store/player-store.js";

export interface CloudPlayAllParams {
  initialSongs: readonly Song[];
  hasNextPage: boolean;
  isFetchNextPageError?: boolean;
  fetchNextPage: () => Promise<{
    songs: Song[];
    hasNextPage: boolean;
    isError: boolean;
    error?: unknown;
  }>;
  maxPages?: number;
}

export interface CloudPlayAllHost {
  getSessionEpoch(): number;
  getPlaybackSessionId(): number;
  getPlayToken(): number;
  isCurrentRun(runId: number): boolean;
  replaceQueueSilently(queue: Song[]): void;
  playTrack(song: Song, options?: { queue?: Song[] }): Promise<void>;
}

/**
 * Paginated "Play All" coordinator for Cloud tracks that survives `/cloud` route unmounts
 * and yields automatically when the user changes playback or queue (`playbackSessionId`).
 */
export async function executeCloudPlayAll(
  params: CloudPlayAllParams,
  runId: number,
  host: CloudPlayAllHost,
): Promise<void> {
  const store = usePlayerStore.getState();
  if (store.cloudPlayAllLoading || params.initialSongs.length === 0) return;

  if (!params.hasNextPage && !params.isFetchNextPageError) {
    const first = params.initialSongs.find((s) => isSongPlayable(s));
    if (!first) {
      toast.info("当前云盘歌曲均不可直接播放");
      return;
    }
    await host.playTrack(first, { queue: [...params.initialSongs] });
    toast.info(`已将全部 ${params.initialSongs.length} 首云盘歌曲加入播放队列`);
    return;
  }

  const startEpoch = host.getSessionEpoch();
  const startSessionId = host.getPlaybackSessionId();
  const startPlayToken = host.getPlayToken();
  const maxPages = params.maxPages ?? 30;
  const hasSessionChanged = () =>
    host.getSessionEpoch() !== startEpoch || host.getPlaybackSessionId() !== startSessionId;

  store.setStatePatch({ cloudPlayAllLoading: true });
  try {
    let latestSongs = [...params.initialSongs];
    let canFetchMore = Boolean(params.hasNextPage || params.isFetchNextPageError);
    let fetchedCount = 0;

    while (canFetchMore && fetchedCount < maxPages) {
      if (hasSessionChanged() || !host.isCurrentRun(runId)) return;
      fetchedCount += 1;
      const nextRes = await params.fetchNextPage();
      if (nextRes.songs.length > 0) {
        latestSongs = nextRes.songs;
      }
      if (hasSessionChanged() || !host.isCurrentRun(runId)) return;
      if (nextRes.isError) {
        const errMsg = nextRes.error instanceof Error ? nextRes.error.message : "后续分页请求失败";
        toast.error(`云盘后续分页加载失败（当前已加载 ${latestSongs.length} 首）：${errMsg}，请重试`);
        return;
      }
      canFetchMore = Boolean(nextRes.hasNextPage);
    }

    if (hasSessionChanged() || !host.isCurrentRun(runId)) return;

    const first = latestSongs.find((s) => isSongPlayable(s));
    if (!first) {
      toast.info("当前云盘歌曲均不可直接播放");
      return;
    }

    const currentState = usePlayerStore.getState();
    const activeTrack = currentState.currentTrack;
    if (
      host.getPlayToken() !== startPlayToken &&
      activeTrack &&
      !currentState.fmMode &&
      latestSongs.some((s) => getSongKey(s) === getSongKey(activeTrack))
    ) {
      host.replaceQueueSilently(latestSongs);
    } else {
      await host.playTrack(first, { queue: latestSongs });
    }

    toast.info(
      canFetchMore
        ? `已加载前 ${latestSongs.length} 首云盘歌曲加入播放队列`
        : `已将全部 ${latestSongs.length} 首云盘歌曲加入播放队列`,
    );
  } finally {
    if (host.isCurrentRun(runId) && host.getSessionEpoch() === startEpoch) {
      usePlayerStore.getState().setStatePatch({ cloudPlayAllLoading: false });
    }
  }
}
