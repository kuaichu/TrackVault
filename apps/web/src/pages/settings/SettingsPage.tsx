import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import {
  MUSIC_PLATFORMS,
  type MusicPlatform,
  PREFERENCE_QUALITY_OPTIONS,
  type PreferenceQualityLevel,
  type ProviderMode,
  type StartupView,
  type UserSummary,
  getPlatformDisplayName,
} from "#shared";
import { BindingsPanel } from "../../features/auth/index.js";
import { audioEngine } from "../../features/player/index.js";
import { api } from "../../shared/api/endpoints.js";
import { SETTINGS_QUERY_KEY, useSettingsQuery } from "../../shared/hooks/use-settings-query.js";
import { type ThemePreference, useThemeStore } from "../../shared/store/theme-store.js";
import { toast } from "../../shared/store/toast-store.js";
import { AppleSelect, SegmentedTabs } from "../../shared/ui/primitives.js";

const USERNAME_PATTERN = "^[a-zA-Z0-9_.-]+$";
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]{2,32}$/;

const PROVIDER_MODE_OPTIONS: ReadonlyArray<{ value: ProviderMode; label: string }> = [
  { value: "netease", label: "网易云音乐" },
  { value: "qq", label: "QQ 音乐" },
  { value: "kugou", label: "酷狗音乐" },
  { value: "aggregate", label: "多平台聚合" },
];

const QUALITY_SELECT_OPTIONS: ReadonlyArray<{ value: PreferenceQualityLevel; label: string }> =
  PREFERENCE_QUALITY_OPTIONS.map((opt) => ({ value: opt.level, label: opt.label }));

const CONCURRENCY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "1 首并发" },
  { value: 2, label: "2 首并发" },
  { value: 3, label: "3 首并发" },
];

const STARTUP_VIEW_OPTIONS: ReadonlyArray<{ value: StartupView; label: string }> = [
  { value: "discover", label: "发现" },
  { value: "search", label: "搜索" },
  { value: "playlists", label: "歌单" },
  { value: "downloads", label: "下载管理" },
];

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

