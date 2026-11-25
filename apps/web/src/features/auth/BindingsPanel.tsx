import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, QrCode, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MusicPlatform, PlatformBindingView } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { useCapabilities } from "../../shared/hooks/use-capabilities.js";
import { toast } from "../../shared/store/toast-store.js";
import { audioEngine } from "../player/index.js";

const PLATFORM_SCOPED_QUERY_ROOTS = new Set<string>([
  "playlists",
  "playlist-tracks",
  "liked-ids",
  "charts",
  "chart-detail",
  "artist-detail",
  "album-detail",
  "lyrics",
  "comments",
]);

export function shouldInvalidateQueryForPlatformChange(
  queryKey: readonly unknown[],
  platform: MusicPlatform,
): boolean {
  const root = queryKey[0];
  if (typeof root !== "string") return false;

  if (root === "bindings") {
    return true;
  }

  if (PLATFORM_SCOPED_QUERY_ROOTS.has(root)) {
    const keyPlatform = queryKey[1];
    return keyPlatform === undefined || keyPlatform === platform;
  }

  if (root === "discover" || root === "discover-playlists") {
    const keyPlatform = queryKey[1];
    return keyPlatform === undefined || keyPlatform === "aggregate" || keyPlatform === platform;
  }

  if (root === "search" || root === "search-entities") {
    const mode = queryKey[2];
    return mode === undefined || mode === "aggregate" || mode === platform;
  }

  if (root === "daily-recommend" || root === "cloud-songs") {
    return platform === "netease";
  }

  return false;
}

const QR_POLL_INTERVAL_MS = 2500;
const QR_MAX_CONSECUTIVE_ERRORS = 3;

interface QrState {
  key: string;
  qrImage: string;
  message: string;
  error?: string | null;
}

function PlatformCard({
  platform,
  binding,
}: {
  platform: MusicPlatform;
  binding: PlatformBindingView;
}) {
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const canQrLogin = capabilities[platform].canQrLogin;
  const [cookieDraft, setCookieDraft] = useState("");
  const [showManualCookie, setShowManualCookie] = useState(false);
  const [qrState, setQrState] = useState<QrState | null>(null);

  const label = platform === "netease" ? "网易云音乐" : "QQ 音乐";
  const dotClass = platform === "netease" ? "bg-[var(--tv-netease)]" : "bg-[var(--tv-qq)]";

  const invalidateAccountCaches = useCallback(() => {
    audioEngine.resetPlatformFmState(platform);
    void queryClient.invalidateQueries({
      predicate: (query) => shouldInvalidateQueryForPlatformChange(query.queryKey, platform),
    });
  }, [platform, queryClient]);

  const bindMutation = useMutation({
    mutationFn: () => api.bindPlatformCookie(platform, cookieDraft),
    onSuccess: (res) => {
      setCookieDraft("");
      setShowManualCookie(false);
      toast.success(res.binding.message ?? `${label}已连接`);
      invalidateAccountCaches();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : `${label}绑定失败`),
  });

  const unbindMutation = useMutation({
    mutationFn: () => api.unbindPlatform(platform),
    onSuccess: () => {
      toast.info(`已解绑${label}`);
      invalidateAccountCaches();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : `解绑${label}失败`),
  });

  const startQrMutation = useMutation({
    mutationFn: () => api.startQrLogin(platform),
    onSuccess: (res) => {
      setQrState({ key: res.key, qrImage: res.qrImage, message: "请打开手机客户端扫描", error: null });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "生成二维码失败"),
  });

  const qrKey = qrState?.key ?? null;
  useEffect(() => {
    if (!qrKey) return;
    let active = true;
    let timerId: number | null = null;
    let controller: AbortController | null = null;
    let consecutiveErrors = 0;

    const scheduleNext = () => {
      if (!active) return;
      timerId = window.setTimeout(() => {
        void pollOnce();
      }, QR_POLL_INTERVAL_MS);
    };

    const pollOnce = async () => {
      if (!active) return;
      controller = new AbortController();
      try {
        const res = await api.checkQrLogin(platform, qrKey, controller.signal);
        if (!active) return;
        consecutiveErrors = 0;

        if (res.status === "confirmed") {
          setQrState((prev) => (prev?.key === qrKey ? null : prev));
          toast.success(res.message);
          invalidateAccountCaches();
          return;
        }
        if (res.status === "expired" || res.status === "error") {
          setQrState((prev) => (prev?.key === qrKey ? null : prev));
          toast.error(res.message);
          return;
        }
        setQrState((prev) =>
          prev && prev.key === qrKey ? { ...prev, message: res.message, error: null } : prev,
        );
        scheduleNext();
      } catch (err) {
        if (!active) return;
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        consecutiveErrors += 1;
        const errMsg = err instanceof Error ? err.message : "检查扫码状态失败";
        if (consecutiveErrors >= QR_MAX_CONSECUTIVE_ERRORS) {
          setQrState((prev) =>
            prev && prev.key === qrKey
              ? { ...prev, error: `轮询异常：${errMsg}，请重新生成二维码重试` }
              : prev,
          );
          toast.error(`扫码状态检查失败：${errMsg}`);
          return;
        }
        setQrState((prev) =>
          prev && prev.key === qrKey ? { ...prev, error: `网络波动（${errMsg}），正在自动重试...` } : prev,
        );
        scheduleNext();
      }
    };

    scheduleNext();

    return () => {
      active = false;
      if (timerId !== null) window.clearTimeout(timerId);
      controller?.abort();
    };
  }, [platform, qrKey, invalidateAccountCaches]);

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
            disabled={unbindMutation.isPending}
            onClick={() => unbindMutation.mutate()}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-active)] hover:text-[var(--tv-danger)] disabled:opacity-40"
          >
            <Unlink className="h-3.5 w-3.5" />
            解绑
          </button>
        )}
      </div>

      {/* Primary Action: QR Login + Secondary Collapsible Cookie Import */}
      <div className="flex flex-wrap items-center gap-2">
        {canQrLogin && (
          <button
            type="button"
            onClick={() => startQrMutation.mutate()}
            disabled={startQrMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--tv-contrast-bg)] px-3.5 py-1.5 text-xs font-medium text-[var(--tv-contrast-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <QrCode className="h-3.5 w-3.5" />
            {startQrMutation.isPending ? "生成中..." : binding.connected ? "重新扫码" : "扫码登录"}
          </button>
        )}

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
            {qrState.error ? (
              <div className="text-[var(--tv-danger)]">{qrState.error}</div>
            ) : (
              <div className="text-[var(--tv-text-muted)]">扫码确认后自动保存，无需手动复制。</div>
            )}
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
  const bindingsQuery = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api.listBindings(),
  });

  if (bindingsQuery.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
        <div className="h-32 animate-pulse rounded-2xl bg-[var(--tv-surface)]" />
      </div>
    );
  }

  if (bindingsQuery.isError || !bindingsQuery.data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[var(--tv-surface)] p-5 text-xs">
        <div className="space-y-1">
          <div className="font-medium text-[var(--tv-text)]">未能加载平台绑定状态</div>
          <div className="text-[var(--tv-text-muted)]">
            {bindingsQuery.error instanceof Error ? bindingsQuery.error.message : "请检查网络后重试"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void bindingsQuery.refetch()}
          className="rounded-lg bg-[var(--tv-accent)] px-3.5 py-1.5 font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlatformCard platform="netease" binding={bindingsQuery.data.bindings.netease} />
      <PlatformCard platform="qq" binding={bindingsQuery.data.bindings.qq} />
    </div>
  );
}
