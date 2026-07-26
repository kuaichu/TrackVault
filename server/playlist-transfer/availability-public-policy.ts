export const AVAILABILITY_CHECK_FAILED_REASON = "歌曲可用性检查失败，请稍后重试";

function publicReasonForStatus(status: string) {
  if (status === "available") return "目标歌曲当前可用";
  if (status === "copyright_unavailable") return "目标歌曲因版权限制不可用";
  if (status === "vip_only") return "目标歌曲需要会员权限";
  if (status === "trial_only") return "目标歌曲仅可试听";
  return "目标歌曲当前不可用";
}

export function toPublicTrackAvailability<Status extends string>(availability: {
  status: Status;
  reason?: string;
}): { status: Status; reason: string } {
  return {
    status: availability.status,
    reason: availability.reason === AVAILABILITY_CHECK_FAILED_REASON
      ? AVAILABILITY_CHECK_FAILED_REASON
      : publicReasonForStatus(availability.status)
  };
}
