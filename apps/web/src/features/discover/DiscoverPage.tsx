import { useQuery } from "@tanstack/react-query";
import { Compass, RefreshCw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { MusicPlatform } from "#shared";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";

export function DiscoverPage() {
  const [section, setSection] = useState<"discover" | "daily">("discover");
  const [platform, setPlatform] = useState<MusicPlatform>("netease");

  const discoverQuery = useQuery({
    queryKey: ["discover", platform],
    queryFn: () => api.getDiscover(platform),
    enabled: section === "discover",
  });

  const dailyQuery = useQuery({
    queryKey: ["daily-recommend"],
    queryFn: () => api.getDailyRecommend(),
    enabled: section === "daily",
  });

  const activeQuery = section === "discover" ? discoverQuery : dailyQuery;
  const songs = activeQuery.data?.songs ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">发现音乐</h1>
          <p className="text-xs text-[var(--tv-text-muted)]">
            按平台独立缓存，绝不跨用户混用个性化推荐与 VIP 权限状态
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-1 text-xs">
            <button
              type="button"
              onClick={() => setSection("discover")}
              className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 ${
                section === "discover" ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
              }`}
            >
              <Compass className="h-3.5 w-3.5" />
              新歌发现
            </button>
            <button
              type="button"
              onClick={() => setSection("daily")}
              className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 ${
                section === "daily" ? "bg-amber-400/15 text-amber-300" : "text-[var(--tv-text-muted)]"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              网易云日推
            </button>
          </div>

          {section === "discover" && (
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as MusicPlatform)}
              className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] px-3 py-2 text-xs text-white focus:border-amber-400/60 focus:outline-none"
            >
              <option value="netease">网易云音乐</option>
              <option value="qq">QQ 音乐</option>
            </select>
          )}

          <button
            type="button"
            onClick={() => void activeQuery.refetch()}
            className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-2 text-[var(--tv-text-muted)] hover:text-white"
            title="刷新"
          >
            <RefreshCw className={`h-4 w-4 ${activeQuery.isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {activeQuery.isError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-5 text-sm text-rose-200">
          {activeQuery.error instanceof Error ? activeQuery.error.message : "加载推荐歌曲失败"}
        </div>
      ) : activeQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">正在加载歌曲...</div>
      ) : (
        <SongTable songs={songs} emptyText="暂无推荐曲目，请检查平台账号绑定状态" />
      )}
    </div>
  );
}
