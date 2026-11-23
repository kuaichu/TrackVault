import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Play, Search, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { EntitySearchType, ProviderMode } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { CoverArt, EmptyState, PlatformBadge, SegmentedTabs } from "../../shared/ui/primitives.js";

type SearchTab = "song" | EntitySearchType;

export function SearchPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const urlQ = searchParams.get("q") ?? "";
  const rawMode = searchParams.get("mode");
  const hasExplicitMode = rawMode === "netease" || rawMode === "qq" || rawMode === "aggregate";
  const loadedDefaultMode = settingsQuery.data?.settings.providerMode;
  const defaultMode: ProviderMode = loadedDefaultMode ?? "aggregate";
  const mode: ProviderMode = hasExplicitMode ? rawMode : defaultMode;

  const rawType = searchParams.get("type");
  const tab: SearchTab =
    rawType === "artist" || rawType === "album" || rawType === "playlist" ? rawType : "song";

  const [inputValue, setInputValue] = useState(urlQ);

  // Only sync draft input when the URL keyword itself changes (preserving uncommitted drafts on mode/type switches)
  useEffect(() => {
    setInputValue(urlQ);
  }, [urlQ]);

  const activeQuery = urlQ.trim();
  const modeReady = hasExplicitMode || !settingsQuery.isLoading;

  const songSearchQuery = useQuery({
    queryKey: ["search", activeQuery, mode],
    queryFn: ({ signal }) => api.searchSongs(activeQuery, mode, signal),
    enabled: Boolean(activeQuery && tab === "song" && modeReady),
  });

  const entitySearchQuery = useQuery({
    queryKey: ["search-entities", activeQuery, mode, tab],
    queryFn: ({ signal }) => api.searchEntities(activeQuery, mode, tab as EntitySearchType, signal),
    enabled: Boolean(activeQuery && tab !== "song" && modeReady),
  });

  const historyQuery = useQuery({
    queryKey: ["search-history"],
    queryFn: () => api.getSearchHistory(),
  });

  const addHistoryMutation = useMutation({
    mutationFn: (keyword: string) => api.addSearchHistory(keyword),
    onSuccess: (res) => queryClient.setQueryData(["search-history"], res),
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存搜索历史失败"),
  });

  const removeHistoryMutation = useMutation({
    mutationFn: (keyword?: string) => api.removeSearchHistory(keyword),
    onSuccess: (res, keyword) => {
      queryClient.setQueryData(["search-history"], res);
      if (keyword === undefined) {
        toast.info("已清空搜索历史");
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "删除搜索历史失败"),
  });

  const updateParams = (patch: { mode?: ProviderMode; type?: SearchTab }) => {
    const next = new URLSearchParams(searchParams);
    if (patch.mode !== undefined) next.set("mode", patch.mode);
    if (patch.type !== undefined) next.set("type", patch.type);
    setSearchParams(next);
  };

  const triggerSearch = (keyword: string, explicitMode?: ProviderMode, nextTab = tab) => {
    const clean = keyword.trim();
    if (!clean) return;
    const nextParams: Record<string, string> = { q: clean };
    // F07: Only persist `mode` when explicitly chosen or after user settings have loaded,
    // preventing premature fallback to "aggregate" while settingsQuery is still loading.
    const resolvedMode = explicitMode ?? (hasExplicitMode ? rawMode : loadedDefaultMode);
    if (resolvedMode) {
      nextParams.mode = resolvedMode;
    }
    if (nextTab !== "song" || searchParams.has("type")) {
      nextParams.type = nextTab;
    }
    setSearchParams(nextParams);
    addHistoryMutation.mutate(clean);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    triggerSearch(inputValue);
  };

  const historyItems = historyQuery.data?.items ?? [];
  const warnings =
    tab === "song" ? (songSearchQuery.data?.warnings ?? []) : (entitySearchQuery.data?.warnings ?? []);
  const activeQueryResult = tab === "song" ? songSearchQuery : entitySearchQuery;
  const activeLoading = activeQueryResult.isLoading || (Boolean(activeQuery) && !modeReady);
  const activeError = activeQueryResult.isError ? activeQueryResult.error : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">搜索</h1>
        <SegmentedTabs
          value={mode}
          onChange={(next) => updateParams({ mode: next })}
          items={[
            { id: "aggregate", label: "聚合" },
            { id: "netease", label: "网易云" },
            { id: "qq", label: "QQ 音乐" },
          ]}
        />
      </div>

      {/* Spotlight-style Search Bar */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--tv-text-subtle)]" />
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="输入歌名、歌手、专辑或歌单..."
            className="h-11 w-full rounded-xl bg-[var(--tv-surface)] pl-11 pr-10 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] transition-colors focus:bg-[var(--tv-surface-elevated)] focus:ring-1 focus:ring-[var(--tv-border-strong)] focus:outline-none"
          />
          {inputValue && (
            <button
              type="button"
              onClick={() => setInputValue("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
              aria-label="清空输入"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <button
          type="submit"
          className="h-11 shrink-0 rounded-xl bg-[var(--tv-accent)] px-5 text-sm font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)]"
        >
          搜索
        </button>
      </form>

      {/* Entity Category Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedTabs<SearchTab>
          value={tab}
          onChange={(next) => updateParams({ type: next })}
          items={[
            { id: "song", label: "单曲" },
            { id: "artist", label: "歌手" },
            { id: "album", label: "专辑" },
            { id: "playlist", label: "歌单" },
          ]}
        />

        {historyItems.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {historyItems.slice(0, 6).map((keyword) => (
              <span
                key={keyword}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--tv-surface)] px-2.5 py-1 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)]"
              >
                <button
                  type="button"
                  onClick={() => triggerSearch(keyword)}
                  className="hover:text-[var(--tv-text)]"
                >
                  {keyword}
                </button>
                <button
                  type="button"
                  onClick={() => removeHistoryMutation.mutate(keyword)}
                  className="text-[var(--tv-text-subtle)] hover:text-[var(--tv-danger)]"
                  aria-label={`删除 ${keyword}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              disabled={removeHistoryMutation.isPending}
              onClick={() => removeHistoryMutation.mutate(undefined)}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-[var(--tv-text-subtle)] transition-colors hover:bg-[var(--tv-surface)] hover:text-[var(--tv-danger)] disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              清空全部历史
            </button>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl bg-[var(--tv-surface)] px-4 py-3 text-xs text-[var(--tv-text-muted)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--tv-accent)]" />
          <div className="space-y-0.5">
            {warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {!activeQuery ? (
        <EmptyState title="跨平台曲库检索" description="支持检索网易云与 QQ 音乐的单曲、歌手、专辑与歌单。" />
      ) : activeLoading ? (
        <div className="space-y-2">
          {["s1", "s2", "s3", "s4", "s5", "s6"].map((rowId) => (
            <div key={rowId} className="h-12 animate-pulse rounded-lg bg-[var(--tv-surface)]" />
          ))}
        </div>
      ) : activeError ? (
        <EmptyState
          title="搜索未能完成"
          description={activeError instanceof Error ? activeError.message : "请稍后重试"}
          action={
            <button
              type="button"
              onClick={() => void activeQueryResult.refetch()}
              className="inline-flex items-center rounded-lg bg-[var(--tv-accent)] px-4 py-2 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
            >
              重试
            </button>
          }
        />
      ) : tab === "song" ? (
        <SongTable songs={songSearchQuery.data?.results ?? []} emptyText="未找到匹配曲目" />
      ) : tab === "artist" ? (
        (entitySearchQuery.data?.artists.length ?? 0) === 0 ? (
          <EmptyState title="未找到匹配歌手" />
        ) : (
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
            {entitySearchQuery.data?.artists.map((artist) => (
              <button
                key={`${artist.platform}:${artist.id}`}
                type="button"
                onClick={() => navigate(`/artist/${artist.platform}/${encodeURIComponent(artist.id)}`)}
                className="group flex flex-col items-center rounded-xl text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
              >
                <div className="aspect-square w-28 overflow-hidden rounded-full bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl sm:w-36">
                  <CoverArt
                    src={artist.avatarUrl}
                    alt={artist.name}
                    className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                    rounded="rounded-full"
                  />
                </div>
                <div className="mt-3 line-clamp-1 text-sm font-semibold text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                  {artist.name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
                  <PlatformBadge platform={artist.platform} subtle />
                  {typeof artist.albumCount === "number" && (
                    <span className="tabular-nums">· {artist.albumCount} 专辑</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )
      ) : tab === "album" ? (
        (entitySearchQuery.data?.albums.length ?? 0) === 0 ? (
          <EmptyState title="未找到匹配专辑" />
        ) : (
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
            {entitySearchQuery.data?.albums.map((alb) => (
              <button
                key={`${alb.platform}:${alb.id}`}
                type="button"
                onClick={() => navigate(`/album/${alb.platform}/${encodeURIComponent(alb.id)}`)}
                className="group rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tv-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tv-bg)]"
              >
                <div className="aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                  <CoverArt
                    src={alb.coverUrl}
                    alt={alb.name}
                    className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                    rounded="rounded-none"
                  />
                </div>
                <div className="mt-2.5 line-clamp-1 text-[13.5px] font-semibold text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                  {alb.name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
                  <span className="truncate">{alb.artistName}</span>
                  <PlatformBadge platform={alb.platform} subtle />
                </div>
              </button>
            ))}
          </div>
        )
      ) : (entitySearchQuery.data?.playlists.length ?? 0) === 0 ? (
        <EmptyState title="未找到匹配歌单" />
      ) : (
        <div className="grid grid-cols-2 gap-x-3.5 gap-y-5 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5">
          {entitySearchQuery.data?.playlists.map((pl) => (
            <button
              key={`${pl.platform}:${pl.id}`}
              type="button"
              onClick={() =>
                navigate(`/playlists/${pl.platform}/${encodeURIComponent(pl.id)}`, {
                  state: { playlist: pl },
                })
              }
              className="group text-left focus:outline-none"
            >
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-[var(--tv-surface)] shadow-md transition-shadow duration-300 group-hover:shadow-xl">
                <CoverArt
                  src={pl.coverUrl}
                  alt={pl.name}
                  className="h-full w-full transition-transform duration-300 group-hover:scale-[1.04]"
                  rounded="rounded-none"
                />
                <span className="absolute bottom-3 right-3 flex h-9 w-9 translate-y-1.5 items-center justify-center rounded-full bg-white/90 text-[#111113] opacity-0 shadow-lg backdrop-blur-md transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
                  <Play className="ml-0.5 h-4 w-4 fill-current" />
                </span>
              </div>
              <div className="mt-2.5 line-clamp-2 text-[13.5px] font-semibold leading-snug text-[var(--tv-text)] group-hover:text-[var(--tv-accent)]">
                {pl.name}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
                <span className="tabular-nums">{pl.trackCount} 首</span>
                <PlatformBadge platform={pl.platform} subtle />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
