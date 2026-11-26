import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { MusicPlatform } from "#shared";
import { useSettingsQuery } from "./use-settings-query.js";

/**
 * Synchronizes the selected music platform (`netease` | `qq` | `kugou`) with the URL `?platform=` search param,
 * falling back to user settings (`providerMode`) when no explicit platform is in the URL.
 */
export function usePlatformParam() {
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsQuery = useSettingsQuery();

  const urlPlatform = searchParams.get("platform");
  const hasExplicitPlatform = urlPlatform === "netease" || urlPlatform === "qq" || urlPlatform === "kugou";
  const savedMode = settingsQuery.data?.settings.providerMode;
  const defaultPlatform: MusicPlatform =
    savedMode === "qq" ? "qq" : savedMode === "kugou" ? "kugou" : "netease";
  const platform: MusicPlatform = hasExplicitPlatform ? urlPlatform : defaultPlatform;
  const platformReady = hasExplicitPlatform || !settingsQuery.isPending;

  const setPlatform = useCallback(
    (next: MusicPlatform) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("platform", next);
      setSearchParams(nextParams);
    },
    [searchParams, setSearchParams],
  );

  return {
    platform,
    platformReady,
    hasExplicitPlatform,
    setPlatform,
  };
}
