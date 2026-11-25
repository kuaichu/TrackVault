import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../../shared/api/endpoints.js";
import { toast } from "../../../shared/store/toast-store.js";
import { TRANSFER_INPUT_CLASS } from "../transfer-constants.js";

export function AuditForm({ onJobCreated }: { onJobCreated: (jobId: string) => void }) {
  const queryClient = useQueryClient();
  const [auditPlaylistId, setAuditPlaylistId] = useState("");
  const [auditPlaylistName, setAuditPlaylistName] = useState("");
  const [auditCheckAvailability, setAuditCheckAvailability] = useState(false);

  const startAuditMutation = useMutation({
    mutationFn: () =>
      api.startImportAuditJob({
        playlistId: auditPlaylistId.trim(),
        playlistName: auditPlaylistName.trim() || undefined,
        maxTracks: 300,
        candidateLimit: 5,
        checkAvailability: auditCheckAvailability,
      }),
    onSuccess: ({ job }) => {
      onJobCreated(job.id);
      toast.success("已开始可用性检测");
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "提交失败"),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[220px] flex-1 space-y-1.5 text-xs">
          <span className="font-medium text-[var(--tv-text-muted)]">网易云歌单 ID</span>
          <input
            type="text"
            value={auditPlaylistId}
            onChange={(e) => setAuditPlaylistId(e.target.value)}
            placeholder="输入需要检测的网易云歌单 ID"
            className={TRANSFER_INPUT_CLASS}
          />
        </label>
        <label className="min-w-[180px] flex-1 space-y-1.5 text-xs">
          <span className="font-medium text-[var(--tv-text-muted)]">备注名称（可选）</span>
          <input
            type="text"
            value={auditPlaylistName}
            onChange={(e) => setAuditPlaylistName(e.target.value)}
            placeholder="便于区分任务"
            className={TRANSFER_INPUT_CLASS}
          />
        </label>
        <button
          type="button"
          disabled={!auditPlaylistId.trim() || startAuditMutation.isPending}
          onClick={() => startAuditMutation.mutate()}
          className="h-[38px] rounded-lg bg-[var(--tv-accent)] px-5 text-xs font-semibold text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
        >
          开始检测
        </button>
      </div>
      <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--tv-text-muted)] select-none">
        <input
          type="checkbox"
          checked={auditCheckAvailability}
          onChange={(e) => setAuditCheckAvailability(e.target.checked)}
          className="h-3.5 w-3.5 rounded accent-[var(--tv-accent)]"
        />
        <span>实测音源可用性（较慢，可识别仅试听曲目）</span>
      </label>
    </div>
  );
}
