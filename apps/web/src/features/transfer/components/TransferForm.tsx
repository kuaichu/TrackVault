import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { MusicPlatform } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { TRANSFER_INPUT_CLASS } from "../transfer-constants.js";

export function TransferForm({ onJobCreated }: { onJobCreated: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [sourceProvider, setSourceProvider] = useState<"netease" | "qq" | "text" | "csv">("text");
  const [targetProvider, setTargetProvider] = useState<MusicPlatform>("netease");
  const [playlistId, setPlaylistId] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [rawText, setRawText] = useState("");
  const [checkAvailability, setCheckAvailability] = useState(false);

  const canStartTransfer =
    sourceProvider === "netease" || sourceProvider === "qq"
      ? playlistId.trim().length > 0
      : rawText.trim().length > 0;

  const startTransferMutation = useMutation({
    mutationFn: () =>
      api.startTransferJob({
        sourceProvider,
        targetProvider,
        playlistId: sourceProvider === "netease" || sourceProvider === "qq" ? playlistId.trim() : undefined,
        playlistName: playlistName.trim() || undefined,
        rawText: sourceProvider === "text" || sourceProvider === "csv" ? rawText : undefined,
        checkAvailability,
      }),
    onSuccess: ({ job }) => {
      onJobCreated(job.id);
      toast.success("已开始歌单匹配");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="space-y-1.5 text-xs">
          <span className="font-medium text-[var(--tv-text-muted)]">来源</span>
          <select
            value={sourceProvider}
            onChange={(e) => setSourceProvider(e.target.value as typeof sourceProvider)}
            className={TRANSFER_INPUT_CLASS}
          >
            <option value="text">纯文本曲目列表</option>
            <option value="csv">CSV 表格</option>
            <option value="netease">网易云歌单 ID</option>
            <option value="qq">QQ 音乐歌单 ID</option>
          </select>
        </label>

        <label className="space-y-1.5 text-xs">
          <span className="font-medium text-[var(--tv-text-muted)]">目标平台</span>
          <select
            value={targetProvider}
            onChange={(e) => setTargetProvider(e.target.value as MusicPlatform)}
            className={TRANSFER_INPUT_CLASS}
          >
            <option value="netease">网易云音乐</option>
            <option value="qq">QQ 音乐</option>
          </select>
        </label>

        <label className="space-y-1.5 text-xs">
          <span className="font-medium text-[var(--tv-text-muted)]">新歌单名称（可选）</span>
          <input
            type="text"
            value={playlistName}
            onChange={(e) => setPlaylistName(e.target.value)}
            placeholder="用于导出或一键建单"
            className={TRANSFER_INPUT_CLASS}
          />
        </label>
      </div>

      {sourceProvider === "netease" || sourceProvider === "qq" ? (
        <input
          type="text"
          value={playlistId}
          onChange={(e) => setPlaylistId(e.target.value)}
          placeholder="输入源平台歌单 ID"
          className={TRANSFER_INPUT_CLASS}
        />
      ) : (
        <textarea
          rows={5}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          placeholder={"每行一首曲目，例如：\n1. 晴天 - 周杰伦 - 叶惠美\n2. 七里香 - 周杰伦"}
          className={`${TRANSFER_INPUT_CLASS} font-mono text-xs`}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--tv-text-muted)] select-none">
          <input
            type="checkbox"
            checked={checkAvailability}
            onChange={(e) => setCheckAvailability(e.target.checked)}
            className="h-3.5 w-3.5 rounded accent-[var(--tv-accent)]"
          />
          <span>实测音源可用性（较慢，可识别仅试听曲目）</span>
        </label>

        <button
          type="button"
          disabled={!canStartTransfer || startTransferMutation.isPending}
          onClick={() => startTransferMutation.mutate()}
          className="rounded-lg bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
        >
          开始匹配
        </button>
      </div>
    </>
  );
}
