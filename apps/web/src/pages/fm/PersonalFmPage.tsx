import { Heart, Maximize2, Pause, Play, RefreshCw, SkipForward } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { getSongKey, sanitizeCssUrl } from "#shared";
import { AlbumLink, ArtistLinks } from "../../entities/music/index.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../../entities/song/index.js";
import {
  LyricScroller,
  audioEngine,
  usePlayerStore,
  useTrackLyricsQuery,
} from "../../features/player/index.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState } from "../../shared/ui/primitives.js";

export function PersonalFmPage() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const fmMode = usePlayerStore((s) => s.fmMode);
  const fmQueue = usePlayerStore((s) => s.fmQueue);
  const fmLoading = usePlayerStore((s) => s.fmLoading);
  const fmError = usePlayerStore((s) => s.fmError);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const state = usePlayerStore.getState();
    if (state.fmQueue.length === 0 && !state.fmLoading) {
      void audioEngine.loadFmBatch({ autoPlay: false, source: "page" }).catch(() => undefined);
    }
    return () => {
      mountedRef.current = false;
      // P09: Always cancel page-initiated manual/preview FM fetches when leaving /fm
      // (without disturbing active FM playback or engine-driven queue-end continuations)
      audioEngine.cancelPageFmFetch();
    };
  }, []);

  // Single source of truth: follow AudioEngine's active track while in FM mode, else preview first candidate
  const activeSong = fmMode && currentTrack ? currentTrack : (fmQueue[0] ?? null);
  const isCurrentActive = Boolean(
    activeSong && currentTrack && getSongKey(activeSong) === getSongKey(currentTrack),
  );

  const lyricQuery = useTrackLyricsQuery(activeSong, Boolean(activeSong));

  const capabilities = useCapabilities();
  const canLike = Boolean(activeSong && capabilities[activeSong.platform].canLikeSong);
  const { data: likedIdsData } = useLikedIdsQuery(activeSong?.platform, canLike);
  const likeMutation = useToggleLikeMutation();

  const likedSet = new Set(likedIdsData?.ids ?? []);
  const isLiked = activeSong ? likedSet.has(activeSong.id) : false;

  const handleRefreshBatch = async (autoPlay = true) => {
    try {
      const nextBatch = await audioEngine.loadFmBatch({ autoPlay, source: "page" });
      if (!mountedRef.current) return;
      if (nextBatch.length === 0) {
        toast.info("暂时没有更多推荐歌曲");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : "加载下一批 FM 失败");
    }
  };

  const handlePlayToggle = () => {
    if (!activeSong) return;
    if (isCurrentActive) {
      void audioEngine.togglePlay();
    } else {
      void audioEngine.playFmTrack(activeSong, { queue: fmQueue });
    }
  };

  const handleNext = () => {
    void audioEngine.skipOrStartFmNext().catch((err) => {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : "加载下一批 FM 失败");
    });
  };

  const handleLyricLineClick = (time: number) => {
    if (!activeSong) return;
    if (isCurrentActive) {
      audioEngine.seek(time);
    } else {
      // Decision #4: clicking a lyric line on an unplayed FM candidate starts playing it and seeks to that timestamp
      void audioEngine.playFmTrack(activeSong, { queue: fmQueue, startAtSeconds: time });
    }
  };

  const backdrop = sanitizeCssUrl(activeSong?.coverUrl);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">私人漫游</h1>
        <button
          type="button"
          disabled={fmLoading}
          onClick={() => void handleRefreshBatch(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${fmLoading ? "animate-spin" : ""}`} />
          换一批
        </button>
      </div>

      {fmLoading && !activeSong ? (
        <div className="h-[420px] animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
      ) : fmError && !activeSong ? (
        <EmptyState
          title="开启私人漫游需要绑定网易云账号"
          description={fmError}
          action={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleRefreshBatch(false)}
                className="inline-flex items-center rounded-lg bg-[var(--tv-surface-active)] px-4 py-2 text-xs font-medium text-[var(--tv-text)]"
              >
                重试
              </button>
              <Link
                to="/settings"
                className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)]"
              >
                前往绑定
              </Link>
            </div>
          }
        />
      ) : !activeSong ? (
        <EmptyState
          title="暂无私人漫游推荐"
          description="暂时没有获取到可播放的推荐曲目，请稍后重试。"
          action={
            <button
              type="button"
              onClick={() => void handleRefreshBatch(true)}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)]"
            >
              重新获取
            </button>
          }
        />
      ) : (
        <section className="relative grid gap-6 overflow-hidden rounded-2xl bg-[#161619] p-5 text-white sm:gap-8 sm:p-8 md:grid-cols-[320px_minmax(0,1fr)]">
          {backdrop && (
            <div
              className="pointer-events-none absolute inset-0 scale-125 bg-cover bg-center opacity-40 blur-[80px] saturate-150"
              style={{ backgroundImage: `url("${backdrop}")` }}
            />
          )}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-black/55 via-black/60 to-black/75" />

          <div className="relative flex flex-col items-center md:items-start">
            <CoverArt
              src={activeSong.coverUrl}
              alt={activeSong.title}
              darkBackdrop
              className="aspect-square w-52 shadow-[0_24px_70px_rgba(0,0,0,0.65)] sm:w-64 md:w-72"
              rounded="rounded-2xl"
            />
            <div className="mt-5 w-full space-y-1 text-center md:text-left">
              <h2 className="truncate text-xl font-bold text-white">{activeSong.title}</h2>
              <div className="truncate text-xs text-white/70">
                <ArtistLinks
                  platform={activeSong.platform}
                  artists={activeSong.artists}
                  fallbackText={activeSong.artist}
                  primaryArtistId={activeSong.primaryArtistId}
                  linkClassName="hover:text-white hover:underline"
                />
                {activeSong.album && (
                  <>
                    <span className="mx-1.5 opacity-50">·</span>
                    <AlbumLink song={activeSong} className="hover:text-white hover:underline" />
                  </>
                )}
              </div>
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={handlePlayToggle}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#111113] shadow-lg transition-transform hover:scale-105 active:scale-95"
                aria-label={isCurrentActive && isPlaying ? "暂停" : "播放"}
              >
                {isCurrentActive && isPlaying ? (
                  <Pause className="h-5 w-5 fill-current" />
                ) : (
                  <Play className="ml-0.5 h-5 w-5 fill-current" />
                )}
              </button>

              <button
                type="button"
                disabled={fmLoading}
                onClick={handleNext}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/20 disabled:opacity-50"
                title="下一首"
                aria-label="下一首"
              >
                <SkipForward className="h-4 w-4 fill-current" />
              </button>

              {canLike && (
                <button
                  type="button"
                  onClick={() =>
                    likeMutation.mutate({
                      platform: activeSong.platform,
                      songId: activeSong.id,
                      nextLiked: !isLiked,
                      songTitle: activeSong.title,
                    })
                  }
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12 transition-colors hover:bg-white/20 ${
                    isLiked ? "text-[#fa2d48]" : "text-white/80"
                  }`}
                  title={isLiked ? "取消喜欢" : "红心喜欢"}
                  aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
                >
                  <Heart className={`h-4 w-4 ${isLiked ? "fill-current" : ""}`} />
                </button>
              )}

              {isCurrentActive && (
                <button
                  type="button"
                  onClick={() => setFullscreenOpen(true)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white/80 transition-colors hover:bg-white/20"
                  title="全屏歌词"
                  aria-label="展开全屏歌词"
                >
                  <Maximize2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          <div className="relative h-[260px] overflow-hidden sm:h-[320px] md:h-[380px]">
            <LyricScroller
              lines={lyricQuery.data?.lyrics.lines ?? []}
              loading={lyricQuery.isLoading}
              error={
                lyricQuery.isError
                  ? lyricQuery.error instanceof Error
                    ? lyricQuery.error.message
                    : "歌词加载失败"
                  : null
              }
              onRetry={() => void lyricQuery.refetch()}
              large
              syncWithClock={isCurrentActive}
              onLineClick={handleLyricLineClick}
            />
          </div>
        </section>
      )}
    </div>
  );
}
