import type {
  AuditIssueItem,
  CompareStatus,
  JobStatus,
  TransferAvailability,
  TransferTrackStatus,
} from "#shared";

export const TRANSFER_PAGE_SIZE = 50;

export const TRANSFER_INPUT_CLASS =
  "w-full rounded-lg border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-[var(--tv-text)] placeholder:text-[var(--tv-text-subtle)] focus:border-[var(--tv-border-strong)] focus:outline-none";

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const TRANSFER_STATUS_LABELS: Record<TransferTrackStatus, string> = {
  matched: "已匹配",
  manual_review: "待确认",
  not_found: "未找到",
  copyright_unavailable: "无版权",
  vip_only: "会员专享",
  trial_only: "仅试听",
  duplicate: "重复",
  skipped: "已跳过",
};

export const TRANSFER_STATUS_BADGE_CLASS: Record<TransferTrackStatus, string> = {
  matched: "bg-[var(--tv-success)]/15 text-[var(--tv-success)]",
  manual_review: "bg-amber-500/15 text-amber-500",
  not_found: "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]",
  copyright_unavailable: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  vip_only: "bg-amber-500/15 text-amber-500",
  trial_only: "bg-amber-500/15 text-amber-500",
  duplicate: "bg-[var(--tv-surface-active)] text-[var(--tv-text-subtle)]",
  skipped: "bg-[var(--tv-surface-active)] text-[var(--tv-text-subtle)]",
};

export const AVAILABILITY_LABELS: Record<TransferAvailability, string> = {
  playable: "可播",
  vip_only: "会员专享",
  paid_album: "付费专辑",
  trial_only: "仅试听",
  copyright_unavailable: "无版权",
  restricted: "受限",
  unknown: "未知",
};

export const AUDIT_ISSUE_LABELS: Record<AuditIssueItem["issueType"], string> = {
  copyright_unavailable: "无版权",
  vip_only: "会员专享",
  paid_album: "付费专辑",
  restricted: "受限",
  trial_only: "仅试听",
  probe_error: "探测异常",
};

export const AUDIT_ISSUE_BADGE_CLASS: Record<AuditIssueItem["issueType"], string> = {
  copyright_unavailable: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  vip_only: "bg-amber-500/15 text-amber-500",
  paid_album: "bg-amber-500/15 text-amber-500",
  restricted: "bg-[var(--tv-danger)]/15 text-[var(--tv-danger)]",
  trial_only: "bg-amber-500/15 text-amber-500",
  probe_error: "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]",
};

export const COMPARE_STATUS_LABELS: Record<CompareStatus, string> = {
  exact: "完全一致",
  similar_title: "相似歌名",
  same_title_different_artist: "同名异唱",
  left_only: "仅歌单 A",
  right_only: "仅歌单 B",
};

export const COMPARE_STATUS_BADGE_CLASS: Record<CompareStatus, string> = {
  exact: "bg-[var(--tv-success)]/15 text-[var(--tv-success)]",
  similar_title: "bg-amber-500/15 text-amber-500",
  same_title_different_artist: "bg-amber-500/15 text-amber-500",
  left_only: "bg-[var(--tv-accent-soft)] text-[var(--tv-accent)]",
  right_only: "bg-[var(--tv-surface-active)] text-[var(--tv-text-muted)]",
};

export type TransferFilter = "all" | "manual_review" | "matched" | "issues";
export type CompareFilter = "all" | CompareStatus;
