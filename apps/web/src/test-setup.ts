import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { clearPendingDirectLinkJobs } from "./features/downloads/index.js";
import { audioEngine, usePlaybackClockStore, usePlayerStore } from "./features/player/index.js";
import { useToastStore } from "./shared/store/toast-store.js";

if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
}

afterEach(() => {
  cleanup();
  audioEngine.stop();
  usePlayerStore.getState().reset();
  usePlaybackClockStore.getState().setClock({ currentTime: 0, duration: 0, bufferedTime: 0 });
  useToastStore.getState().clear();
  clearPendingDirectLinkJobs();
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
});