function AdminConsole() {
  const queryClient = useQueryClient();
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newTrusted, setNewTrusted] = useState(false);
  const [fallbackDrafts, setFallbackDrafts] = useState<Record<MusicPlatform, string>>({
    netease: "",
    qq: "",
    kugou: "",
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
    mutationFn: async () => {
      const cleanUsername = newUsername.trim();
      if (!USERNAME_REGEX.test(cleanUsername)) {
        throw new Error("用户名需为 2–32 位，仅支持字母、数字及 _ . -");
      }
      if (!newPassword.trim() || newPassword.length < 8) {
        throw new Error("初始密码至少需要 8 位非空字符");
      }
      return api.createMember({
        username: cleanUsername,
        password: newPassword,
        role: "member",
        trustedFallback: newTrusted,
      });
    },
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
    onError: (err) => toast.error(err instanceof Error ? err.message : "更新成员权限失败"),
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
      if (vars.clearCookie) {
        toast.info("已清除系统保底凭证");
      } else if (!vars.cookie && !vars.enabled) {
        toast.info("已停用系统保底凭证");
      } else if (!vars.cookie && vars.enabled) {
        toast.success("已启用系统保底凭证");
      } else {
        toast.success("系统保底凭证已更新");
      }
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

      <div className="rounded-2xl bg-[var(--tv-surface)] p-4 sm:p-5 space-y-5">
        <div className="space-y-1.5">
          <form onSubmit={handleAddMember} className="flex flex-wrap items-center gap-2.5">
            <input
              type="text"
              required
              minLength={2}
              maxLength={32}
              pattern={USERNAME_PATTERN}
              title="用户名仅支持 2–32 位字母、数字及 _ . -"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="新成员用户名"
              className="h-9 min-w-0 w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none sm:w-auto"
            />
            <input
              type="password"
              required
              minLength={8}
              maxLength={128}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="初始密码（至少 8 位）"
              className="h-9 min-w-0 w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none sm:w-auto"
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
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--tv-accent)] px-3.5 text-xs font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)] disabled:opacity-40"
            >
              <UserPlus className="h-3.5 w-3.5" />
              添加成员
            </button>
          </form>
          <p className="text-[11px] text-[var(--tv-text-subtle)]">
            用户名需为 2–32 位，仅支持字母、数字及 _ . -
          </p>
        </div>

        <div className="divide-y divide-[var(--tv-border)] border-t border-[var(--tv-border)] text-xs">
          {membersQuery.isError ? (
            <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
              <span className="text-[var(--tv-danger)]">
                加载成员列表失败：
                {membersQuery.error instanceof Error ? membersQuery.error.message : "请稍后重试"}
              </span>
              <button
                type="button"
                onClick={() => void membersQuery.refetch()}
                className="rounded-lg bg-[var(--tv-bg)] px-3 py-1 font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
              >
                重试
              </button>
            </div>
          ) : (
            membersQuery.data?.members.map((member) => (
              <div
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span
                    className="min-w-0 truncate font-medium text-[var(--tv-text)]"
                    title={member.username}
                  >
                    {member.username}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--tv-text-subtle)]">
                    {member.role === "admin" ? "管理员" : "成员"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3 sm:gap-4">
                  <label className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[var(--tv-text-muted)]">
                    <input
                      type="checkbox"
                      checked={member.trustedFallback}
                      disabled={toggleTrustedMutation.isPending}
                      onChange={() => toggleTrustedMutation.mutate(member)}
                      className="accent-[var(--tv-accent)]"
                    />
                    保底权限
                  </label>
                  {member.role !== "admin" && (
                    <button
                      type="button"
                      disabled={deleteMemberMutation.isPending}
                      onClick={() => deleteMemberMutation.mutate(member.id)}
                      className="shrink-0 text-[var(--tv-text-subtle)] hover:text-[var(--tv-danger)] disabled:opacity-40"
                      aria-label={`删除 ${member.username}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {fallbacksQuery.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--tv-border)] pt-4 text-xs">
            <span className="text-[var(--tv-danger)]">
              加载保底凭证失败：
              {fallbacksQuery.error instanceof Error ? fallbacksQuery.error.message : "请稍后重试"}
            </span>
            <button
              type="button"
              onClick={() => void fallbacksQuery.refetch()}
              className="rounded-lg bg-[var(--tv-bg)] px-3 py-1 font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)]"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="grid gap-3 border-t border-[var(--tv-border)] pt-4 md:grid-cols-3">
            {MUSIC_PLATFORMS.map((platform) => {
              const fb = fallbacksQuery.data?.fallbacks[platform];
              const trimmedDraft = fallbackDrafts[platform].trim();
              const canSubmitFallback = Boolean(trimmedDraft || fb?.configured);

              return (
                <div key={platform} className="space-y-2.5 rounded-xl bg-[var(--tv-bg)] p-3.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-[var(--tv-text)]">
                      {`${getPlatformDisplayName(platform)}保底凭证`}
                    </span>
                    <span className="text-[var(--tv-text-subtle)]">
                      {fb?.configured ? (fb.enabled ? "已启用" : "已停用") : "未配置"}
                    </span>
                  </div>
                  <input
                    type="password"
                    value={fallbackDrafts[platform]}
                    onChange={(e) => setFallbackDrafts((prev) => ({ ...prev, [platform]: e.target.value }))}
                    placeholder="输入新的保底 Cookie"
                    className="w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-surface)] px-2.5 py-1.5 text-xs text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:outline-none"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!canSubmitFallback || saveFallbackMutation.isPending}
                      onClick={() =>
                        saveFallbackMutation.mutate({
                          platform,
                          cookie: trimmedDraft || undefined,
                          enabled: true,
                        })
                      }
                      className="rounded-lg bg-[var(--tv-contrast-bg)] px-3 py-1 text-xs font-medium text-[var(--tv-contrast-fg)] disabled:opacity-40"
                    >
                      保存并启用
                    </button>
                    {fb?.configured && (
                      <button
                        type="button"
                        disabled={saveFallbackMutation.isPending}
                        onClick={() =>
                          saveFallbackMutation.mutate({
                            platform,
                            enabled: !fb.enabled,
                          })
                        }
                        className="rounded-lg border border-[var(--tv-border-strong)] bg-[var(--tv-surface)] px-2.5 py-1 text-xs font-medium text-[var(--tv-text)] hover:bg-[var(--tv-surface-active)] disabled:opacity-40"
                      >
                        {fb.enabled ? "停用" : "启用"}
                      </button>
                    )}
                    {fb?.configured && (
                      <button
                        type="button"
                        disabled={saveFallbackMutation.isPending}
                        onClick={() =>
                          saveFallbackMutation.mutate({ platform, enabled: false, clearCookie: true })
                        }
                        className="rounded-lg px-2.5 py-1 text-xs text-[var(--tv-text-muted)] hover:text-[var(--tv-danger)] disabled:opacity-40"
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function SettingsPage({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const themePref = useThemeStore((s) => s.preference);
  const setThemePref = useThemeStore((s) => s.setPreference);

  const settingsQuery = useSettingsQuery();

  const updateMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (res) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, res);
      audioEngine.syncDefaultPlaybackQuality(res.settings.defaultPlaybackQuality);
      toast.success("已保存设置");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
  });

  const settings = settingsQuery.data?.settings;

  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-[28px] font-bold tracking-tight text-[var(--tv-text)]">设置</h1>

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

          {settingsQuery.isLoading && !settings ? (
            <div className="space-y-2.5 px-4 py-4 sm:px-5">
              <div className="h-6 animate-pulse rounded bg-[var(--tv-bg)]/60" />
              <div className="h-6 animate-pulse rounded bg-[var(--tv-bg)]/60" />
            </div>
          ) : settingsQuery.isError && !settings ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-xs sm:px-5">
              <div className="space-y-0.5">
                <div className="font-medium text-[var(--tv-text)]">未能加载个人偏好设置</div>
                <div className="text-[var(--tv-text-muted)]">
                  {settingsQuery.error instanceof Error ? settingsQuery.error.message : "请稍后重试"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void settingsQuery.refetch()}
                className="rounded-lg bg-[var(--tv-accent)] px-3.5 py-1.5 font-medium text-[var(--tv-accent-fg)] hover:bg-[var(--tv-accent-hover)]"
              >
                重试
              </button>
            </div>
          ) : settings ? (
            <>
              <SettingRow
                label="默认音乐源"
                control={
                  <AppleSelect
                    ariaLabel="默认音乐源"
                    value={settings.providerMode}
                    options={PROVIDER_MODE_OPTIONS}
                    onChange={(providerMode) => updateMutation.mutate({ providerMode })}
                  />
                }
              />

              <SettingRow
                label="在线试听音质"
                hint="独立于下载音质，仅用于在线播放"
                control={
                  <AppleSelect
                    ariaLabel="在线试听音质"
                    value={settings.defaultPlaybackQuality}
                    options={QUALITY_SELECT_OPTIONS}
                    onChange={(defaultPlaybackQuality) => updateMutation.mutate({ defaultPlaybackQuality })}
                  />
                }
              />

              <SettingRow
                label="默认下载音质"
                hint="点击下载按钮时优先选择的无损或高品音质"
                control={
                  <AppleSelect
                    ariaLabel="默认下载音质"
                    value={settings.defaultDownloadQuality}
                    options={QUALITY_SELECT_OPTIONS}
                    onChange={(defaultDownloadQuality) => updateMutation.mutate({ defaultDownloadQuality })}
                  />
                }
              />

              <SettingRow
                label="同时下载上限"
                control={
                  <AppleSelect
                    ariaLabel="同时下载上限"
                    value={settings.maxConcurrentDownloads}
                    options={CONCURRENCY_OPTIONS}
                    onChange={(maxConcurrentDownloads) => updateMutation.mutate({ maxConcurrentDownloads })}
                  />
                }
              />

              <SettingRow
                label="启动页"
                control={
                  <AppleSelect
                    ariaLabel="启动页"
                    value={settings.startupView}
                    options={STARTUP_VIEW_OPTIONS}
                    onChange={(startupView) => updateMutation.mutate({ startupView })}
                  />
                }
              />
            </>
          ) : null}
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
