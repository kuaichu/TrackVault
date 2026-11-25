import { expect, test } from "@playwright/test";
import { makeRf64Fixture, makeWaveBuffer } from "../fixtures/audio-fixtures.mjs";
import { setupMockApp } from "../fixtures/mock-app.mjs";
import { E2E_ORIGIN } from "../playwright.config.mjs";

const songTitleButton = (page, n) =>
  page.getByRole("main").getByRole("button", { name: `云盘歌曲 ${n}`, exact: true });

test("cloud pagination failure preserves loaded rows and partial retry completes play-all", async ({ page }) => {
  const state = await setupMockApp(page, { titlePrefix: "云盘歌曲" });
  state.faultCloud = true;

  await page.goto(`${E2E_ORIGIN}/cloud`);
  await expect(songTitleButton(page, 2)).toBeVisible();

  await page.getByRole("button", { name: "播放全部", exact: true }).click();
  const retryButton = page.getByRole("button", { name: "重试加载更多" });
  await expect(retryButton).toBeVisible();
  await expect(songTitleButton(page, 2)).toBeVisible();
  expect(state.streams).toEqual([]);

  state.faultCloud = false;
  await retryButton.click();
  await expect(page.getByText("已加载 101 / 101 首")).toBeVisible();

  await page.getByRole("button", { name: "播放全部", exact: true }).click();
  await expect(page.locator("footer")).toContainText("云盘歌曲 1");
  await expect.poll(() => state.streams.some((entry) => entry.id === "1")).toBe(true);
  expect(state.offsets.filter((offset) => offset === 0)).toHaveLength(1);
});

test("selecting another track prevents in-flight cloud play-all tail from hijacking playback", async ({ page }) => {
  const state = await setupMockApp(page, { titlePrefix: "云盘歌曲" });
  state.hold();

  try {
    await page.goto(`${E2E_ORIGIN}/cloud`);
    await expect(songTitleButton(page, 2)).toBeVisible();

    await page.getByRole("button", { name: "播放全部", exact: true }).click();
    await expect.poll(() => state.offsets.includes(100)).toBe(true);

    await songTitleButton(page, 2).click();
    await expect(page.locator("footer")).toContainText("云盘歌曲 2");
    await expect.poll(() => state.streams.some((entry) => entry.id === "2")).toBe(true);

    state.release();
    await expect(page.getByRole("button", { name: "播放全部", exact: true })).toBeEnabled();
    await expect(page.getByText("已加载 101 / 101 首")).toBeVisible();
    await expect(page.locator("footer")).toContainText("云盘歌曲 2");
  } finally {
    state.release();
  }
});

test("Chromium decodes complete WAV & RF64 buffers and rejects truncated copies", async ({ page }) => {
  const wave = makeWaveBuffer(1);
  const rf64 = makeRf64Fixture();
  const samples = [wave, wave.subarray(0, 60), rf64.rf64, rf64.rf64Quarter].map((buf) =>
    buf.toString("base64"),
  );

  const results = await page.evaluate(async (encodedSamples) => {
    const ctx = new AudioContext({ sampleRate: 8000 });
    const out = [];
    try {
      for (const data of encodedSamples) {
        try {
          const raw = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
          const pcm = await ctx.decodeAudioData(raw.buffer);
          out.push({ frames: pcm.length });
        } catch (err) {
          out.push({ error: err instanceof Error ? err.name : String(err) });
        }
      }
    } finally {
      await ctx.close();
    }
    return out;
  }, samples);

  expect(results[0]).toEqual({ frames: 8000 });
  expect(results[1]?.error).toBe("EncodingError");
  expect(results[2]).toEqual({ frames: 8000 });
  expect(results[3]?.frames).not.toBe(8000);
});

test("native dblclick triggers once while two independent Enter activations trigger twice", async ({ page }) => {
  const state = await setupMockApp(page, { titlePrefix: "云盘歌曲" });
  await page.goto(`${E2E_ORIGIN}/cloud`);
  const songButton = songTitleButton(page, 2);
  await expect(songButton).toBeVisible();

  await songButton.evaluate((el) => {
    window.__e2eClickDetails = [];
    el.addEventListener("click", (ev) => {
      window.__e2eClickDetails.push(ev.detail);
    });
  });

  await songButton.dblclick();
  await expect.poll(() => state.streams.length).toBe(1);

  await songButton.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.streams.length).toBe(2);

  await page.keyboard.press("Enter");
  await expect.poll(() => state.streams.length).toBe(3);

  const details = await page.evaluate(() => window.__e2eClickDetails);
  expect(details).toEqual([1, 2, 0, 0]);
});
