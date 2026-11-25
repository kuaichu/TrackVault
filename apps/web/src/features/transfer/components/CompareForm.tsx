import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { MusicPlatform } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { TRANSFER_INPUT_CLASS } from "../transfer-constants.js";

export function CompareForm({ onJobCreated }: { onJobCreated: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [leftProvider, setLeftProvider] = useState<MusicPlatform>("netease");
  const [leftPlaylistId, setLeftPlaylistId] = useState("");
  const [rightProvider, setRightProvider] = useState<MusicPlatform>("qq");
  const [rightPlaylistId, setRightPlaylistId] = useState("");

  const startCompareMutation = useMutation({
    mutationFn: () =>
      api.startCompareJob({
        leftProvider,
        leftPlaylistId: leftPlaylistId.trim(),
        rightProvider,
        rightPlaylistId: rightPlaylistId.trim(),
      }),
    onSuccess: ({ job }) => {
      onJobCreated(job.id);
      toast.success("已开始双歌单对比");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-[var(--tv-text-muted)]">歌单 A</div>
          <div className="flex gap-2">
            <select
              value={leftProvider}
              onChange={(e) => setLeftProvider(e.target.value as MusicPlatform)}
              className="shrink-0 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
            >
              <option value="netease">网易云</option>
              <option value="qq">QQ 音乐</option>
            </select>
            <input
              type="text"
              value={leftPlaylistId}
              onChange={(e) => setLeftPlaylistId(e.target.value)}
              placeholder="歌单 ID"
              className={TRANSFER_INPUT_CLASS}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-[var(--tv-text-muted)]">歌单 B</div>
          <div className="flex gap-2">
            <select
              value={rightProvider}
              onChange={(e) => setRightProvider(e.target.value as MusicPlatform)}
              className="shrink-0 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-2 text-xs text-[var(--tv-text)] focus:outline-none"
            >
              <option value="netease">网易云</option>
              <option value="qq">QQ 音乐</option>
            </select>
            <input
              type="text"
              value={rightPlaylistId}
              onChange={(e) => setRightPlaylistId(e.target.value)}
              placeholder="歌单 ID"
              className={TRANSFER_INPUT_CLASS}
            />
          </div>
        </div>
      </div>

      <button
        type="button"
        disabled={!leftPlaylistId.trim() || !rightPlaylistId.trim() || startCompareMutation.isPending}
        onClick={() => startCompareMutation.mutate()}
        className="rounded-lg bg-[var(--tv-accent)] px-5 py-2 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
      >
        开始对比
      </button>
    </div>
  );
}
