# TrackVault v2 Browser E2E Suite

Optional Playwright browser regression suite targeting the built frontend bundle (`apps/web/dist`) with deterministic API route mocks. It is intentionally isolated from `npm test`, `npm run typecheck`, `npm run lint`, and Docker production builds.

## Prerequisites

1. Build the shared packages and frontend bundle:
   ```bash
   npm run build:web
   ```
2. Install Playwright and Chromium locally (not bundled in root production/dev dependencies):
   ```bash
   npx playwright install chromium
   ```
   If `@playwright/test` is not yet installed in your local environment, install it without modifying `package-lock.json` (`npm i --no-save @playwright/test`) or run via a global/CI Playwright environment.

## Running E2E Tests

```bash
npx playwright test --config e2e/playwright.config.mjs
```

### Environment Overrides

- `E2E_WEB_DIST`: Custom path to built web static assets (defaults to `../apps/web/dist`).
- `E2E_BASE_URL`: Custom origin URL for browser routing (defaults to `http://127.0.0.1:4173`).

## Covered Regression Scenarios

- `specs/smoke.spec.mjs`: Authenticated shell boot, primary route navigation, and idle player bar.
- `specs/cloud-and-media.spec.mjs`: Cloud pagination failure recovery, anti-hijack when switching tracks during "Play All", Web Audio `decodeAudioData` WAV integrity, and keyboard `Enter` vs `dblclick` activation semantics.
- `specs/playback-and-fm.spec.mjs`: Late cloud pagination preserving cleared queue, skipping locked first track on "Play All", and FM quality switch persistence across batch fetches and failures.
