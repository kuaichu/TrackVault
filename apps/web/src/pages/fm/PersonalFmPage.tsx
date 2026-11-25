import { Maximize2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type PersonalFmMode, QUALITY_META, type Song, getSongKey } from "#shared";
import { AlbumLink, ArtistLinks } from "../../entities/music/index.js";
import { useLikedIdsQuery, useToggleLikeMutation } from "../../entities/song/index.js";
import {
  LyricScroller,
  QuickCollectPopover,
  SfForwardFill,
  SfHeart,
  SfPauseFill,
  SfPlayFill,
  SfSlashCircle,
  audioEngine,
  resolveEffectivePlaybackQuality,
  usePlayerStore,
  useTrackLyricsQuery,
} from "../../features/player/index.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { toast } from "../../shared/store/toast-store.js";
import { CanvasAmbientGlow, CoverArt, EmptyState, SegmentedTabs } from "../../shared/ui/primitives.js";

const FM_MODE_TABS: ReadonlyArray<{ id: PersonalFmMode; label: string }> = [
  { id: "DEFAULT", label: "默认" },
  { id: "FAMILIAR", label: "熟悉" },
  { id: "EXPLORE", label: "探索" },
  { id: "FOCUS", label: "专注" },
];

function toStageCoverUrl(url?: string, size = 800): string | undefined {
  if (!url) return undefined;
  return url
    .replace(/param=\d+y\d+/, `param=${size}y${size}`)
    .replace(/T002R\d+x\d+/, `T002R${size}x${size}`);
}

