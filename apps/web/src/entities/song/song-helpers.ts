import type { Song } from "#shared";

export function isSongPlayable(song: Song | undefined): song is Song {
  return Boolean(song && !song.availability?.playback.locked);
}

/**
 * Returns the first playable track in `songs`, skipping locked/unavailable leading tracks.
 */
export function findFirstPlayableSong(songs: readonly Song[]): Song | null {
  for (const song of songs) {
    if (isSongPlayable(song)) {
      return song;
    }
  }
  return null;
}
