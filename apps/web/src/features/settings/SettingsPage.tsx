import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  type MusicPlatform,
  PREFERENCE_QUALITY_OPTIONS,
  type PreferenceQualityLevel,
  type ProviderMode,
  type StartupView,
  type UserSummary,
} from "#shared";
import { api } from "../../shared/api/endpoints.js";
import { type ThemePreference, useThemeStore } from "../../shared/store/theme-store.js";
import { toast } from "../../shared/store/toast-store.js";
import { SegmentedTabs } from "../../shared/ui/primitives.js";
import { BindingsPanel } from "../auth/BindingsPanel.js";
import { audioEngine } from "../player/engine/audio-engine.js";

function SettingRow({
  label,
  hint,
  control,
}: {
  label: string;
  hint?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:gap-4 sm:px-5 sm:py-3.5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-[var(--tv-text)]">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-[var(--tv-text-muted)]">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

const SELECT_CLASS =
  "rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-1.5 text-xs leading-normal text-[var(--tv-text)] focus:border-[var(--tv-border-strong)] focus:outline-none";

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
      toast.success("已添加成员");
      void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "添加成员失败"),
  });

  const toggleTrustedMutation = useMutation({
    mutationFn: (member: UserSummary) =>
      api.updateMember(member.id, { trustedFallback: !member.trustedFallback }),
    onSuccess: () => {
      toast.success("已更新成员权限");
      void queryClient.invalidateQueries({ queryKey: ["admin-members"] });
    },
  });

  const deleteMemberMutation = useMutation({
    mutationFn: (id: string) => api.deleteMember(id),
    onSuccess: () => {
      toast.info("已移除成员");
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
      toast.success("系统保底凭证已更新");
      void queryClient.invalidateQueries({ queryKey: ["admin-fallbacks"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
  });

  const handleAddMember = (e: FormEvent) => {
    e.preventDefault();
    createMemberMutation.mutate();
  };

  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold tracking-tight text-[var(--tv-text)]">成员与保底凭证</h2>

      <div className="rounded-2xl bg-[var(--tv-surface)] p-5 space-y-5">
        <form onSubmit={handleAddMember} className="flex flex-wrap items-center gap-2.5">
          <input
            type="text"
            required
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="新成员用户名"
            className="h-9 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none"
          />
          <input
            type="password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="初始密码（至少 8 位）"
            className="h-9 rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none"
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-[var(--tv-text-muted)]">
            <input
              type="checkbox"
              checked={newTrusted}
              onChange={(e) => setNewTrusted(e.target.checked)}
              className="accent-[var(--tv-accent)]"
            />
            允许使用保底凭证
          </label>
          <button
            type="submit"
            disabled={createMemberMutation.isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--tv-accent)] px-3.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
          >
            <UserPlus className="h-3.5 w-3.5" />
            添加成员
          </button>
        </form>

        <div className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)] text-xs">
          {membersQuery.data?.members.map((member) => (
            <div key={member.id} className="flex items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-2">
                <span className="font-medium text-[var(--tv-text)]">{member.username}</span>
                <span className="text-[11px] text-[var(--tv-text-subtle)]">
                  {member.role === "admin" ? "管理员" : "成员"}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <label className="inline-flex items-center gap-1.5 text-[var(--tv-text-muted)]">
                  <input
                    type="checkbox"
                    checked={member.trustedFallback}
                    onChange={() => toggleTrustedMutation.mutate(member)}
                    className="accent-[var(--tv-accent)]"
                  />
                  保底权限
                </label>
                {member.role !== "admin" && (
                  <button
                    type="button"
                    onClick={() => deleteMemberMutation.mutate(member.id)}
                    className="text-[var(--tv-text-subtle)] hover:text-[var(--tv-danger)]"
                    aria-label={`删除 ${member.username}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-3 border-t border-[var(--tv-border)] pt-4 md:grid-cols-2">
          {(["netease", "qq"] as const).map((platform) => {
            const fb = fallbacksQuery.data?.fallbacks[platform];
            return (
              <div key={platform} className="space-y-2.5 rounded-xl bg-[var(--tv-bg)] p-3.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-[var(--tv-text)]">
                    {platform === "netease" ? "网易云保底凭证" : "QQ 音乐保底凭证"}
                  </span>
                  <span className="text-[var(--tv-text-subtle)]">
                    {fb?.configured ? (fb.enabled ? "已启用" : "已保存") : "未配置"}
                  </span>
                </div>
                <input
                  type="password"
                  value={fallbackDrafts[platform]}
                  onChange={(e) => setFallbackDrafts((prev) => ({ ...prev, [platform]: e.target.value }))}
                  placeholder="输入新的保底 Cookie"
                  className="w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none"
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
                    className="rounded-lg bg-[var(--tv-contrast-bg)] px-3 py-1 text-xs font-medium text-[var(--tv-contrast-fg)]"
                  >
                    保存并启用
                  </button>
                  {fb?.configured && (
                    <button
                      type="button"
                      onClick={() =>
                        saveFallbackMutation.mutate({ platform, enabled: false, clearCookie: true })
                      }
                      className="rounded-lg px-2.5 py-1 text-xs text-[var(--tv-text-muted)] hover:text-[var(--tv-danger)]"
                    >
                      清除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function SettingsPage({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const themePref = useThemeStore((s) => s.preference);
  const setThemePref = useThemeStore((s) => s.setPreference);

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.getSettings(),
  });

  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (res) => {
      queryClient.setQueryData(["settings"], res);
      audioEngine.syncDefaultPlaybackQuality(res.settings.defaultPlaybackQuality);
      toast.success("已保存设置");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
  });

  const settings = settingsQuery.data?.settings;

  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">设置</h1>

      {/* macOS System Settings Grouped Preference Sheet */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight text-[var(--tv-text)]">通用与音质</h2>
        <div className="divide-y divide-[var(--tv-border)] rounded-2xl bg-[var(--tv-surface)]">
          <SettingRow
            label="外观主题"
            hint="深色、浅色或自动跟随系统"
            control={
              <SegmentedTabs<ThemePreference>
                value={themePref}
                onChange={setThemePref}
                items={[
                  { id: "dark", label: "深色" },
                  { id: "light", label: "浅色" },
                  { id: "system", label: "跟随系统" },
                ]}
              />
            }
          />

          {settings && (
            <>
              <SettingRow
                label="默认音乐源"
                control={
                  <select
                    aria-label="默认音乐源"
                    value={settings.providerMode}
                    onChange={(e) => updateMutation.mutate({ providerMode: e.target.value as ProviderMode })}
                    className={SELECT_CLASS}
                  >
                    <option value="netease">网易云音乐</option>
                    <option value="qq">QQ 音乐</option>
                    <option value="aggregate">双平台聚合</option>
                  </select>
                }
              />

              <SettingRow
                label="在线试听音质"
                hint="独立于下载音质，仅用于在线播放"
                control={
                  <select
                    aria-label="在线试听音质"
                    value={settings.defaultPlaybackQuality}
                    onChange={(e) =>
                      updateMutation.mutate({
                        defaultPlaybackQuality: e.target.value as PreferenceQualityLevel,
                      })
                    }
                    className={SELECT_CLASS}
                  >
                    {PREFERENCE_QUALITY_OPTIONS.map((opt) => (
                      <option key={opt.level} value={opt.level}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                }
              />

              <SettingRow
                label="默认下载音质"
                hint="点击下载按钮时优先选择的无损或高品音质"
                control={
                  <select
                    aria-label="默认下载音质"
                    value={settings.defaultDownloadQuality}
                    onChange={(e) =>
                      updateMutation.mutate({
                        defaultDownloadQuality: e.target.value as PreferenceQualityLevel,
                      })
                    }
                    className={SELECT_CLASS}
                  >
                    {PREFERENCE_QUALITY_OPTIONS.map((opt) => (
                      <option key={opt.level} value={opt.level}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                }
              />

              <SettingRow
                label="同时下载上限"
                control={
                  <select
                    aria-label="同时下载上限"
                    value={settings.maxConcurrentDownloads}
                    onChange={(e) =>
                      updateMutation.mutate({ maxConcurrentDownloads: Number(e.target.value) })
                    }
                    className={SELECT_CLASS}
                  >
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n} 首并发
                      </option>
                    ))}
                  </select>
                }
              />

              <SettingRow
                label="启动页"
                control={
                  <select
                    aria-label="启动页"
                    value={settings.startupView}
                    onChange={(e) => updateMutation.mutate({ startupView: e.target.value as StartupView })}
                    className={SELECT_CLASS}
                  >
                    <option value="discover">发现</option>
                    <option value="search">搜索</option>
                    <option value="playlists">歌单</option>
                    <option value="downloads">下载管理</option>
                  </select>
                }
              />
            </>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight text-[var(--tv-text)]">音乐平台账号</h2>
        <BindingsPanel />
      </section>

      {user.role === "admin" && <AdminConsole />}
    </div>
  );
}
