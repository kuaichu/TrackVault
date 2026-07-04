import type { ProviderTrack, TransferTrack } from "./types.js";

type QqSong = {
  songid?: number;
  songmid?: string;
  songname?: string;
  albumname?: string;
  interval?: number;
  singer?: Array<{ name?: string }>;
  pay?: {
    payplay?: number;
    paydownload?: number;
  };
  preview?: {
    trybegin?: number;
    tryend?: number;
  };
  switch?: number;
};

type QqPlaylistBody = {
  cdlist?: Array<{
    dissname?: string;
    songlist?: QqSong[];
  }>;
};

const QQ_HEADERS = {
  Referer: "https://y.qq.com/",
  "User-Agent": "Mozilla/5.0"
};

function getRawQqPlaylistId(playlistId: string) {
  return playlistId.trim().replace(/^qq:/i, "");
}

function decodeJsonPrefix(input: string) {
  const trimmed = input.trim();
  const callbackMatch = trimmed.match(/^[^(]+\((.*)\)$/s);
  return callbackMatch?.[1] ?? trimmed;
}

function getAvailability(song: QqSong): ProviderTrack["availability"] {
  if (Number(song.pay?.payplay ?? 0) > 0 || Number(song.pay?.paydownload ?? 0) > 0) {
    return {
      status: "vip_only",
      reason: "QQ 音乐搜索结果标记为付费或会员资源"
    };
  }

  if (Number(song.preview?.tryend ?? 0) > 0) {
    return {
      status: "trial_only",
      reason: "QQ 音乐仅返回试听片段"
    };
  }

  if (song.switch === 0) {
    return {
      status: "copyright_unavailable",
      reason: "QQ 音乐搜索结果标记为不可播放"
    };
  }

  return {
    status: "available"
  };
}

function qqSongToProviderTrack(song: QqSong): ProviderTrack | null {
  const id = song.songmid || (song.songid ? String(song.songid) : "");
  const title = song.songname?.trim();
  if (!id || !title) {
    return null;
  }

  return {
    provider: "qq",
    id,
    title,
    artists: song.singer?.map((artist) => artist.name?.trim()).filter((name): name is string => Boolean(name)) ?? [],
    album: song.albumname?.trim() || undefined,
    durationSeconds: Number.isFinite(song.interval) ? Number(song.interval) : undefined,
    availability: getAvailability(song),
    raw: song
  };
}

function qqSongToTransferTrack(song: QqSong): TransferTrack | null {
  const providerTrack = qqSongToProviderTrack(song);
  if (!providerTrack) {
    return null;
  }

  return {
    source: "qq",
    sourceTrackId: providerTrack.id,
    title: providerTrack.title,
    artists: providerTrack.artists,
    album: providerTrack.album,
    durationSeconds: providerTrack.durationSeconds
  };
}

export async function searchQqProviderTracks(track: TransferTrack): Promise<ProviderTrack[]> {
  const query = [track.title, track.artists[0]].filter(Boolean).join(" ");
  const url = new URL("https://c.y.qq.com/soso/fcgi-bin/client_search_cp");
  url.searchParams.set("p", "1");
  url.searchParams.set("n", "10");
  url.searchParams.set("w", query);
  url.searchParams.set("format", "json");

  const response = await fetch(url, { headers: QQ_HEADERS });
  if (!response.ok) {
    throw new Error(`QQ 音乐搜索失败，远程状态 ${response.status}`);
  }

  const body = JSON.parse(decodeJsonPrefix(await response.text())) as { data?: { song?: { list?: QqSong[] } } };
  return (body.data?.song?.list ?? []).map(qqSongToProviderTrack).filter((song): song is ProviderTrack => Boolean(song));
}

export async function loadQqPlaylistTransferTracks(playlistId: string): Promise<TransferTrack[]> {
  const url = new URL("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg");
  const rawPlaylistId = getRawQqPlaylistId(playlistId);
  if (!rawPlaylistId) {
    throw new Error("缺少 QQ 音乐歌单 ID。");
  }

  url.searchParams.set("type", "1");
  url.searchParams.set("json", "1");
  url.searchParams.set("utf8", "1");
  url.searchParams.set("onlysong", "0");
  url.searchParams.set("disstid", rawPlaylistId);
  url.searchParams.set("format", "json");

  const response = await fetch(url, { headers: QQ_HEADERS });
  if (!response.ok) {
    throw new Error(`QQ 音乐歌单读取失败，远程状态 ${response.status}`);
  }

  const body = JSON.parse(decodeJsonPrefix(await response.text())) as QqPlaylistBody;
  const songs = body.cdlist?.[0]?.songlist ?? [];
  return songs.map(qqSongToTransferTrack).filter((song): song is TransferTrack => Boolean(song));
}
