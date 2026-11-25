import { expect, test } from "@playwright/test";
import { setupMockApp } from "../fixtures/mock-app.mjs";
import { E2E_ORIGIN } from "../playwright.config.mjs";

const exactButton = (locator, name) => locator.getByRole("button", { name, exact: true });
const cloudSongButton = (page, index) => exactButton(page.getByRole("main"), `样例曲 ${index}`);

test("late cloud pagination preserves a queue that the user cleared", async ({ page }) => {
  const state = await setupMockApp(page, {
    titlePrefix: "样例曲",
    durationSeconds: 25,
    holdCloud: true,
  });

  try {
    await page.goto(`${E2E_ORIGIN}/cloud`);
    await expect(cloudSongButton(page, 2)).toBeVisible();

    await exactButton(page, "播放全部").click();
    await expect.poll(() => state.offsets.includes(100)).toBe(true);

    await cloudSongButton(page, 2).click();
    await expect.poll(() => state.streams.some((entry) => entry.id === "2")).toBe(true);

    await page.locator("footer").getByRole("button", { name: "播放队列", exact: true }).click();
    await expect(page.getByText("待播清单 · 100 首", { exact: true })).toBeVisible();

    await exactButton(page, "清空").click();
    await expect(page.getByText("队列为空", { exact: true })).toBeVisible();

    state.release();
    await expect(page.getByText("已加载 101 / 101 首")).toBeVisible();
    await expect(exactButton(page, "播放全部")).toBeEnabled();
    await expect(page.getByText("队列为空", { exact: true })).toBeVisible();
  } finally {
    state.release();
  }
});

for (const tailAlreadyLoaded of [false, true]) {
  test(`cloud play-all skips locked first track (tailLoaded=${tailAlreadyLoaded})`, async ({ page }) => {
    const state = await setupMockApp(page, {
      titlePrefix: "样例曲",
      durationSeconds: 25,
      lockFirst: true,
    });

    await page.goto(`${E2E_ORIGIN}/cloud`);
    await expect(cloudSongButton(page, 2)).toBeVisible();

    if (tailAlreadyLoaded) {
      await exactButton(page, "加载更多").click();
      await expect(page.getByText("已加载 101 / 101 首")).toBeVisible();
    }

    await exactButton(page, "播放全部").click();
    await expect.poll(() => state.streams.length).toBeGreaterThan(0);
    expect(state.streams[0]?.id).toBe("2");
  });
}

for (const failNextBatch of [false, true]) {
  test(`FM quality selection persists to next fetched track (batchFailed=${failNextBatch})`, async ({
    page,
  }) => {
    const state = await setupMockApp(page, {
      titlePrefix: "样例曲",
      durationSeconds: 25,
      holdFm: true,
      failFm: failNextBatch,
    });

    const main = page.getByRole("main");
    const footer = page.locator("footer");

    try {
      await page.goto(`${E2E_ORIGIN}/fm`);
      await exactButton(main, "播放").click();
      await expect.poll(() => state.streams.some((entry) => entry.id === "FM-A")).toBe(true);

      await exactButton(main, "下一首").click();
      await expect.poll(() => state.fmCalls).toBe(2);

      await footer.getByTitle("切换试听音质").click();
      await exactButton(footer, "FLAC 无损").click();
      expect(state.streams.map((entry) => entry.id)).toEqual(["FM-A"]);

      state.release();
      if (failNextBatch) {
        await expect(exactButton(main, "换一批")).toBeEnabled();
        await exactButton(main, "下一首").click();
      }

      await expect.poll(() => state.streams.some((entry) => entry.id === "FM-B")).toBe(true);
      expect(state.streams.at(-1)).toEqual({ id: "FM-B", level: "lossless" });
    } finally {
      state.release();
    }
  });
}
