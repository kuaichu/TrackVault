import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type Song, getSongKey } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { useCapabilities } from "../../../shared/hooks/use-capabilities.js";
import { toast } from "../../../shared/store/toast-store.js";
import { CoverArt, PlatformBadge } from "../../../shared/ui/primitives.js";
import { SfPlusCircle } from "./AppleMusicIcons.js";

export function QuickCollectPopover({
  song,
  variant = "player-bar",
}: {
  song: Song | null;
  variant?: "player-bar" | "mobile-bar" | "fullscreen";
}) {
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const songKey = song ? getSongKey(song) : "";
  const prevSongKeyRef = useRef(songKey);
  if (prevSongKeyRef.current !== songKey) {
    prevSongKeyRef.current = songKey;
    if (open) {
      setOpen(false);
      setCreating(false);
      setNewName("");
    }
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = () => {
      setOpen(false);
      setCreating(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (creating) {
      inputRef.current?.focus();
    }
  }, [creating]);

  const canManage = Boolean(song && capabilities[song.platform].canManagePlaylistTracks);
  const canCreate = Boolean(song && capabilities[song.platform].canCreatePlaylist);

  const playlistsQuery = useQuery({
    queryKey: ["playlists", song?.platform ?? "netease"],
    queryFn: () => {
      if (!song) throw new Error("未选择歌曲");
      return api.getUserPlaylists(song.platform);
    },
    enabled: Boolean(open && song && canManage),
    staleTime: 60_000,
  });

  const addMutation = useMutation({
    mutationFn: (vars: { playlistId: string; playlistName: string; targetSong: Song }) =>
      api.addTracksToPlaylist(vars.targetSong.platform, vars.playlistId, [vars.targetSong.id]),
    onSuccess: (_res, vars) => {
      toast.success(`已收藏到「${vars.playlistName}」`);
      setOpen(false);
      setCreating(false);
      void queryClient.invalidateQueries({
        queryKey: ["playlist-tracks", vars.targetSong.platform, vars.playlistId],
      });
      void queryClient.invalidateQueries({ queryKey: ["playlists", vars.targetSong.platform] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "收藏到歌单失败");
    },
  });

  const createAndCollectMutation = useMutation({
    mutationFn: (vars: { name: string; targetSong: Song }) =>
      api.createPlaylist(vars.targetSong.platform, vars.name, [vars.targetSong.id]),
    onSuccess: (res, vars) => {
      toast.success(`已新建歌单「${res.playlistName}」并收藏`);
      setNewName("");
      setCreating(false);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["playlists", vars.targetSong.platform] });
      void queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "新建歌单失败");
    },
  });

  if (!song || !canManage) return null;

  const ownedPlaylists = (playlistsQuery.data?.playlists ?? []).filter((pl) => pl.owned);
  const isFullscreen = variant === "fullscreen";
  const isMobileBar = variant === "mobile-bar";
  const isBusy = addMutation.isPending || createAndCollectMutation.isPending;

  const handleCreateSubmit = (event: FormEvent) => {
    event.preventDefault();
    const clean = newName.trim();
    if (!clean || isBusy) return;
    createAndCollectMutation.mutate({ name: clean, targetSong: song });
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation boundary around interactive popover controls
    <div className="relative" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="收藏到歌单"
        aria-label="收藏到歌单"
        className={
          isFullscreen
            ? `inline-flex items-center justify-center rounded-full p-2 transition-all duration-150 ${
                open
                  ? "bg-white/14 text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white/95 active:scale-95"
              }`
            : isMobileBar
              ? `inline-flex items-center justify-center rounded-full p-1.5 transition-colors ${
                  open ? "text-[var(--tv-accent)]" : "text-[var(--tv-text-muted)] hover:text-[var(--tv-text)]"
                }`
              : `inline-flex items-center justify-center rounded-full p-1 transition-all duration-150 ${
                  open
                    ? "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]"
                    : "text-[var(--tv-text-subtle)] opacity-70 group-hover/lcd:opacity-100 hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)] active:scale-95"
                }`
        }
      >
        <SfPlusCircle className={isFullscreen ? "h-5 w-5" : isMobileBar ? "h-4 w-4" : "h-[15px] w-[15px]"} />
      </button>

      {open && (
        <div
          className={
            isFullscreen
              ? "absolute bottom-full right-0 mb-2"
              : isMobileBar
                ? "absolute bottom-full right-0 mb-2"
                : "absolute bottom-full left-1/2 mb-3 -translate-x-1/2"
          }
          style={{ zIndex: "var(--tv-z-dropdown)" }}
        >
          <section
            aria-label="收藏到歌单面板"
            className={
              isFullscreen
                ? "tv-popover-up w-64 rounded-2xl border border-white/10 bg-[#1d1d22]/88 p-2 text-white shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur-3xl"
                : "tv-popover-up w-64 rounded-2xl border border-[var(--tv-glass-border)] bg-[var(--tv-surface-elevated)]/92 p-2 shadow-[var(--tv-glass-shadow)] backdrop-blur-2xl"
            }
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span
                className={`text-xs font-semibold ${isFullscreen ? "text-white" : "text-[var(--tv-text)]"}`}
              >
                收藏到歌单
              </span>
              <PlatformBadge platform={song.platform} subtle />
            </div>

            {canCreate && (
              <div className="mt-1 px-1">
                {!creating ? (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium transition-colors ${
                      isFullscreen
                        ? "text-white/85 hover:bg-white/10 hover:text-white"
                        : "text-[var(--tv-accent)] hover:bg-[var(--tv-accent-soft)]"
                    }`}
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0" />
                    <span>新建歌单并收藏</span>
                  </button>
                ) : (
                  <form onSubmit={handleCreateSubmit} className="flex items-center gap-1.5 py-1">
                    <input
                      ref={inputRef}
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="输入新歌单名称"
                      aria-label="新歌单名称"
                      maxLength={60}
                      className={`h-7 min-w-0 flex-1 rounded-md px-2 text-xs focus:outline-none ${
                        isFullscreen
                          ? "border border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:border-white/45"
                          : "border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-accent)]"
                      }`}
                    />
                    <button
                      type="submit"
                      disabled={!newName.trim() || isBusy}
                      className="h-7 shrink-0 rounded-md bg-[var(--tv-accent)] px-2.5 text-xs font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-45"
                    >
                      {createAndCollectMutation.isPending ? "..." : "创建"}
                    </button>
                  </form>
                )}
              </div>
            )}

            <div
              className={`my-1 border-t ${isFullscreen ? "border-white/10" : "border-[var(--tv-border)]"}`}
            />

            <div
              className={`max-h-52 overflow-y-auto space-y-0.5 ${isFullscreen ? "tv-subtle-scrollbar" : ""}`}
            >
              {playlistsQuery.isLoading ? (
                <div
                  className={`flex items-center justify-center gap-1.5 px-2.5 py-5 text-xs ${
                    isFullscreen ? "text-white/60" : "text-[var(--tv-text-muted)]"
                  }`}
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>正在加载歌单...</span>
                </div>
              ) : playlistsQuery.isError ? (
                <div
                  className={`space-y-1.5 px-2.5 py-4 text-center text-xs ${
                    isFullscreen ? "text-white/65" : "text-[var(--tv-text-muted)]"
                  }`}
                >
                  <div>歌单加载失败</div>
                  <button
                    type="button"
                    onClick={() => void playlistsQuery.refetch()}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                      isFullscreen
                        ? "bg-white/15 text-white hover:bg-white/25"
                        : "bg-[var(--tv-surface)] text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
                    }`}
                  >
                    重试
                  </button>
                </div>
              ) : ownedPlaylists.length === 0 ? (
                <div
                  className={`px-2.5 py-4 text-center text-xs ${
                    isFullscreen ? "text-white/55" : "text-[var(--tv-text-muted)]"
                  }`}
                >
                  暂无可写入的自建歌单
                </div>
              ) : (
                ownedPlaylists.map((pl) => (
                  <button
                    key={pl.id}
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      addMutation.mutate({
                        playlistId: pl.id,
                        playlistName: pl.name,
                        targetSong: song,
                      })
                    }
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors disabled:opacity-50 ${
                      isFullscreen
                        ? "text-white/90 hover:bg-white/10 hover:text-white"
                        : "text-[var(--tv-text)] hover:bg-[var(--tv-surface-hover)]"
                    }`}
                  >
                    <CoverArt
                      src={pl.coverUrl}
                      alt={pl.name}
                      darkBackdrop={isFullscreen}
                      className="h-7 w-7"
                      rounded="rounded-md"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{pl.name}</div>
                      <div
                        className={`text-[10.5px] ${
                          isFullscreen ? "text-white/45" : "text-[var(--tv-text-subtle)]"
                        }`}
                      >
                        {pl.trackCount} 首
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
