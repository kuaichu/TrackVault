import type { SongAvailability } from "#shared";

/**
 * Strictly parses nullable numeric signals.
 * Fixes legacy bug where Number(null) === 0 and Number("") === 0 falsely locked playable songs.
 */
export function parseOptionalNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface NeteasePrivilegeInput {
  fee?: number | string | null;
  pl?: number | string | null;
  dl?: number | string | null;
  st?: number | string | null;
  cp?: number | string | null;
  noCopyrightRcmd?: unknown;
  isCloud?: boolean;
}

export function evaluateNeteaseAvailability(input: NeteasePrivilegeInput): SongAvailability | undefined {
  // Cloud-uploaded personal files are not governed by catalog copyright locks
  if (input.isCloud) {
    return {
      playback: { status: "available", locked: false, label: "云盘可播", reason: "网易云个人云盘音源" },
      download: { status: "available", locked: false, label: "云盘可下", reason: "网易云个人云盘音源" },
    };
  }

  const fee = parseOptionalNumber(input.fee);
  const pl = parseOptionalNumber(input.pl);
  const dl = parseOptionalNumber(input.dl);
  const st = parseOptionalNumber(input.st);
  const cp = parseOptionalNumber(input.cp);
  // A08: noCopyrightRcmd is an informational recommendation hint and must NOT override explicit playable privileges.
  const hasCopyrightHint = st !== null && st < 0;

  if (fee === null && pl === null && dl === null && cp === null && !hasCopyrightHint) {
    return undefined;
  }

  const playbackLocked = pl !== null && pl <= 0;
  const downloadLocked = dl !== null && dl <= 0;
  const isVip = fee === 1;
  const isPaidAlbum = fee === 4;
  // C040 guardrail: cp === 0 frequently appears on playable VIP songs (pl > 0);
  // only treat cp === 0 as an auxiliary copyright block when pl is absent/zero and track is neither VIP nor paid album.
  const cpBlocked = cp !== null && cp === 0 && (pl === null || pl <= 0) && !isVip && !isPaidAlbum;
  const copyrightUnavailable = hasCopyrightHint || (playbackLocked && !isVip && !isPaidAlbum) || cpBlocked;

  const playback = copyrightUnavailable
    ? { status: "copyright" as const, locked: true, label: "无版权", reason: "当前地区或曲库暂无播放版权。" }
    : isPaidAlbum && playbackLocked
      ? {
          status: "paid_album" as const,
          locked: true,
          label: "付费专辑",
          reason: "需要购买数字专辑后播放完整版。",
        }
      : isVip
        ? {
            status: "vip" as const,
            locked: playbackLocked,
            label: playbackLocked ? "VIP 试听" : "VIP 可播",
            reason: playbackLocked ? "需要网易云黑胶 VIP 播放完整版。" : "当前账号具备 VIP 播放权限。",
          }
        : { status: "available" as const, locked: false, label: "可播放", reason: "可正常播放完整版。" };

  const download = copyrightUnavailable
    ? { status: "copyright" as const, locked: true, label: "无版权", reason: "暂无下载版权。" }
    : isPaidAlbum && downloadLocked
      ? { status: "paid_album" as const, locked: true, label: "付费专辑", reason: "需要购买数字专辑后下载。" }
      : isVip
        ? {
            status: "vip" as const,
            locked: downloadLocked,
            label: downloadLocked ? "VIP 专享" : "VIP 可下",
            reason: downloadLocked ? "需要网易云黑胶 VIP 下载完整版。" : "当前账号具备 VIP 下载权限。",
          }
        : downloadLocked
          ? {
              status: "restricted" as const,
              locked: true,
              label: "受限",
              reason: "平台限制当前账号下载此曲目。",
            }
          : { status: "available" as const, locked: false, label: "可下载", reason: "支持下载。" };

  return { playback, download };
}

export interface QqPrivilegeInput {
  actionSwitch?: number | string | null;
  payPlay?: number | string | null;
  payDownload?: number | string | null;
  tryEnd?: number | string | null;
}

export interface QqAvailabilityOptions {
  vipEnabled?: boolean;
}

export function evaluateQqAvailability(
  input: QqPrivilegeInput,
  options?: QqAvailabilityOptions,
): SongAvailability | undefined {
  const actionSwitch = parseOptionalNumber(input.actionSwitch);
  const payPlay = parseOptionalNumber(input.payPlay);
  const payDownload = parseOptionalNumber(input.payDownload);
  const tryEnd = parseOptionalNumber(input.tryEnd);

  if (actionSwitch === null && payPlay === null && payDownload === null && tryEnd === null) {
    return undefined;
  }

  // Canonical unified rule across search, playlists, and transfer:
  // switch === 0 means no catalog copyright regardless of pay flags.
  if (actionSwitch !== null && actionSwitch === 0) {
    return {
      playback: { status: "copyright", locked: true, label: "无版权", reason: "QQ 音乐暂无该歌曲播放版权。" },
      download: { status: "copyright", locked: true, label: "无版权", reason: "QQ 音乐暂无该歌曲下载版权。" },
    };
  }

  const isVipPlay = payPlay !== null && payPlay > 0;
  const isVipDown = (payDownload !== null && payDownload > 0) || isVipPlay;
  const hasTrialHint = tryEnd !== null && tryEnd > 0;
  const nonVipKnown = options?.vipEnabled === false;

  const playbackLocked = nonVipKnown && (isVipPlay || hasTrialHint);
  const downloadLocked = nonVipKnown && (isVipDown || hasTrialHint);

  return {
    playback:
      isVipPlay || playbackLocked
        ? {
            status: "vip",
            locked: playbackLocked,
            label: hasTrialHint ? "绿钻 / 试听" : "绿钻 VIP",
            reason: playbackLocked
              ? "当前 QQ 音乐账号未开通绿钻 VIP，无法播放完整版。"
              : "需要 QQ 音乐绿钻 VIP 播放完整版。",
          }
        : { status: "available", locked: false, label: "可播放", reason: "可正常播放。" },
    download:
      isVipDown || downloadLocked
        ? {
            status: "vip",
            locked: downloadLocked,
            label: "绿钻 VIP",
            reason: downloadLocked
              ? "当前 QQ 音乐账号未开通绿钻 VIP，无法下载完整版。"
              : "需要 QQ 音乐绿钻 VIP 下载。",
          }
        : { status: "available", locked: false, label: "可下载", reason: "支持下载。" },
  };
}
