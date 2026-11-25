import { create } from "zustand";
import type { PlaybackMode, PreferenceQualityLevel, QualityLevel, Song } from "#shared";

export type RightDrawerTab = "queue" | "lyrics" | "comments";

interface PlayerStateStore {
  currentTrack: Song | null;
  queue: Song[];
  /** Tracks explicitly scheduled via "下一首播放", prioritized over shuffle selection. */
  priorityQueue: Song[];
  isPlaying: boolean;
  isLoading: boolean;
  volume: number;
  muted: boolean;
  lastNonZeroVolume: number;
  playbackMode: PlaybackMode;
  /** Playback quality preference synced from server settings; strictly isolated from download quality. */
  defaultPlaybackQuality: PreferenceQualityLevel;
  /** Desired per-track / FM playback quality selected by the user (null follows defaultPlaybackQuality). */
  preferredTrackQuality: QualityLevel | null;
  /** Actual quality tier of the currently loaded `<audio>` stream for `currentTrack`. */
  loadedStreamQuality: QualityLevel | null;
  /** Whether AudioEngine is currently paginating Cloud tracks for "Play All". */
  cloudPlayAllLoading: boolean;
  playerError: string | null;
  fullscreenOpen: boolean;
  drawerOpen: boolean;
  drawerTab: RightDrawerTab;
  hydrated: boolean;
  /** Personal FM session state driven centrally by AudioEngine / FmController. */
  fmMode: boolean;
  fmQueue: Song[];
  fmLoading: boolean;
  fmError: string | null;

  setStatePatch(patch: Partial<PlayerStateStore>): void;
  setFullscreenOpen(open: boolean): void;
  setDrawerOpen(open: boolean): void;
  setDrawerTab(tab: RightDrawerTab): void;
  toggleDrawerTab(tab: RightDrawerTab): void;
  reset(): void;
}

const INITIAL_PLAYER_STATE = {
  currentTrack: null as Song | null,
  queue: [] as Song[],
  priorityQueue: [] as Song[],
  isPlaying: false,
  isLoading: false,
  volume: 0.85,
  muted: false,
  lastNonZeroVolume: 0.85,
  playbackMode: "sequential" as PlaybackMode,
  defaultPlaybackQuality: "exhigh" as PreferenceQualityLevel,
  preferredTrackQuality: null as QualityLevel | null,
  loadedStreamQuality: null as QualityLevel | null,
  cloudPlayAllLoading: false,
  playerError: null as string | null,
  fullscreenOpen: false,
  drawerOpen: false,
  drawerTab: "queue" as RightDrawerTab,
  hydrated: false,
  fmMode: false,
  fmQueue: [] as Song[],
  fmLoading: false,
  fmError: null as string | null,
};

/**
 * Low-frequency player metadata store.
 * NEVER holds `currentTime` or `bufferedTime` so 4Hz timeupdate events NEVER re-render the app shell or song lists.
 * Queue mutations must go through `audioEngine` so session tracking & remote persistence are never bypassed.
 */
export const usePlayerStore = create<PlayerStateStore>((set) => ({
  ...INITIAL_PLAYER_STATE,

  setStatePatch(patch) {
    set(patch);
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
    set({ ...INITIAL_PLAYER_STATE, queue: [], priorityQueue: [], fmQueue: [] });
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
