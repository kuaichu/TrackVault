import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, QrCode, Shield, Unlink } from "lucide-react";
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
  const [qrState, setQrState] = useState<{ key: string; qrImage: string; message: string } | null>(null);

  const label = platform === "netease" ? "网易云音乐" : "QQ 音乐";

  const bindMutation = useMutation({
    mutationFn: () => api.bindPlatformCookie(platform, cookieDraft),
    onSuccess: (res) => {
      setCookieDraft("");
      toast.success(res.binding.message ?? `${label}绑定成功`);
      void queryClient.invalidateQueries({ queryKey: ["bindings"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : `${label}绑定失败`),
  });

  const unbindMutation = useMutation({
    mutationFn: () => api.unbindPlatform(platform),
    onSuccess: () => {
      toast.info(`已解绑${label}并清除服务端密文凭证`);
      void queryClient.invalidateQueries({ queryKey: ["bindings"] });
    },
  });

  const startQrMutation = useMutation({
    mutationFn: () => api.startQrLogin(platform),
    onSuccess: (res) => {
      setQrState({ key: res.key, qrImage: res.qrImage, message: "请使用手机 App 扫描二维码" });
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
    <div className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-white">{label}</h3>
            {binding.connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                已加密绑定
              </span>
            ) : (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-[var(--tv-text-muted)]">
                未绑定
              </span>
            )}
          </div>
          {binding.connected && (
            <p className="mt-1 text-xs text-[var(--tv-text-muted)]">
              账号：{binding.displayName ?? binding.accountUid ?? "已连接"}
              {binding.vipEnabled ? " · VIP 有效" : " · 普通账号"}
              {binding.vipExpireAt
                ? ` · 到期 ${new Date(binding.vipExpireAt).toLocaleDateString("zh-CN")}`
                : ""}
            </p>
          )}
        </div>

        {binding.connected && (
          <button
            type="button"
            onClick={() => unbindMutation.mutate()}
            className="inline-flex items-center gap-1 rounded-xl border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
          >
            <Unlink className="h-3.5 w-3.5" />
            解绑
          </button>
        )}
      </div>

      {/* QR Login */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => startQrMutation.mutate()}
          disabled={startQrMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface-elevated)] px-3 py-1.5 text-xs font-medium text-white hover:border-amber-400/50"
        >
          <QrCode className="h-3.5 w-3.5 text-amber-400" />
          {startQrMutation.isPending ? "生成中..." : "扫码绑定"}
        </button>
        {qrState && (
          <button
            type="button"
            onClick={() => setQrState(null)}
            className="text-xs text-[var(--tv-text-muted)] hover:text-white"
          >
            取消扫码
          </button>
        )}
      </div>

      {qrState && (
        <div className="flex items-center gap-4 rounded-xl border border-amber-400/25 bg-black/30 p-3">
          <img
            src={qrState.qrImage}
            alt={`${label}登录二维码`}
            className="h-28 w-28 rounded-lg bg-white p-1"
          />
          <div className="text-xs text-[var(--tv-text-muted)] space-y-1">
            <div className="font-medium text-amber-300">{qrState.message}</div>
            <div>扫码成功后 Cookie 将直接由服务端加密保存，不会回传浏览器。</div>
          </div>
        </div>
      )}

      {/* Safe manual cookie import (write-only input; never prefilled from server) */}
      <div className="space-y-2">
        <label
          htmlFor={`cookie-input-${platform}`}
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--tv-text-muted)]"
        >
          <KeyRound className="h-3.5 w-3.5" />
          或手动粘贴凭证（仅写入服务端密文库，保存后自动清空输入框）
        </label>
        <textarea
          id={`cookie-input-${platform}`}
          rows={2}
          value={cookieDraft}
          onChange={(e) => setCookieDraft(e.target.value)}
          placeholder={
            platform === "netease"
              ? "粘贴 MUSIC_U=... 完整 Cookie"
              : "粘贴包含 uin 与 qm_keyst / qqmusic_key 的 Cookie（服务端仅保留必需鉴权键）"
          }
          className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] p-2.5 text-xs text-white focus:border-amber-400/60 focus:outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--tv-text-subtle)]">
            <Shield className="h-3 w-3" />
            AES-256-GCM 静态加密 · 实时上游验真
          </span>
          <button
            type="button"
            disabled={!cookieDraft.trim() || bindMutation.isPending}
            onClick={() => bindMutation.mutate()}
            className="rounded-xl bg-amber-400 px-3.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
          >
            {bindMutation.isPending ? "验证并加密保存..." : "验证并绑定"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BindingsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });

  if (isLoading || !data) {
    return <div className="text-sm text-[var(--tv-text-muted)]">加载绑定状态中...</div>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlatformCard platform="netease" binding={data.bindings.netease} />
      <PlatformCard platform="qq" binding={data.bindings.qq} />
    </div>
  );
}
