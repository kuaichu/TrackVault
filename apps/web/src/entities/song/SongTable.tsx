import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ListPlus, Lock, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { type DownloadMode, type QualityLevel, type Song, getQualityLabel, getSongKey } from "#shared";
import { audioEngine } from "../../features/player/engine/audio-engine.js";
import { usePlayerStore } from "../../features/player/store/player-store.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../shared/ui/primitives.js";

interface SongTableProps {
  songs: Song[];
  emptyText?: string;
  onRemoveTrack?: (song: Song) => void;
}

export function SongTable({ songs, emptyText = "暂无歌曲", onRemoveTrack }: SongTableProps) {
  const queryClient = useQueryClient();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const { data: settingsData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const defaultDownloadQuality = settingsData?.settings.defaultDownloadQuality ?? "lossless";
  const [perSongQuality, setPerSongQuality] = useState<Record<string, QualityLevel>>({});
  const [downloadMode, setDownloadMode] = useState<DownloadMode>("tagged_server");

  const downloadMutation = useMutation({
    mutationFn: (payload: { song: Song; level: QualityLevel; mode: DownloadMode }) =>
      api.createDownloadJob(payload),
    onSuccess: (res, vars) => {
      toast.success(`已加入下载队列：${vars.song.title} (${getQualityLabel(vars.level)})`);
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (res.job.directUrl) {
        window.open(res.job.directUrl, "_blank", "noopener,noreferrer");
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "加入下载队列失败");
    },
  });

  if (songs.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] px-6 py-12 text-center text-sm text-[var(--tv-text-muted)]">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--tv-text-muted)]">
        <span>共 {songs.length} 首曲目</span>
        <div className="flex items-center gap-2">
          <span>下载方式：</span>
          <select
            value={downloadMode}
            onChange={(e) => setDownloadMode(e.target.value as DownloadMode)}
            className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface-elevated)] px-2.5 py-1 text-xs text-[var(--tv-text)] focus:border-amber-400/60 focus:outline-none"
          >
            <option value="tagged_server">服务端写标签下载（推荐）</option>
            <option value="direct_link">无标签极速直链</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)]">
        <div className="divide-y divide-[var(--tv-border)]">
          {songs.map((song, idx) => {
            const key = getSongKey(song);
            const active = currentTrack ? getSongKey(currentTrack) === key : false;
            const locked = Boolean(song.availability?.playback.locked);
            const chosenDownloadLevel =
              perSongQuality[key] ??
              (song.availableQualities.some((q) => q.level === defaultDownloadQuality)
                ? defaultDownloadQuality
                : (song.availableQualities[song.availableQualities.length - 1]?.level ?? "standard"));

            return (
              <div
                key={key}
                className={`group flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-[var(--tv-surface-hover)] ${
                  active ? "bg-amber-500/10" : ""
                }`}
              >
                <span className="w-6 text-right text-xs tabular-nums text-[var(--tv-text-subtle)]">
                  {idx + 1}
                </span>

                <button
                  type="button"
                  onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                  className="relative shrink-0"
                  title={locked ? song.availability?.playback.reason : "播放"}
                >
                  <CoverArt src={song.coverUrl} alt={song.title} className="h-10 w-10" />
                  <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                    {locked ? (
                      <Lock className="h-4 w-4 text-rose-300" />
                    ) : (
                      <Play className="h-4 w-4 fill-amber-400 text-amber-400" />
                    )}
                  </span>
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void audioEngine.playTrack(song, { queue: songs })}
                      className={`truncate text-left text-sm font-medium hover:text-amber-300 ${
                        active ? "text-amber-400" : "text-[var(--tv-text)]"
                      }`}
                    >
                      {song.title}
                    </button>
                    <PlatformBadge platform={song.platform} />
                    {song.isCloud && (
                      <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300">
                        云盘
                      </span>
                    )}
                    {song.availability && song.availability.playback.status !== "available" && (
                      <span
                        title={song.availability.playback.reason}
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          song.availability.playback.locked
                            ? "bg-rose-500/15 text-rose-300"
                            : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        {song.availability.playback.label}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--tv-text-muted)]">
                    {song.artist} · {song.album}
                  </div>
                </div>

                <span className="hidden w-12 text-right text-xs tabular-nums text-[var(--tv-text-subtle)] sm:inline">
                  {song.duration}
                </span>

                <div className="flex items-center gap-1.5">
                  <select
                    aria-label="选择下载音质"
                    value={chosenDownloadLevel}
                    onChange={(e) =>
                      setPerSongQuality((prev) => ({
                        ...prev,
                        [key]: e.target.value as QualityLevel,
                      }))
                    }
                    className="rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface-elevated)] px-2 py-1 text-xs text-[var(--tv-text-muted)] focus:border-amber-400/60 focus:outline-none"
                  >
                    {song.availableQualities.map((q) => (
                      <option key={q.level} value={q.level}>
                        {q.label}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => {
                      addToQueue(song);
                      toast.info(`已添加到播放队列：${song.title}`);
                    }}
                    title="加入队列"
                    className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-white/10 hover:text-[var(--tv-text)]"
                  >
                    <ListPlus className="h-4 w-4" />
                  </button>

                  <button
                    type="button"
                    disabled={downloadMutation.isPending}
                    onClick={() =>
                      downloadMutation.mutate({
                        song,
                        level: chosenDownloadLevel,
                        mode: downloadMode,
                      })
                    }
                    title={`下载 (${getQualityLabel(chosenDownloadLevel)})`}
                    className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-amber-500/15 hover:text-amber-300 disabled:opacity-40"
                  >
                    <Download className="h-4 w-4" />
                  </button>

                  {onRemoveTrack && (
                    <button
                      type="button"
                      onClick={() => onRemoveTrack(song)}
                      title="从歌单移除"
                      className="rounded-lg p-1.5 text-[var(--tv-text-muted)] hover:bg-rose-500/15 hover:text-rose-300"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {active && isPlaying && (
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" aria-label="播放中" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
