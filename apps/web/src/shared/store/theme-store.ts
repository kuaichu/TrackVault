import { create } from "zustand";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "tv_theme_preference";

function readInitialPreference(): ThemePreference {
  if (typeof window === "undefined") return "dark";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") {
      return saved;
    }
  } catch {
    // Ignore storage restriction
  }
  return "dark";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref !== "system") return pref;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyThemeToDocument(resolved: ResolvedTheme, disableTransitions = false): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (disableTransitions) {
    root.classList.add("tv-theme-switching");
  }
  root.dataset.theme = resolved;
  if (disableTransitions) {
    void root.offsetHeight;
    window.requestAnimationFrame(() => {
      root.classList.remove("tv-theme-switching");
    });
  }
}

interface ThemeStore {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(pref: ThemePreference): void;
  toggleLightDark(): void;
}

const initialPref = readInitialPreference();
const initialResolved = resolveTheme(initialPref);
applyThemeToDocument(initialResolved);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  preference: initialPref,
  resolved: initialResolved,

  setPreference(pref) {
    const resolved = resolveTheme(pref);
    applyThemeToDocument(resolved, true);
    try {
      window.localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      // Ignore storage restriction
    }
    set({ preference: pref, resolved });
  },

  toggleLightDark() {
    const next: ThemePreference = get().resolved === "dark" ? "light" : "dark";
    get().setPreference(next);
  },
}));

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mql = window.matchMedia("(prefers-color-scheme: light)");
  mql.addEventListener("change", () => {
    const { preference } = useThemeStore.getState();
    if (preference === "system") {
      const resolved = resolveTheme("system");
      applyThemeToDocument(resolved);
      useThemeStore.setState({ resolved });
    }
  });
}
