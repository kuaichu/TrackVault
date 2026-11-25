import { expect, test } from "@playwright/test";
import { setupMockApp } from "../fixtures/mock-app.mjs";
import { E2E_ORIGIN } from "../playwright.config.mjs";

test("renders authenticated shell and navigates core routes", async ({ page }) => {
  await setupMockApp(page);
  await page.goto(`${E2E_ORIGIN}/discover`);

  await expect(page.locator("footer")).toContainText("未在播放");
  await expect(page.getByRole("link", { name: "云盘" })).toBeVisible();

  await page.getByRole("link", { name: "云盘" }).click();
  await expect(page).toHaveURL(/\/cloud$/);
  await expect(page.getByRole("heading", { name: "云盘" })).toBeVisible();

  await page.getByRole("link", { name: "私人漫游" }).click();
  await expect(page).toHaveURL(/\/fm$/);
  await expect(page.getByRole("heading", { name: "私人漫游" })).toBeVisible();
});
