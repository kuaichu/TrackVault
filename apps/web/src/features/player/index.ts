export const loadFullscreenPlayer = () =>
  import("./components/FullscreenPlayer.js").then((m) => ({ default: m.FullscreenPlayer }));
export { LyricScroller } from "./components/LyricScroller.js";
export { MiniProgressStripe, PlaybackProgressBar } from "./components/PlaybackProgressBar.js";
export { PlayerBar } from "./components/PlayerBar.js";
export { PlayQueuePanel, TrackCommentsPanel } from "./components/PlayerDrawerPanels.js";
export { RightDrawer } from "./components/RightDrawer.js";
export {
  AudioEngine,
  KEEPALIVE_MAX_BYTES,
  audioEngine,
  buildBoundedKeepalivePlayerState,
  resolveEffectivePlaybackQuality,
  serializeQueueWindow,
  type PlaybackSessionSnapshot,
} from "./engine/audio-engine.js";
export { useTrackLyricsQuery } from "./hooks/use-track-lyrics-query.js";
export { type RightDrawerTab, usePlaybackClockStore, usePlayerStore } from "./store/player-store.js";
export {
  abortPlayHistoryClear,
  applyClearedPlayHistory,
  applyRecordedPlayHistory,
  beginPlayHistoryClear,
  beginPlayHistoryRecord,
  fetchSyncedPlayHistory,
  type PlayHistoryPayload,
} from "./sync/play-history-sync.js";
