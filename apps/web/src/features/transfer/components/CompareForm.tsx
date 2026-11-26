import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { MusicPlatform } from "#shared";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { AppleSelect } from "../../../shared/ui/primitives.js";
import { TRANSFER_INPUT_CLASS } from "../transfer-constants.js";

const COMPARE_PLATFORM_OPTIONS: ReadonlyArray<{ value: MusicPlatform; label: string }> = [
  { value: "netease", label: "网易云" },
  { value: "qq", label: "QQ 音乐" },
  { value: "kugou", label: "酷狗音乐" },
];

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
            <AppleSelect
              ariaLabel="歌单 A 平台"
              variant="field"
              value={leftProvider}
              options={COMPARE_PLATFORM_OPTIONS}
              onChange={setLeftProvider}
              className="shrink-0"
            />
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
            <AppleSelect
              ariaLabel="歌单 B 平台"
              variant="field"
              value={rightProvider}
              options={COMPARE_PLATFORM_OPTIONS}
              onChange={setRightProvider}
              className="shrink-0"
            />
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
