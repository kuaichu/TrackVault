import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, History, Trash2 } from "lucide-react";
import { SongTable } from "../../entities/song/SongTable.js";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

export function CloudPage() {
  const cloudQuery = useQuery({
    queryKey: ["cloud-songs"],
    queryFn: () => api.getCloudSongs(),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5">
        <Cloud className="h-5 w-5 text-sky-400" />
        <div>
          <h1 className="text-xl font-semibold text-white">网易云盘</h1>
          <p className="text-xs text-[var(--tv-text-muted)]">云盘个人文件自动绕过曲库版权锁</p>
        </div>
      </div>

      {cloudQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">加载云盘歌曲中...</div>
      ) : cloudQuery.isError ? (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-950/30 p-5 text-sm text-rose-200">
          {cloudQuery.error instanceof Error ? cloudQuery.error.message : "加载云盘失败"}
        </div>
      ) : (
        <SongTable songs={cloudQuery.data?.songs ?? []} emptyText="云盘中暂无歌曲" />
      )}
    </div>
  );
}

export function HistoryPage() {
  const queryClient = useQueryClient();
  const historyQuery = useQuery({
    queryKey: ["play-history"],
    queryFn: () => api.getPlayHistory(),
  });

  const clearMutation = useMutation({
    mutationFn: () => api.clearPlayHistory(),
    onSuccess: (res) => {
      queryClient.setQueryData(["play-history"], res);
      toast.info("已清空播放历史");
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <History className="h-5 w-5 text-amber-400" />
          <div>
            <h1 className="text-xl font-semibold text-white">播放历史</h1>
            <p className="text-xs text-[var(--tv-text-muted)]">按当前登录成员隔离，最多保留最近 100 首</p>
          </div>
        </div>
        {(historyQuery.data?.items.length ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => clearMutation.mutate()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            清空历史
          </button>
        )}
      </div>

      {historyQuery.isLoading ? (
        <div className="py-16 text-center text-sm text-[var(--tv-text-muted)]">加载中...</div>
      ) : (
        <SongTable songs={historyQuery.data?.items ?? []} emptyText="暂无播放记录" />
      )}
    </div>
  );
}
