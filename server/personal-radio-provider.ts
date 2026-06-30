import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import { collectNeteaseSongs } from "./netease-song-mapper.js";
import type { PersonalRadioKind, Song } from "./types.js";

const require = createRequire(import.meta.url);
const neteaseApi = require("NeteaseCloudMusicApi") as {
  personal_fm: (params: Record<string, unknown>) => Promise<{ body: unknown }>;
  personal_fm_mode?: (params: Record<string, unknown>) => Promise<{ body: unknown }>;
};

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("请先在设置页填写网易云登录态 Cookie。");
  }

  return cookie;
}

function getModeForKind(kind: PersonalRadioKind) {
  return kind === "roaming" ? "EXPLORE" : "DEFAULT";
}

function getSourceForKind(kind: PersonalRadioKind) {
  return kind === "roaming" ? "netease-personal-roaming" : "netease-personal-radar";
}

export async function getPersonalRadioSongs(kind: PersonalRadioKind): Promise<Song[]> {
  const cookie = await getCookie();
  const source = getSourceForKind(kind);
  const mode = getModeForKind(kind);
  const response = neteaseApi.personal_fm_mode
    ? await neteaseApi.personal_fm_mode({ cookie, mode, limit: 12 })
    : await neteaseApi.personal_fm({ cookie });
  let songs = collectNeteaseSongs(response.body, source, 12);

  if (songs.length === 0 && kind === "radar" && neteaseApi.personal_fm_mode) {
    const fallbackResponse = await neteaseApi.personal_fm({ cookie });
    songs = collectNeteaseSongs(fallbackResponse.body, source, 12);
  }

  if (songs.length === 0) {
    throw new Error(kind === "roaming" ? "暂时没有读取到私人漫游歌曲。" : "暂时没有读取到私人雷达歌曲。");
  }

  return songs;
}
