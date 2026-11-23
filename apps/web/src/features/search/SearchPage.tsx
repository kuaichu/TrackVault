import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Search, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ProviderMode } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";

export function SearchPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const initialMode = (searchParams.get("mode") as ProviderMode | null) ?? "aggregate";

  const [inputValue, setInputValue] = useState(initialQ);
  const [mode, setMode] = useState<ProviderMode>(
    initialMode === "netease" || initialMode === "qq" || initialMode === "aggregate"
      ? initialMode
      : "aggregate",
  );

  useEffect(() => {
    setInputValue(searchParams.get("q") ?? "");
  }, [searchParams]);

  const activeQuery = (searchParams.get("q") ?? "").trim();

  const searchQuery = useQuery({
    queryKey: ["search", activeQuery, mode],
    queryFn: ({ signal }) => api.searchSongs(activeQuery, mode, signal),
    enabled: Boolean(activeQuery),
  });

  const historyQuery = useQuery({
    queryKey: ["search-history"],
    queryFn: () => api.getSearchHistory(),
  });

  const addHistoryMutation = useMutation({
    mutationFn: (keyword: string) => api.addSearchHistory(keyword),
    onSuccess: (res) => queryClient.setQueryData(["search-history"], res),
  });

  const removeHistoryMutation = useMutation({
    mutationFn: (keyword?: string) => api.removeSearchHistory(keyword),
    onSuccess: (res) => queryClient.setQueryData(["search-history"], res),
  });

  const triggerSearch = (keyword: string, nextMode = mode) => {
    const clean = keyword.trim();
    if (!clean) return;
    setSearchParams({ q: clean, mode: nextMode });
    addHistoryMutation.mutate(clean);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    triggerSearch(inputValue);
  };

  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--tv-text-subtle)]" />
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="搜索歌曲、歌手或专辑..."
            className="w-full rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] py-2.5 pl-10 pr-4 text-sm text-white focus:border-amber-400/60 focus:outline-none"
          />
        </div>

        <select
          value={mode}
          onChange={(e) => {
            const next = e.target.value as ProviderMode;
            setMode(next);
            if (activeQuery) setSearchParams({ q: activeQuery, mode: next });
          }}
          className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] px-3.5 py-2.5 text-sm text-white focus:border-amber-400/60 focus:outline-none"
        >
          <option value="aggregate">双平台聚合</option>
          <option value="netease">仅网易云音乐</option>
          <option value="qq">仅 QQ 音乐</option>
        </select>

        <button
          type="submit"
          className="rounded-2xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-300"
        >
          搜索
        </button>
      </form>

      {(historyQuery.data?.items.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--tv-text-subtle)]">最近搜索：</span>
          {historyQuery.data?.items.map((keyword) => (
            <span
              key={keyword}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1 text-xs text-[var(--tv-text-muted)]"
            >
              <button type="button" onClick={() => triggerSearch(keyword)} className="hover:text-amber-300">
                {keyword}
              </button>
              <button
                type="button"
                onClick={() => removeHistoryMutation.mutate(keyword)}
                className="text-[var(--tv-text-subtle)] hover:text-rose-300"
                aria-label={`删除 ${keyword}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {(searchQuery.data?.warnings.length ?? 0) > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-950/30 p-3 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-0.5">
            {searchQuery.data?.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        </div>
      )}

      {!activeQuery ? (
        <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] py-16 text-center text-sm text-[var(--tv-text-muted)]">
          输入关键词开始跨平台搜索
        </div>
      ) : searchQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">搜索中...</div>
      ) : searchQuery.isError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-5 text-sm text-rose-200">
          {searchQuery.error instanceof Error ? searchQuery.error.message : "搜索失败"}
        </div>
      ) : (
        <SongTable songs={searchQuery.data?.results ?? []} emptyText="未找到匹配歌曲" />
      )}
    </div>
  );
}
