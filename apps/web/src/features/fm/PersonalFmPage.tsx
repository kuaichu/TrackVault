import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, Maximize2, Pause, Play, RefreshCw, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type Song, getSongKey, sanitizeCssUrl } from "#shared";
import { AlbumLink, ArtistLinks } from "../../entities/music/EntityLinks.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState } from "../../shared/ui/primitives.js";
import { LyricScroller } from "../player/components/LyricScroller.js";
import { audioEngine } from "../player/engine/audio-engine.js";
import { usePlayerStore } from "../player/store/player-store.js";

export function PersonalFmPage() {
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setFullscreenOpen = usePlayerStore((s) => s.setFullscreenOpen);

  const [fmList, setFmList] = useState<Song[]>([]);
  const [fmIndex, setFmIndex] = useState(0);

  const fmQuery = useQuery({
    queryKey: ["personal-fm"],
    queryFn: () => api.getPersonalFm(),
    staleTime: 0,
  });

  useEffect(() => {
    const incoming = fmQuery.data?.songs ?? [];
    if (incoming.length > 0 && fmList.length === 0) {
      setFmList(incoming);
      setFmIndex(0);
    }
  }, [fmQuery.data?.songs, fmList.length]);

  const activeSong = fmList[fmIndex] ?? fmList[0] ?? null;
  const isCurrentActive = Boolean(
    activeSong && currentTrack && getSongKey(activeSong) === getSongKey(currentTrack),
  );

  const { data: lyricData, isLoading: lyricsLoading } = useQuery({
    queryKey: ["lyrics", activeSong?.platform, activeSong?.id],
    queryFn: () =>
      activeSong ? api.getLyrics(activeSong.platform, activeSong.id, activeSong.mediaId) : null,
    enabled: Boolean(activeSong),
  });

  const { data: likedIdsData } = useQuery({
    queryKey: ["liked-ids", "netease"],
    queryFn: () => api.getLikedSongIds("netease"),
    staleTime: 60_000,
  });

  const likedSet = new Set(likedIdsData?.ids ?? []);
  const isLiked = activeSong ? likedSet.has(activeSong.id) : false;

  const likeMutation = useMutation({
    mutationFn: () => {
      if (!activeSong) throw new Error("无当前歌曲");
      return api.toggleSongLike("netease", activeSong.id, !isLiked);
    },
    onSuccess: (res) => {
      toast.success(res.liked ? "已喜欢" : "已取消喜欢");
      void queryClient.invalidateQueries({ queryKey: ["liked-ids", "netease"] });
      if (activeSong) {
        queryClient.setQueryData(["song-like", "netease", activeSong.id], res);
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "操作失败"),
  });

  const fetchMoreFm = async (autoPlayFirst = false) => {
    try {
      const res = await api.getPersonalFm();
      const nextBatch = res.songs;
      if (nextBatch.length === 0) {
        toast.info("暂时没有更多推荐歌曲");
        return;
      }
      setFmList(nextBatch);
      setFmIndex(0);
      if (autoPlayFirst && nextBatch[0]) {
        void audioEngine.playTrack(nextBatch[0], { queue: nextBatch });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载下一批 FM 失败");
    }
  };

  const handlePlayToggle = () => {
    if (!activeSong) return;
    if (isCurrentActive) {
      void audioEngine.togglePlay();
    } else {
      void audioEngine.playTrack(activeSong, { queue: fmList });
    }
  };

  const handleNext = () => {
    const nextIdx = fmIndex + 1;
    if (nextIdx < fmList.length) {
      setFmIndex(nextIdx);
      const nextSong = fmList[nextIdx];
      if (nextSong) void audioEngine.playTrack(nextSong, { queue: fmList });
    } else {
      void fetchMoreFm(true);
    }
  };

  const backdrop = sanitizeCssUrl(activeSong?.coverUrl);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">私人漫游</h1>
        <button
          type="button"
          onClick={() => void fetchMoreFm(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-surface)] px-3 py-1.5 text-xs font-medium text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          换一批
        </button>
      </div>

      {fmQuery.isLoading && !activeSong ? (
        <div className="h-[420px] animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
      ) : fmQuery.isError && !activeSong ? (
        <EmptyState
          title="开启私人漫游需要绑定网易云账号"
          description={fmQuery.error instanceof Error ? fmQuery.error.message : "请先在设置中扫码登录网易云"}
          action={
            <Link
              to="/settings"
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)]"
            >
              前往绑定
            </Link>
          }
        />
      ) : activeSong ? (
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
                onClick={handleNext}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12 text-white transition-colors hover:bg-white/20"
                title="下一首"
                aria-label="下一首"
              >
                <SkipForward className="h-4 w-4 fill-current" />
              </button>

              <button
                type="button"
                onClick={() => likeMutation.mutate()}
                className={`inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/12 transition-colors hover:bg-white/20 ${
                  isLiked ? "text-[#fa2d48]" : "text-white/80"
                }`}
                title={isLiked ? "取消喜欢" : "红心喜欢"}
                aria-label={isLiked ? "取消喜欢" : "红心喜欢"}
              >
                <Heart className={`h-4 w-4 ${isLiked ? "fill-current" : ""}`} />
              </button>

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
            <LyricScroller lines={lyricData?.lyrics.lines ?? []} loading={lyricsLoading} large />
          </div>
        </section>
      ) : null}
    </div>
  );
}
