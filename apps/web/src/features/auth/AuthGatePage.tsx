import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Moon, Sun } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { AuthStatus } from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { useThemeStore } from "../../shared/store/theme-store.js";
import { toast } from "../../shared/store/toast-store.js";

export function AuthGatePage({ initialized }: { initialized: boolean }) {
  const queryClient = useQueryClient();
  const resolvedTheme = useThemeStore((s) => s.resolved);
  const toggleLightDark = useThemeStore((s) => s.toggleLightDark);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!initialized) {
        if (password !== confirmPassword) {
          throw new Error("两次输入的密码不一致");
        }
        return api.setupAdmin({ username, password });
      }
      return api.login({ username, password });
    },
    onSuccess: (res) => {
      toast.success(initialized ? "欢迎回来" : "管理员账号已就绪");
      queryClient.setQueryData<AuthStatus>(["auth-status"], {
        initialized: true,
        authenticated: true,
        user: res.user,
      });
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "验证失败，请重试");
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMutation.mutate();
  };

  return (
    <div className="grid min-h-[100dvh] bg-[var(--tv-bg)] text-[var(--tv-text)] lg:grid-cols-[1.08fr_1fr]">
      {/* Left editorial cover panel (always deep vinyl charcoal, tactile music identity) */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-[#141416] p-12 text-[#f5f5f7] lg:flex">
        <div className="tv-vinyl-grooves pointer-events-none absolute inset-0" />
        <div
          className="pointer-events-none absolute -bottom-32 -left-24 h-[460px] w-[460px] rounded-full opacity-25 blur-[110px]"
          style={{ background: "radial-gradient(circle, #fa2d48 0%, transparent 72%)" }}
        />

        <div className="relative flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#fa2d48]">
            <span className="h-2 w-2 rounded-full bg-[#141416]" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">TrackVault</span>
        </div>

        <div className="relative max-w-md space-y-6">
          <h2 className="text-4xl font-bold leading-[1.15] tracking-tight text-white">
            双平台曲库，
            <br />
            归于一处静听。
          </h2>
          <p className="text-sm leading-relaxed text-[#9b9ba3]">
            为个人与小圈子打造的私有音乐播放器，统一浏览、播放、归档你的网易云音乐与 QQ 音乐收藏。
          </p>
        </div>

        <div className="relative grid grid-cols-3 gap-6 border-t border-white/10 pt-6 text-xs">
          <div>
            <div className="font-mono text-[11px] text-[#66666e]">01</div>
            <div className="mt-1 font-medium text-[#e5e5ea]">网易云 · QQ 音乐</div>
          </div>
          <div>
            <div className="font-mono text-[11px] text-[#66666e]">02</div>
            <div className="mt-1 font-medium text-[#e5e5ea]">无损播放与歌词</div>
          </div>
          <div>
            <div className="font-mono text-[11px] text-[#66666e]">03</div>
            <div className="mt-1 font-medium text-[#e5e5ea]">写标签下载与互转</div>
          </div>
        </div>
      </div>

      {/* Right clean borderless form surface */}
      <div className="relative flex flex-col justify-between p-8 sm:p-12">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 lg:invisible">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--tv-accent)]">
              <span className="h-1.5 w-1.5 rounded-full bg-white" />
            </span>
            <span className="text-sm font-semibold tracking-tight">TrackVault</span>
          </div>

          <button
            type="button"
            onClick={toggleLightDark}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--tv-text-muted)] transition-colors hover:bg-[var(--tv-surface-hover)] hover:text-[var(--tv-text)]"
            title={resolvedTheme === "dark" ? "切换浅色外观" : "切换深色外观"}
            aria-label="切换明暗主题"
          >
            {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>

        <div className="mx-auto w-full max-w-[340px] py-10">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--tv-text)]">
              {initialized ? "登录 TrackVault" : "创建管理员账号"}
            </h1>
            <p className="text-sm text-[var(--tv-text-muted)]">
              {initialized ? "输入你的成员凭据继续收听。" : "首次启动，请设置用于管理曲库的主账号。"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="tv-auth-username"
                className="block text-xs font-medium text-[var(--tv-text-muted)]"
              >
                用户名
              </label>
              <input
                id="tv-auth-username"
                type="text"
                required
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                className="w-full rounded-lg border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] px-3.5 py-2.5 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] transition-colors focus:border-[var(--tv-accent)] focus:bg-[var(--tv-bg)] focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="tv-auth-password"
                className="block text-xs font-medium text-[var(--tv-text-muted)]"
              >
                密码
              </label>
              <input
                id="tv-auth-password"
                type="password"
                required
                minLength={initialized ? 1 : 8}
                autoComplete={initialized ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={initialized ? "输入密码" : "至少 8 位字符"}
                className="w-full rounded-lg border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] px-3.5 py-2.5 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] transition-colors focus:border-[var(--tv-accent)] focus:bg-[var(--tv-bg)] focus:outline-none"
              />
            </div>

            {!initialized && (
              <div className="space-y-1.5">
                <label
                  htmlFor="tv-auth-confirm"
                  className="block text-xs font-medium text-[var(--tv-text-muted)]"
                >
                  确认密码
                </label>
                <input
                  id="tv-auth-confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入密码"
                  className="w-full rounded-lg border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] px-3.5 py-2.5 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] transition-colors focus:border-[var(--tv-accent)] focus:bg-[var(--tv-bg)] focus:outline-none"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitMutation.isPending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--tv-accent)] py-2.5 text-sm font-medium text-[var(--tv-accent-fg)] transition-colors hover:bg-[var(--tv-accent-hover)] disabled:opacity-50"
            >
              <span>{submitMutation.isPending ? "请稍候..." : initialized ? "登录" : "初始化并进入"}</span>
              {!submitMutation.isPending && <ArrowRight className="h-4 w-4" />}
            </button>
          </form>
        </div>

        <div className="text-center text-xs text-[var(--tv-text-subtle)] lg:text-left">
          自托管私有实例 · 平台凭证仅加密留存于本地服务端
        </div>
      </div>
    </div>
  );
}