function FmTrackShelfList({
  songs,
  columns = 1,
  onSelectSong,
}: {
  songs: readonly Song[];
  columns?: 1 | 2;
  onSelectSong: (song: Song) => void;
}) {
  return (
    <div className={columns === 2 ? "grid grid-cols-1 md:grid-cols-2 md:gap-x-8" : "flex flex-col"}>
      {songs.map((song, idx) => {
        const isLastOverall = idx === songs.length - 1;
        const isBottomRowInTwoCol =
          columns === 2 && (songs.length % 2 === 0 ? idx >= songs.length - 2 : idx === songs.length - 1);
        return (
          <div
            key={getSongKey(song)}
            className="group relative flex items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-[var(--tv-surface-hover)]"
          >
            <button
              type="button"
              onClick={() => onSelectSong(song)}
              className="relative shrink-0 overflow-hidden rounded-[8px]"
              aria-label={`漫游播放 ${song.title}`}
            >
              <CoverArt src={song.coverUrl} alt="" className="h-12 w-12" rounded="rounded-[8px]" />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[8px]"
                style={{ boxShadow: "var(--tv-cover-ring)" }}
              />
              <span className="absolute inset-0 flex items-center justify-center rounded-[8px] bg-black/45 opacity-0 backdrop-blur-[1px] transition-opacity duration-150 group-hover:opacity-100">
                <SfPlayFill className="h-4 w-4 text-white" />
              </span>
            </button>

            <div className="relative flex h-12 min-w-0 flex-1 items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onSelectSong(song)}
                  className="block w-full truncate text-left text-[13.5px] leading-snug font-medium text-[var(--tv-text)]"
                >
                  {song.title}
                </button>
                <div className="mt-0.5 truncate text-xs leading-snug text-[var(--tv-text-muted)]">
                  <ArtistLinks
                    platform={song.platform}
                    artists={song.artists}
                    fallbackText={song.artist}
                    primaryArtistId={song.primaryArtistId}
                    linkClassName="transition-colors hover:text-[var(--tv-text)]"
                  />
                  {song.album && (
                    <>
                      <span className="mx-1.5 opacity-45">·</span>
                      <AlbumLink song={song} className="transition-colors hover:text-[var(--tv-text)]" />
                    </>
                  )}
                </div>
              </div>

              {song.duration && (
                <span className="shrink-0 text-xs tabular-nums text-[var(--tv-text-subtle)]">
                  {song.duration}
                </span>
              )}

              <span
                aria-hidden="true"
                className={`pointer-events-none absolute right-0 -bottom-2.5 left-0 border-b border-[var(--tv-border)] transition-opacity group-hover:opacity-0 ${
                  isLastOverall ? "hidden" : isBottomRowInTwoCol ? "md:hidden" : ""
                }`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PersonalFmPage() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const fmMode = usePlayerStore((s) => s.fmMode);
  const fmSubMode = usePlayerStore((s) => s.fmSubMode);
  const fmQueue = usePlayerStore((s) => s.fmQueue);
  const fmRecentTracks = usePlayerStore((s) => s.fmRecentTracks);
  const fmLoading = usePlayerStore((s) => s.fmLoading);
  const fmError = usePlayerStore((s) => s.fmError);
  const defaultPlaybackQuality = usePlayerStore((s) => s.defaultPlaybackQuality);
  const preferredTrackQuality = usePlayerStore((s) => s.preferredTrackQuality);
  const loadedStreamQuality = usePlayerStore((s) => s.loadedStreamQuality);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);

  const [trashingId, setTrashingId] = useState<string | null>(null);
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
  const activeSongKey = activeSong ? getSongKey(activeSong) : null;
  const isCurrentActive = Boolean(
    activeSong && currentTrack && getSongKey(activeSong) === getSongKey(currentTrack),
  );

  // Synchronized with PlayerBar's active stream quality badge
  const effectiveQuality = resolveEffectivePlaybackQuality(
    activeSong,
    isCurrentActive ? (loadedStreamQuality ?? preferredTrackQuality) : preferredTrackQuality,
    defaultPlaybackQuality,
  );
  const effectiveQualityLabel = QUALITY_META[effectiveQuality].shortLabel;

  const activeQueueIdx = useMemo(
    () => (activeSongKey ? fmQueue.findIndex((item) => getSongKey(item) === activeSongKey) : -1),
    [activeSongKey, fmQueue],
  );

  // Upcoming FM queue songs after activeSong (strictly deduplicated against activeSong)
  const upcomingSongs = useMemo(() => {
    const rawUpcoming = activeQueueIdx >= 0 ? fmQueue.slice(activeQueueIdx + 1) : fmQueue.slice(1);
    const seen = new Set<string>(activeSongKey ? [activeSongKey] : []);
    const out: Song[] = [];
    for (const song of rawUpcoming) {
      const k = getSongKey(song);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(song);
      }
    }
    return out;
  }, [activeQueueIdx, activeSongKey, fmQueue]);

  // Recently roamed songs driven by fmRecentTracks (excluding active & upcoming so clear button is deterministic)
  const recentSongs = useMemo(() => {
    const excluded = new Set<string>([
      ...(activeSongKey ? [activeSongKey] : []),
      ...upcomingSongs.map((item) => getSongKey(item)),
    ]);
    const out: Song[] = [];
    for (const song of fmRecentTracks) {
      const k = getSongKey(song);
      if (!excluded.has(k)) {
        excluded.add(k);
        out.push(song);
      }
      if (out.length >= 5) break;
    }
    return out;
  }, [activeSongKey, fmRecentTracks, upcomingSongs]);

  // 3-Cover Layered Carousel: [leftWing (prev or rear-stack), centerHero (activeSong), rightWing (next)]
  const prevCarouselSong = recentSongs[0] ?? null;
  const nextCarouselSong = upcomingSongs[0] ?? null;
  const ambientLeftDepthSong = !prevCarouselSong ? (upcomingSongs[1] ?? null) : null;

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

  const handleSubModeChange = async (nextMode: PersonalFmMode) => {
    if (nextMode === fmSubMode && fmQueue.length > 0) return;
    try {
      const nextBatch = await audioEngine.setFmSubMode(nextMode);
      if (!mountedRef.current) return;
      if (nextBatch.length === 0) {
        toast.info("当前模式下暂时没有更多推荐歌曲");
      }
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : "切换漫游模式失败");
    }
  };

  const handleAppendBatch = async () => {
    try {
      await audioEngine.appendFmBatch();
    } catch (err) {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : "预载更多漫游曲目失败");
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

  const handlePlaySpecificFmSong = (song: Song) => {
    const key = getSongKey(song);
    const inCurrentQueue = fmQueue.some((item) => getSongKey(item) === key);
    const nextQueue = inCurrentQueue ? fmQueue : [song, ...fmQueue];
    if (!inCurrentQueue) {
      usePlayerStore.getState().setStatePatch({ fmQueue: nextQueue });
    }
    void audioEngine.playFmTrack(song, { queue: nextQueue });
  };

  const handleNext = () => {
    void audioEngine.skipOrStartFmNext().catch((err) => {
      if (!mountedRef.current) return;
      toast.error(err instanceof Error ? err.message : "加载下一批 FM 失败");
    });
  };

  const handleDislike = async () => {
    if (!activeSong || trashingId === activeSong.id) return;
    setTrashingId(activeSong.id);
    try {
      await audioEngine.trashFmSong(activeSong);
    } finally {
      if (mountedRef.current) {
        setTrashingId((prev) => (prev === activeSong.id ? null : prev));
      }
    }
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

  const heroCoverUrl = toStageCoverUrl(activeSong?.coverUrl, 800);
  const vipPlayback = activeSong?.availability?.playback.status === "vip";
  const hasRecentSongs = recentSongs.length > 0;

  return (
    <div className="relative space-y-8 pb-8 sm:space-y-10 md:pb-10">
      {/* Full-bleed outer-canvas radial ambient glow with HSL lightness cap & bottom linear dissolve */}
      <CanvasAmbientGlow coverUrl={activeSong?.coverUrl} />

      {/* Apple Music Editorial Header + Submode Segmented Control + Borderless Refresh */}
      <div className="relative flex flex-wrap items-end justify-between gap-4 border-b border-[var(--tv-border)] pb-3.5">
        <h1 className="text-[30px] leading-none font-extrabold tracking-tight text-[var(--tv-text)] sm:text-[34px]">
          私人漫游
        </h1>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedTabs<PersonalFmMode>
            value={fmSubMode}
            onChange={(mode) => void handleSubModeChange(mode)}
            items={[...FM_MODE_TABS]}
          />

          <button
            type="button"
            disabled={fmLoading}
            onClick={() => void handleRefreshBatch(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] disabled:opacity-45"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${fmLoading ? "animate-spin" : ""}`} />
            <span>换一批</span>
          </button>
        </div>
      </div>

      {fmLoading && !activeSong ? (
        <div className="relative grid items-center gap-8 py-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-12">
          <div className="flex flex-col items-center lg:items-start">
            <div className="h-60 w-60 animate-pulse rounded-[14px] bg-[var(--tv-surface)]" />
            <div className="mt-5 h-6 w-48 animate-pulse rounded bg-[var(--tv-surface)]" />
            <div className="mt-2 h-4 w-32 animate-pulse rounded bg-[var(--tv-surface)]/70" />
          </div>
          <div className="h-[320px] animate-pulse rounded-2xl bg-[var(--tv-surface)]/45" />
        </div>
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
        <>
          {/* Frameless Main Radio Stage: 3-Cover Layered Carousel + Smart Lyrics Stage */}
          <section className="relative grid items-center gap-8 pt-1 lg:grid-cols-[384px_minmax(0,1fr)] lg:gap-12">
            <div className="flex flex-col items-center lg:items-start">
              {/* Three-Cover Layered Depth Carousel (三联层叠封面栈) */}
              <div className="relative flex h-[236px] w-full max-w-[364px] items-center justify-center sm:h-[256px]">
                {/* Left Wing: Previous Roamed Song (interactive) or Rear-Stack Depth Layer */}
                {prevCarouselSong ? (
                  <button
                    type="button"
                    onClick={() => handlePlaySpecificFmSong(prevCarouselSong)}
                    title={`回到上一首：${prevCarouselSong.title}`}
                    aria-label={`回到上一首漫游：${prevCarouselSong.title}`}
                    className="group/prev absolute left-1 z-10 overflow-hidden rounded-[12px] opacity-48 transition-all duration-300 -rotate-[4deg] hover:-translate-x-1 hover:opacity-85 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] sm:left-2"
                    style={{ boxShadow: "0 16px 38px rgba(0, 0, 0, 0.42)" }}
                  >
                    <CoverArt
                      src={toStageCoverUrl(prevCarouselSong.coverUrl, 400)}
                      alt=""
                      className="h-[168px] w-[168px] sm:h-[184px] sm:w-[184px]"
                      rounded="rounded-[12px]"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-[12px]"
                      style={{ boxShadow: "var(--tv-cover-ring)" }}
                    />
                  </button>
                ) : ambientLeftDepthSong ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute left-2 z-10 overflow-hidden rounded-[12px] opacity-30 blur-[0.4px] -rotate-[4deg] sm:left-3"
                    style={{ boxShadow: "0 14px 32px rgba(0, 0, 0, 0.36)" }}
                  >
                    <CoverArt
                      src={toStageCoverUrl(ambientLeftDepthSong.coverUrl, 400)}
                      alt=""
                      className="h-[164px] w-[164px] sm:h-[180px] sm:w-[180px]"
                      rounded="rounded-[12px]"
                    />
                  </div>
                ) : null}

                {/* Right Wing: Next Up in FM (interactive) */}
                {nextCarouselSong && (
                  <button
                    type="button"
                    onClick={() => handlePlaySpecificFmSong(nextCarouselSong)}
                    title={`下一首：${nextCarouselSong.title}`}
                    aria-label={`跳至下一首漫游：${nextCarouselSong.title}`}
                    className="group/next absolute right-1 z-10 overflow-hidden rounded-[12px] opacity-56 transition-all duration-300 rotate-[4deg] hover:translate-x-1 hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] sm:right-2"
                    style={{ boxShadow: "0 16px 38px rgba(0, 0, 0, 0.44)" }}
                  >
                    <CoverArt
                      src={toStageCoverUrl(nextCarouselSong.coverUrl, 400)}
                      alt=""
                      className="h-[168px] w-[168px] sm:h-[184px] sm:w-[184px]"
                      rounded="rounded-[12px]"
                    />
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-[12px]"
                      style={{ boxShadow: "var(--tv-cover-ring)" }}
                    />
                  </button>
                )}

                {/* Center Hero Cover — pure unobstructed artwork */}
                <div
                  className="relative z-20 overflow-hidden rounded-[14px] transition-transform duration-300"
                  style={{
                    boxShadow: "0 26px 64px -12px rgba(0, 0, 0, 0.62), 0 10px 24px -8px rgba(0, 0, 0, 0.36)",
                  }}
                >
                  <CoverArt
                    src={heroCoverUrl}
                    alt={activeSong.title}
                    className="h-[216px] w-[216px] sm:h-[236px] sm:w-[236px]"
                    rounded="rounded-[14px]"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 rounded-[14px]"
                    style={{ boxShadow: "var(--tv-cover-ring)" }}
                  />
                </div>
              </div>

              {/* Track Title & Artist/Album Metadata */}
              <div className="mt-5 w-full max-w-[364px] space-y-1 text-center lg:text-left">
                <div className="flex items-center justify-center gap-2 lg:justify-start">
                  <h2 className="truncate text-[21px] leading-snug font-bold tracking-tight text-[var(--tv-text)] sm:text-[22px]">
                    {activeSong.title}
                  </h2>
                  {vipPlayback && (
                    <span className="inline-flex h-[15px] shrink-0 items-center rounded-[4px] border border-[var(--tv-border-strong)] px-1 text-[9.5px] leading-none font-semibold tracking-wider text-[var(--tv-text-subtle)]">
                      VIP
                    </span>
                  )}
                </div>

                <div className="truncate text-[13px] text-[var(--tv-text-muted)]">
                  <ArtistLinks
                    platform={activeSong.platform}
                    artists={activeSong.artists}
                    fallbackText={activeSong.artist}
                    primaryArtistId={activeSong.primaryArtistId}
                    linkClassName="transition-colors hover:text-[var(--tv-text)]"
                  />
                  {activeSong.album && (
                    <>
                      <span className="mx-1.5 opacity-45">·</span>
                      <AlbumLink
                        song={activeSong}
                        className="transition-colors hover:text-[var(--tv-text)]"
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Apple Music Rounded-Rect Primary Button + Borderless Hover-Reveal Station Icons */}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5 lg:justify-start">
                <button
                  type="button"
                  onClick={handlePlayToggle}
                  aria-label={isCurrentActive && isPlaying ? "暂停漫游" : "开始漫游"}
                  className={`mr-1 inline-flex h-9 items-center justify-center gap-2 rounded-[8px] px-5 text-[13px] font-semibold transition-all active:scale-[0.98] ${
                    isCurrentActive && isPlaying
                      ? "bg-[var(--tv-lcd-bg)] text-[var(--tv-text)] ring-1 ring-inset ring-[var(--tv-border-strong)] hover:bg-[var(--tv-nav-active)]"
                      : "bg-[var(--tv-accent)] text-[var(--tv-accent-fg)] shadow-xs hover:bg-[var(--tv-accent-hover)]"
                  }`}
                >
                  {isCurrentActive && isPlaying ? (
                    <>
                      <SfPauseFill className="h-3.5 w-3.5 text-[var(--tv-accent)]" />
                      <span>暂停漫游</span>
                    </>
                  ) : (
                    <>
                      <SfPlayFill className="h-3.5 w-3.5" />
                      <span>{isCurrentActive ? "继续漫游" : "开始漫游"}</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={fmLoading}
                  onClick={handleNext}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] active:scale-95 disabled:opacity-45"
                  title="下一首"
                  aria-label="下一首"
                >
                  <SfForwardFill className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  disabled={trashingId === activeSong.id}
                  onClick={() => void handleDislike()}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-danger)]/14 hover:text-[var(--tv-danger)] active:scale-95 disabled:opacity-45"
                  title="不喜欢（移入垃圾桶，减少此类推荐）"
                  aria-label="不喜欢"
                >
                  <SfSlashCircle className="h-[17px] w-[17px]" />
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
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors hover:bg-[var(--tv-surface-hover)] active:scale-95 ${
                      isLiked ? "text-[#fa2d48]" : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                    }`}
                    title={isLiked ? "取消喜欢" : "红心喜欢"}
                    aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
                  >
                    <SfHeart filled={isLiked} className="h-[17px] w-[17px]" />
                  </button>
                )}

                <QuickCollectPopover song={activeSong} variant="stage" />

                {isCurrentActive && (
                  <button
                    type="button"
                    onClick={() => setFullscreenOpen(true)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)] active:scale-95"
                    title="全屏歌词"
                    aria-label="展开全屏歌词"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Right Column: Standby-Frosted Preview vs Live Synchronized Lyrics */}
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 px-3">
                {isCurrentActive ? (
                  <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--tv-accent)]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--tv-accent)] animate-pulse" />
                    <span>正在漫游 · 词曲实时同步</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tv-lcd-bg)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--tv-text-muted)]">
                    <span>待机预览 · 点击左侧「开始漫游」或任意歌词切入电台</span>
                  </span>
                )}

                <div className="flex items-center gap-2 text-[11.5px] tabular-nums text-[var(--tv-text-subtle)]">
                  <span>{effectiveQualityLabel}</span>
                  {activeSong.duration && (
                    <>
                      <span className="opacity-45">·</span>
                      <span>{activeSong.duration}</span>
                    </>
                  )}
                </div>
              </div>

              <div
                className={`relative h-[280px] overflow-hidden transition-all duration-500 sm:h-[330px] lg:h-[368px] ${
                  isCurrentActive
                    ? "opacity-100 blur-none"
                    : "opacity-55 blur-[0.75px] hover:opacity-95 hover:blur-none focus-within:opacity-95 focus-within:blur-none"
                }`}
              >
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
                  tone="theme"
                  syncWithClock={isCurrentActive}
                  onLineClick={handleLyricLineClick}
                />
              </div>
            </div>
          </section>

          {/* Lower Canvas Extension Zone: Side-by-Side Split when History Exists (fills horizontal space & keeps height compact) */}
          <div
            className={`relative border-t border-[var(--tv-border)] pt-7 ${
              hasRecentSongs ? "grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-12" : ""
            }`}
          >
            <section className="min-w-0 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-[18px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[19px]">
                    接下来漫游
                  </h3>
                  {upcomingSongs.length > 0 && (
                    <span className="text-[12.5px] font-medium tabular-nums text-[var(--tv-text-subtle)]">
                      {upcomingSongs.length}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  disabled={fmLoading}
                  onClick={() => void handleAppendBatch()}
                  className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-xs font-medium text-[var(--tv-accent)] transition-colors hover:bg-[var(--tv-accent-soft)] disabled:opacity-45"
                >
                  <Plus className="h-3.5 w-3.5 stroke-[2.2]" />
                  <span>预载更多</span>
                </button>
              </div>

              {upcomingSongs.length > 0 ? (
                <FmTrackShelfList
                  songs={upcomingSongs}
                  columns={hasRecentSongs ? 1 : 2}
                  onSelectSong={handlePlaySpecificFmSong}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[var(--tv-lcd-bg)] px-4 py-3 text-xs text-[var(--tv-text-muted)]">
                  <span>当前批次即将播完，曲终将自动续接下一批推荐。</span>
                  <button
                    type="button"
                    disabled={fmLoading}
                    onClick={() => void handleAppendBatch()}
                    className="font-semibold text-[var(--tv-accent)] transition-opacity hover:opacity-80 disabled:opacity-45"
                  >
                    立即续接
                  </button>
                </div>
              )}
            </section>

            {hasRecentSongs && (
              <section className="min-w-0 space-y-3 border-t border-[var(--tv-border)] pt-7 lg:border-t-0 lg:pt-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-[18px] font-bold tracking-tight text-[var(--tv-text)] sm:text-[19px]">
                      刚刚听过
                    </h3>
                    <span className="text-[12.5px] font-medium tabular-nums text-[var(--tv-text-subtle)]">
                      {recentSongs.length}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => audioEngine.clearFmRecentTracks()}
                    className="inline-flex h-7 items-center rounded-[7px] px-2 text-xs font-medium text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
                  >
                    清空
                  </button>
                </div>

                <FmTrackShelfList songs={recentSongs} columns={1} onSelectSong={handlePlaySpecificFmSong} />
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
