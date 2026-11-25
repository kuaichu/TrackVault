import path from "node:path";
import { E2E_ORIGIN, E2E_WEB_DIST } from "../playwright.config.mjs";
import { makeWaveBuffer } from "./audio-fixtures.mjs";

const CONTENT_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/**
 * Builds a Song payload conforming to SongSchema.
 * @param {string | number} id
 * @param {{ titlePrefix?: string, locked?: boolean, durationSeconds?: number }} [opts]
 */
export function makeSong(id, opts = {}) {
  const { titlePrefix = "测试曲目", locked = false, durationSeconds = 20 } = opts;
  const mins = String(Math.floor(durationSeconds / 60)).padStart(2, "0");
  const secs = String(durationSeconds % 60).padStart(2, "0");

  return {
    id: String(id),
    platform: "netease",
    title: `${titlePrefix} ${id}`,
    artist: "测试乐手",
    album: "测试专辑",
    duration: `${mins}:${secs}`,
    durationSeconds,
    quality: "128K",
    availableQualities: [
      { level: "standard", label: "128K 标准" },
      { level: "lossless", label: "FLAC 无损" },
    ],
    ...(locked
      ? {
          availability: {
            playback: {
              locked: true,
              status: "vip",
              label: "VIP",
              reason: "此曲目需要 VIP 权限",
            },
            download: {
              locked: true,
              status: "vip",
              label: "VIP",
              reason: "此曲目需要 VIP 权限",
            },
          },
        }
      : {}),
  };
}

/**
 * Intercepts all requests on a Playwright page, serving built `apps/web/dist` assets
 * and deterministic API fixtures.
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   titlePrefix?: string,
 *   durationSeconds?: number,
 *   holdCloud?: boolean,
 *   lockFirst?: boolean,
 *   holdFm?: boolean,
 *   failFm?: boolean,
 * }} [options]
 */
export async function setupMockApp(page, options = {}) {
  const {
    titlePrefix = "测试曲目",
    durationSeconds = 20,
    holdCloud = false,
    lockFirst = false,
    holdFm = false,
    failFm = false,
  } = options;

  const wave = makeWaveBuffer(durationSeconds);
  const pageOne = Array.from({ length: 100 }, (_, idx) =>
    makeSong(idx + 1, {
      titlePrefix,
      durationSeconds,
      locked: lockFirst && idx === 0,
    }),
  );

  let releaseGate;
  const state = {
    offsets: [],
    streams: [],
    fmCalls: 0,
    faultCloud: false,
    gate: holdCloud || holdFm ? new Promise((resolve) => { releaseGate = resolve; }) : null,
    hold() {
      state.gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
    },
    release() {
      releaseGate?.();
      state.gate = null;
    },
  };

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;

    if (url.origin !== E2E_ORIGIN) {
      return route.abort();
    }

    if (!pathname.startsWith("/api/")) {
      const safeRel = pathname.startsWith("/assets/")
        ? path.join("assets", path.basename(pathname))
        : "index.html";
      const filePath = path.join(E2E_WEB_DIST, safeRel);
      const ext = path.extname(filePath);
      return route.fulfill({
        path: filePath,
        contentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      });
    }

    if (pathname === "/api/events") {
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": e2e-fixture\n\n",
      });
    }

    if (pathname === "/api/media/stream") {
      const id = url.searchParams.get("id");
      const level = url.searchParams.get("level");
      state.streams.push({ id, level });
      if (lockFirst && id === "1") {
        return route.fulfill({
          status: 422,
          json: { error: { code: "VIP_REQUIRED", message: "此曲目需要 VIP 权限" } },
        });
      }
      return route.fulfill({ contentType: "audio/wav", body: wave });
    }

    let data = {};
    if (pathname === "/api/auth/status") {
      data = {
        authenticated: true,
        initialized: true,
        user: {
          id: "e2e-user",
          username: "e2e",
          role: "member",
          trustedFallback: false,
          createdAt: 1_700_000_000_000,
        },
      };
    } else if (pathname === "/api/settings") {
      data = {
        settings: {
          providerMode: "netease",
          defaultPlaybackQuality: "standard",
          defaultDownloadQuality: "lossless",
          maxConcurrentDownloads: 2,
          startupView: "discover",
        },
      };
    } else if (pathname === "/api/player-state") {
      data = {
        state: {
          currentTrack: null,
          playQueue: [],
          playbackSeconds: 0,
          volume: 0.1,
          playbackMode: "sequential",
        },
      };
    } else if (pathname === "/api/jobs") {
      data = { jobs: [], serverRevision: 1, clearedBeforeRevision: 0 };
    } else if (pathname.startsWith("/api/likes/")) {
      data = { ids: [], liked: false };
    } else if (pathname.startsWith("/api/lyrics/")) {
      data = { songId: "1", platform: "netease", lines: [], source: "none" };
    } else if (pathname === "/api/history/play") {
      data = { items: [], revision: 0 };
    } else if (pathname === "/api/cloud/songs") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      state.offsets.push(offset);
      if (offset === 100 && state.gate) {
        await state.gate;
      }
      if (offset === 100 && state.faultCloud) {
        return route.fulfill({
          status: 503,
          json: { error: { code: "UPSTREAM_ERROR", message: "后续页临时不可用" } },
        });
      }
      data = {
        songs:
          offset === 0
            ? pageOne
            : offset === 100
              ? [makeSong(101, { titlePrefix, durationSeconds })]
              : [],
        total: 101,
        offset,
        nextOffset: offset === 0 ? 100 : 101,
        limit: 100,
        hasMore: offset === 0,
      };
    } else if (pathname === "/api/fm") {
      state.fmCalls += 1;
      const callIndex = state.fmCalls;
      if (holdFm && callIndex === 2 && state.gate) {
        await state.gate;
        if (failFm) {
          return route.fulfill({
            status: 503,
            json: { error: { code: "UPSTREAM_ERROR", message: "本次换批失败" } },
          });
        }
      }
      data = {
        songs: [makeSong(callIndex === 1 ? "FM-A" : "FM-B", { titlePrefix, durationSeconds })],
      };
    } else if (pathname !== "/api/capabilities") {
      data = { songs: [], playlists: [], charts: [], items: [] };
    }

    return route.fulfill({ json: data });
  });

  return state;
}
