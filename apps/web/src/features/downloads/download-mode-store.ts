import { create } from "zustand";
import type { DownloadMode } from "#shared";

const STORAGE_KEY = "tv_download_mode";

function readInitialDownloadMode(): DownloadMode {
  if (typeof window === "undefined") return "tagged_server";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "tagged_server" || saved === "direct_link") {
      return saved;
    }
  } catch {
    // Ignore storage access restrictions
  }
  return "tagged_server";
}

interface DownloadModeStore {
  downloadMode: DownloadMode;
  setDownloadMode(mode: DownloadMode): void;
  reset(): void;
}

export const useDownloadModeStore = create<DownloadModeStore>((set) => ({
  downloadMode: readInitialDownloadMode(),
  setDownloadMode(mode) {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, mode);
      }
    } catch {
      // Ignore storage access restrictions
    }
    set({ downloadMode: mode });
  },
  reset() {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Ignore storage access restrictions
    }
    set({ downloadMode: "tagged_server" });
  },
}));
