import { create } from "zustand";

interface CanvasHeaderState {
  heroTitle: string | null;
  heroScrolledPast: boolean;
  setHeroTitle(title: string | null): void;
  setHeroScrolledPast(scrolledPast: boolean): void;
  resetHeroHeader(): void;
}

/**
 * Coordinates scroll-linked compact sticky title between page hero headers (`MediaDetailHeader`)
 * and the top macOS window chrome in `AppShell`.
 */
export const useCanvasHeaderStore = create<CanvasHeaderState>((set) => ({
  heroTitle: null,
  heroScrolledPast: false,
  setHeroTitle(heroTitle) {
    set({ heroTitle });
  },
  setHeroScrolledPast(heroScrolledPast) {
    set((prev) => (prev.heroScrolledPast === heroScrolledPast ? prev : { heroScrolledPast }));
  },
  resetHeroHeader() {
    set({ heroTitle: null, heroScrolledPast: false });
  },
}));
