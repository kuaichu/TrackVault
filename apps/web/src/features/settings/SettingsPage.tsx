import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Trash2, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  type MusicPlatform,
  PREFERENCE_QUALITY_OPTIONS,
  type PreferenceQualityLevel,
  type ProviderMode,
  type StartupView,
  type UserSummary,
} from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { toast } from "../../shared/store/toast-store.js";
import { BindingsPanel } from "../auth/BindingsPanel.js";
import { usePlayerStore } from "../player/store/player-store.js";

function AdminConsole() {
  const queryClient = useQueryClient();
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newTrusted, setNewTrusted] = useState(false);
  const [fallbackDrafts, setFallbackDrafts] = useState<Record<MusicPlatform, string>>({
    netease: "",
    qq: "",
  });

  const membersQuery = useQuery({
    queryKey: ["admin-members"],
    queryFn: () => api.listMembers(),
  });

  const fallbacksQuery = useQuery({
    queryKey: ["admin-fallbacks"],
    queryFn: () => api.listSystemFallbacks(),
  });

  const createMemberMutation = useMutation({
    mutationFn: () =>
      api.createMember({
        username: newUsername,
        password: newPassword,
        role: "member",
        trustedFallback: newTrusted,
      }),
    onSuccess: () => {
      setNewUsername("");
      setNewPassword("");
      setNewTrusted(false);
      toast.success("已创建新成员账号");
      void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "创建成员失败"),
  });

  const toggleTrustedMutation = useMutation({
    mutationFn: (member: UserSummary) =>
      api.updateMember(member.id, { trustedFallback: !member.trustedFallback }),
    onSuccess: () => {
      toast.success("已更新成员保底权限");
      void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
    },
  });

  const deleteMemberMutation = useMutation({
    mutationFn: (id: string) => api.deleteMember(id),
    onSuccess: () => {
      toast.info("已删除成员账号");
      void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "删除失败"),
  });

  const saveFallbackMutation = useMutation({
    mutationFn: (vars: {
      platform: MusicPlatform;
      cookie?: string;
      enabled: boolean;
      clearCookie?: boolean;
    }) =>
      api.saveSystemFallback(vars.platform, {
        cookie: vars.cookie,
        enabled: vars.enabled,
        clearCookie: vars.clearCookie,
      }),
    onSuccess: (_res, vars) => {
      setFallbackDrafts((prev) => ({ ...prev, [vars.platform]: "" }));
      toast.success("系统保底凭证配置已更新");
      void queryClient.invalidateQueries({ queryKey: ["admin-fallbacks"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
  });

  const handleAddMember = (e: FormEvent) => {
    e.preventDefault();
    createMemberMutation.mutate();
  };

  return (
    <section className="rounded-2xl border border-amber-500/25 bg-[var(--tv-surface)] p-5 space-y-5">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-5 w-5 text-amber-400" />
        <div>
          <h2 className="text-base font-semibold text-white">管理员控制台（仅管理员可见）</h2>
          <p className="text-xs text-[var(--tv-text-muted)]">
            管理小圈子成员账号与受信成员专属的系统加密保底凭证
          </p>
        </div>
      </div>

      {/* Member creation */}
      <form onSubmit={handleAddMember} className="flex flex-wrap items-end gap-2.5">
        <input
          type="text"
          required
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          placeholder="新成员用户名"
          className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-xs text-white"
        />
        <input
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="初始密码（≥8位）"
          className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-xs text-white"
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
          <input
            type="checkbox"
            checked={newTrusted}
            onChange={(e) => setNewTrusted(e.target.checked)}
            className="accent-amber-400"
          />
          允许使用保底凭证
        </label>
        <button
          type="submit"
          disabled={createMemberMutation.isPending}
          className="inline-flex items-center gap-1 rounded-xl bg-amber-400 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300"
        >
          <UserPlus className="h-3.5 w-3.5" />
          添加成员
        </button>
      </form>

      {/* Member list */}
      <div className="divide-y divide-[var(--tv-border)] rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)]/50 text-xs">
        {membersQuery.data?.members.map((member) => (
          <div key={member.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">{member.username}</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-[var(--tv-text-muted)]">
                {member.role}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-[var(--tv-text-muted)]">
                <input
                  type="checkbox"
                  checked={member.trustedFallback}
                  onChange={() => toggleTrustedMutation.mutate(member)}
                  className="accent-amber-400"
                />
                保底白名单
              </label>
              {member.role !== "admin" && (
                <button
                  type="button"
                  onClick={() => deleteMemberMutation.mutate(member.id)}
                  className="text-rose-400 hover:text-rose-300"
                  aria-label={`删除 ${member.username}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* System Fallback Credentials */}
      <div className="grid gap-3 md:grid-cols-2">
        {(["netease", "qq"] as const).map((platform) => {
          const fb = fallbacksQuery.data?.fallbacks[platform];
          return (
            <div
              key={platform}
              className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)]/50 p-3.5 space-y-2"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-white">
                  {platform === "netease" ? "网易云保底凭证" : "QQ 音乐保底凭证"}
                </span>
                <span className={fb?.enabled ? "text-emerald-300" : "text-[var(--tv-text-subtle)]"}>
                  {fb?.configured ? (fb.enabled ? "已启用" : "已存未启用") : "未配置"}
                </span>
              </div>
              <input
                type="password"
                value={fallbackDrafts[platform]}
                onChange={(e) => setFallbackDrafts((prev) => ({ ...prev, [platform]: e.target.value }))}
                placeholder="输入新的保底 Cookie（留空则仅切换开关）"
                className="w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-white"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    saveFallbackMutation.mutate({
                      platform,
                      cookie: fallbackDrafts[platform] || undefined,
                      enabled: true,
                    })
                  }
                  className="rounded-lg bg-amber-400 px-3 py-1 text-xs font-semibold text-slate-950"
                >
                  保存并启用
                </button>
                {fb?.configured && (
                  <button
                    type="button"
                    onClick={() =>
                      saveFallbackMutation.mutate({ platform, enabled: false, clearCookie: true })
                    }
                    className="rounded-lg border border-rose-500/30 px-2.5 py-1 text-xs text-rose-300"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function SettingsPage({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const setPlayerPatch = usePlayerStore((s) => s.setStatePatch);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (res) => {
      queryClient.setQueryData(["settings"], res);
      setPlayerPatch({ defaultPlaybackQuality: res.settings.defaultPlaybackQuality });
      toast.success("偏好设置已保存");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
  });

  const settings = settingsQuery.data?.settings;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-white">偏好设置与账号绑定</h1>
        <p className="text-xs text-[var(--tv-text-muted)]">播放默认音质与下载默认音质严格独立，互不污染</p>
      </div>

      {settings && (
        <section className="rounded-2xl border border-[var(--tv-border)] bg-[var(--tv-surface)] p-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1.5 text-xs">
            <span className="text-[var(--tv-text-muted)]">默认音乐源</span>
            <select
              value={settings.providerMode}
              onChange={(e) => updateMutation.mutate({ providerMode: e.target.value as ProviderMode })}
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
            >
              <option value="netease">网易云音乐</option>
              <option value="qq">QQ 音乐</option>
              <option value="aggregate">双平台聚合</option>
            </select>
          </label>

          <label className="space-y-1.5 text-xs">
            <span className="text-[var(--tv-text-muted)]">默认试听音质（仅影响在线播放）</span>
            <select
              value={settings.defaultPlaybackQuality}
              onChange={(e) =>
                updateMutation.mutate({
                  defaultPlaybackQuality: e.target.value as PreferenceQualityLevel,
                })
              }
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
            >
              {PREFERENCE_QUALITY_OPTIONS.map((opt) => (
                <option key={opt.level} value={opt.level}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 text-xs">
            <span className="text-[var(--tv-text-muted)]">默认下载音质（仅影响下载）</span>
            <select
              value={settings.defaultDownloadQuality}
              onChange={(e) =>
                updateMutation.mutate({
                  defaultDownloadQuality: e.target.value as PreferenceQualityLevel,
                })
              }
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
            >
              {PREFERENCE_QUALITY_OPTIONS.map((opt) => (
                <option key={opt.level} value={opt.level}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 text-xs">
            <span className="text-[var(--tv-text-muted)]">单用户同时下载上限</span>
            <select
              value={settings.maxConcurrentDownloads}
              onChange={(e) => updateMutation.mutate({ maxConcurrentDownloads: Number(e.target.value) })}
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
            >
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n} 并发
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 text-xs">
            <span className="text-[var(--tv-text-muted)]">启动默认页面</span>
            <select
              value={settings.startupView}
              onChange={(e) => updateMutation.mutate({ startupView: e.target.value as StartupView })}
              className="w-full rounded-xl border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-white"
            >
              <option value="discover">发现音乐</option>
              <option value="search">搜索</option>
              <option value="playlists">我的歌单</option>
              <option value="downloads">下载中心</option>
            </select>
          </label>
        </section>
      )}

      <div className="space-y-3">
        <h2 className="text-base font-semibold text-white">音乐平台账号绑定</h2>
        <BindingsPanel />
      </div>

      {user.role === "admin" && <AdminConsole />}
    </div>
  );
}
