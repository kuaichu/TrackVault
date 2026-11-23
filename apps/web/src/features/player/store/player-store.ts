import { create } from "zustand";
import {
  type PlaybackMode,
  type PreferenceQualityLevel,
  type QualityLevel,
  type Song,
  getSongKey,
} from "#shared";

export type RightDrawerTab = "queue" | "lyrics" | "comments";

interface PlayerStateStore {
  currentTrack: Song | null;
  queue: Song[];
  isPlaying: boolean;
  isLoading: boolean;
  volume: number;
  playbackMode: PlaybackMode;
  /** Playback quality preference synced from server settings; strictly isolated from download quality. */
  defaultPlaybackQuality: PreferenceQualityLevel;
  /** Per-track playback quality override chosen in the player bar (does NOT mutate download settings). */
  activeQualityOverride: QualityLevel | null;
  playerError: string | null;
  fullscreenOpen: boolean;
  drawerOpen: boolean;
  drawerTab: RightDrawerTab;
  hydrated: boolean;

  setStatePatch(patch: Partial<PlayerStateStore>): void;
  addToQueue(song: Song): void;
  insertNextInQueue(song: Song): void;
  removeFromQueue(songKey: string): void;
  clearQueue(): void;
  setFullscreenOpen(open: boolean): void;
  setDrawerOpen(open: boolean): void;
  setDrawerTab(tab: RightDrawerTab): void;
  toggleDrawerTab(tab: RightDrawerTab): void;
  reset(): void;
}

const INITIAL_PLAYER_STATE = {
  currentTrack: null as Song | null,
  queue: [] as Song[],
  isPlaying: false,
  isLoading: false,
  volume: 0.85,
  playbackMode: "sequential" as PlaybackMode,
  defaultPlaybackQuality: "exhigh" as PreferenceQualityLevel,
  activeQualityOverride: null as QualityLevel | null,
  playerError: null as string | null,
  fullscreenOpen: false,
  drawerOpen: false,
  drawerTab: "queue" as RightDrawerTab,
  hydrated: false,
};

/**
 * Low-frequency player metadata store.
 * NEVER holds `currentTime` or `bufferedTime` so 4Hz timeupdate events NEVER re-render the app shell or song lists.
 */
export const usePlayerStore = create<PlayerStateStore>((set) => ({
  ...INITIAL_PLAYER_STATE,

  setStatePatch(patch) {
    set(patch);
  },

  addToQueue(song) {
    set((state) => {
      const targetKey = getSongKey(song);
      if (state.queue.some((item) => getSongKey(item) === targetKey)) {
        return state;
      }
      return { queue: [...state.queue, song] };
    });
  },

  insertNextInQueue(song) {
    set((state) => {
      const targetKey = getSongKey(song);
      const filtered = state.queue.filter((item) => getSongKey(item) !== targetKey);
      if (!state.currentTrack) {
        return { queue: [song, ...filtered] };
      }
      const curKey = getSongKey(state.currentTrack);
      const curIdx = filtered.findIndex((item) => getSongKey(item) === curKey);
      if (curIdx < 0) {
        return { queue: [song, ...filtered] };
      }
      const next = [...filtered];
      next.splice(curIdx + 1, 0, song);
      return { queue: next };
    });
  },

  removeFromQueue(songKey) {
    set((state) => ({
      queue: state.queue.filter((item) => getSongKey(item) !== songKey),
    }));
  },

  clearQueue() {
    set({ queue: [] });
  },

  setFullscreenOpen(open) {
    set({ fullscreenOpen: open });
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open });
  },

  setDrawerTab(tab) {
    set({ drawerTab: tab, drawerOpen: true });
  },

  toggleDrawerTab(tab) {
    set((state) => {
      if (state.drawerOpen && state.drawerTab === tab) {
        return { drawerOpen: false };
      }
      return { drawerOpen: true, drawerTab: tab };
    });
  },

  reset() {
    set({ ...INITIAL_PLAYER_STATE, queue: [] });
  },
}));

interface PlaybackClockState {
  currentTime: number;
  duration: number;
  bufferedTime: number;
  setClock(patch: Partial<Pick<PlaybackClockState, "currentTime" | "duration" | "bufferedTime">>): void;
}

/**
 * High-frequency playback clock store (~4Hz).
 * Subscribed ONLY by leaf `<ProgressBar />` and `<LyricScroller />` components.
 */
export const usePlaybackClockStore = create<PlaybackClockState>((set) => ({
  currentTime: 0,
  duration: 0,
  bufferedTime: 0,
  setClock(patch) {
    set(patch);
  },
}));
