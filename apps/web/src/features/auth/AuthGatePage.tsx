import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Disc3, Lock, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";

export function AuthGatePage({ initialized }: { initialized: boolean }) {
  const queryClient = useQueryClient();
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
    onSuccess: () => {
      toast.success(initialized ? "登录成功" : "管理员初始化完成，已自动登录");
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "认证失败");
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMutation.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--tv-bg)] p-6">
      <div className="w-full max-w-md rounded-3xl border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] p-8 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400/15 text-amber-400">
            <Disc3 className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">TrackVault v2</h1>
            <p className="text-xs text-[var(--tv-text-muted)]">
              {initialized ? "私有音乐工作台 · 成员登录" : "首次启动 · 创建管理员账号"}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--tv-text-muted)]">用户名</span>
            <input
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例如 admin"
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2.5 text-sm text-white focus:border-amber-400/70 focus:outline-none"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-[var(--tv-text-muted)]">密码</span>
            <input
              type="password"
              required
              minLength={initialized ? 1 : 8}
              autoComplete={initialized ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={initialized ? "输入登录密码" : "至少 8 位密码"}
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2.5 text-sm text-white focus:border-amber-400/70 focus:outline-none"
            />
          </label>

          {!initialized && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--tv-text-muted)]">确认密码</span>
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3.5 py-2.5 text-sm text-white focus:border-amber-400/70 focus:outline-none"
              />
            </label>
          )}

          <button
            type="submit"
            disabled={submitMutation.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            {initialized ? <Lock className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            {submitMutation.isPending ? "处理中..." : initialized ? "登录工作台" : "创建管理员并进入"}
          </button>
        </form>

        <p className="mt-5 text-[11px] leading-relaxed text-[var(--tv-text-subtle)]">
          会话使用 HttpOnly Cookie 维护，所有第三方音乐平台凭证均经服务端 AES-256-GCM
          静态加密存储，绝不明文回传浏览器。
        </p>
      </div>
    </div>
  );
}
