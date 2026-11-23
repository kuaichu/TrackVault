import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, QrCode, Unlink } from "lucide-react";
import { useEffect, useState } from "react";
import type { MusicPlatform, PlatformBindingView } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

function PlatformCard({
  platform,
  binding,
}: {
  platform: MusicPlatform;
  binding: PlatformBindingView;
}) {
  const queryClient = useQueryClient();
  const [cookieDraft, setCookieDraft] = useState("");
  const [showManualCookie, setShowManualCookie] = useState(false);
  const [qrState, setQrState] = useState<{ key: string; qrImage: string; message: string } | null>(null);

  const label = platform === "netease" ? "网易云音乐" : "QQ 音乐";
  const dotClass = platform === "netease" ? "bg-[var(--tv-netease)]" : "bg-[var(--tv-qq)]";

  const bindMutation = useMutation({
    mutationFn: () => api.bindPlatformCookie(platform, cookieDraft),
    onSuccess: (res) => {
      setCookieDraft("");
      setShowManualCookie(false);
      toast.success(res.binding.message ?? `${label}已连接`);
      void queryClient.invalidateQueries({ queryKey: ["bindings"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : `${label}绑定失败`),
  });

  const unbindMutation = useMutation({
    mutationFn: () => api.unbindPlatform(platform),
    onSuccess: () => {
      toast.info(`已解绑${label}`);
      void queryClient.invalidateQueries({ queryKey: ["bindings"] });
    },
  });

  const startQrMutation = useMutation({
    mutationFn: () => api.startQrLogin(platform),
    onSuccess: (res) => {
      setQrState({ key: res.key, qrImage: res.qrImage, message: "请打开手机客户端扫描" });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "生成二维码失败"),
  });

  const qrKey = qrState?.key ?? null;
  useEffect(() => {
    if (!qrKey) return;
    const timer = window.setInterval(() => {
      void api
        .checkQrLogin(platform, qrKey)
        .then((res) => {
          if (res.status === "confirmed") {
            setQrState(null);
            toast.success(res.message);
            void queryClient.invalidateQueries({ queryKey: ["bindings"] });
          } else if (res.status === "expired" || res.status === "error") {
            setQrState(null);
            toast.error(res.message);
          } else {
            setQrState((prev) => (prev ? { ...prev, message: res.message } : null));
          }
        })
        .catch(() => undefined);
    }, 2500);

    return () => window.clearInterval(timer);
  }, [platform, qrKey, queryClient]);

  return (
    <div className="rounded-2xl bg-[var(--tv-surface)] p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${dotClass}`} />
            <h3 className="text-[15px] font-semibold text-[var(--tv-text)]">{label}</h3>
            <span className="text-xs text-[var(--tv-text-subtle)]">
              {binding.connected ? "· 已连接" : "· 未连接"}
            </span>
          </div>
          {binding.connected && (
            <p className="mt-1 text-xs text-[var(--tv-text-muted)]">
              {binding.displayName ?? binding.accountUid ?? "已登录"}
              {binding.vipEnabled ? " · VIP" : ""}
              {binding.vipExpireAt
                ? ` · 至 ${new Date(binding.vipExpireAt).toLocaleDateString("zh-CN")}`
                : ""}
            </p>
          )}
        </div>

        {binding.connected && (
          <button
            type="button"
            onClick={() => unbindMutation.mutate()}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-danger)]"
          >
            <Unlink className="h-3.5 w-3.5" />
            解绑
          </button>
        )}
      </div>

      {/* Primary Action: QR Login + Secondary Collapsible Cookie Import */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => startQrMutation.mutate()}
          disabled={startQrMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-contrast-bg)] px-3.5 py-1.5 text-xs font-medium text-[var(--tv-contrast-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <QrCode className="h-3.5 w-3.5" />
          {startQrMutation.isPending ? "生成中..." : binding.connected ? "重新扫码" : "扫码登录"}
        </button>

        <button
          type="button"
          onClick={() => setShowManualCookie((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-text)]"
        >
          手动粘贴 Cookie
          {showManualCookie ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        {qrState && (
          <button
            type="button"
            onClick={() => setQrState(null)}
            className="ml-auto text-xs text-[var(--tv-text-subtle)] hover:text-[var(--tv-text)]"
          >
            取消
          </button>
        )}
      </div>

      {qrState && (
        <div className="flex items-center gap-4 rounded-xl bg-[var(--tv-bg)] p-3.5">
          <img
            src={qrState.qrImage}
            alt={`${label}登录二维码`}
            className="h-28 w-28 rounded-lg bg-white p-1.5"
          />
          <div className="space-y-1 text-xs">
            <div className="font-medium text-[var(--tv-text)]">{qrState.message}</div>
            <div className="text-[var(--tv-text-muted)]">扫码确认后自动保存，无需手动复制。</div>
          </div>
        </div>
      )}

      {showManualCookie && (
        <div className="space-y-2.5 border-t border-[var(--tv-border)] pt-3.5">
          <label
            htmlFor={`cookie-input-${platform}`}
            className="block text-xs font-medium text-[var(--tv-text-muted)]"
          >
            {platform === "netease" ? "粘贴包含 MUSIC_U 的 Cookie" : "粘贴包含 uin 与 qm_keyst 的 Cookie"}
          </label>
          <textarea
            id={`cookie-input-${platform}`}
            rows={2}
            value={cookieDraft}
            onChange={(e) => setCookieDraft(e.target.value)}
            placeholder={platform === "netease" ? "MUSIC_U=..." : "uin=...; qm_keyst=..."}
            className="w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] p-2.5 font-mono text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!cookieDraft.trim() || bindMutation.isPending}
              onClick={() => bindMutation.mutate()}
              className="rounded-lg bg-[var(--tv-accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
            >
              {bindMutation.isPending ? "验证中..." : "验证并绑定"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function BindingsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });

  if (isLoading || !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlatformCard platform="netease" binding={data.bindings.netease} />
      <PlatformCard platform="qq" binding={data.bindings.qq} />
    </div>
  );
}
