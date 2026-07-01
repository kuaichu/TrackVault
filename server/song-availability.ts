import type { SongAvailability } from "./types.js";

export type NeteasePrivilegeLike = {
  fee?: number | string | null;
  pl?: number | string | null;
  dl?: number | string | null;
  st?: number | string | null;
  cp?: number | string | null;
  toast?: boolean | null;
};

export type NeteaseAvailabilityLike = {
  fee?: number | string | null;
  st?: number | string | null;
  cp?: number | string | null;
  copyright?: number | string | null;
  noCopyrightRcmd?: unknown | null;
  privilege?: NeteasePrivilegeLike | null;
};

function toNumber(value: number | string | null | undefined) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export function getNeteaseSongAvailability(song: NeteaseAvailabilityLike): SongAvailability | undefined {
  const privilege = song.privilege ?? {};
  const fee = toNumber(privilege.fee) ?? toNumber(song.fee) ?? 0;
  const playbackBitrate = toNumber(privilege.pl);
  const downloadBitrate = toNumber(privilege.dl);
  const status = toNumber(privilege.st) ?? toNumber(song.st);
  const copyrightProvider = toNumber(privilege.cp) ?? toNumber(song.cp);
  const hasCopyrightHint = Boolean(song.noCopyrightRcmd) || status !== null && status < 0;
  const hasPrivilegeSignal = playbackBitrate !== null || downloadBitrate !== null || fee > 0 || hasCopyrightHint || copyrightProvider !== null;

  if (!hasPrivilegeSignal) {
    return undefined;
  }

  const playbackLocked = playbackBitrate !== null && playbackBitrate <= 0;
  const downloadLocked = downloadBitrate !== null && downloadBitrate <= 0;
  const vipSong = fee === 1;
  const copyrightUnavailable = hasCopyrightHint || playbackLocked && !vipSong;

  return {
    playback: copyrightUnavailable
      ? {
          status: "copyright",
          locked: true,
          label: "无版权",
          reason: "网易云当前没有开放这首歌的可播放音源。"
        }
      : vipSong
        ? {
            status: "vip",
            locked: playbackLocked,
            label: "VIP",
            reason: playbackLocked ? "这首歌需要黑胶 VIP 才能播放。" : "这首歌属于 VIP 音源，当前账号可播放。"
          }
        : {
            status: "available",
            locked: false,
            label: "可播放",
            reason: "当前账号可播放该音源。"
          },
    download: copyrightUnavailable
      ? {
          status: "copyright",
          locked: true,
          label: "无版权",
          reason: "网易云当前没有开放这首歌的可下载音源。"
        }
      : vipSong
        ? {
            status: "vip",
            locked: downloadLocked,
            label: "VIP",
            reason: downloadLocked ? "这首歌需要黑胶 VIP 才能下载。" : "这首歌属于 VIP 音源，当前账号可下载。"
          }
        : downloadLocked
          ? {
              status: "restricted",
              locked: false,
              label: "下载受限",
              reason: "网易云没有返回明确的下载权限，下载时会再次校验。"
            }
          : {
              status: "available",
              locked: false,
              label: "可下载",
              reason: "当前账号可下载该音源。"
            }
  };
}
