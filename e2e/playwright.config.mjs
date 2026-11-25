import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const E2E_WEB_DIST = process.env.E2E_WEB_DIST
  ? path.resolve(process.env.E2E_WEB_DIST)
  : path.resolve(__dirname, "../apps/web/dist");

export const E2E_ORIGIN = process.env.E2E_BASE_URL || "http://127.0.0.1:4173";

export default defineConfig({
  testDir: path.resolve(__dirname, "specs"),
  outputDir: path.resolve(__dirname, "test-results"),
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.resolve(__dirname, "../playwright-report") }],
  ],
  use: {
    baseURL: E2E_ORIGIN,
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "on-first-retry",
  },
});
