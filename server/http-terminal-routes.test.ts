import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { registerTerminalRoutes } from "./http-terminal-routes.js";
import { withTestRouter } from "./routes/router-test-http.js";

test("serves API, static assets, asset 404, and SPA fallback in composition order", async () => {
  const clientDistDir = await mkdtemp(path.join(tmpdir(), "trackvault-terminal-routes-"));

  try {
    await mkdir(path.join(clientDistDir, "assets"));
    await writeFile(path.join(clientDistDir, "index.html"), "<main>TrackVault SPA</main>");
    await writeFile(path.join(clientDistDir, "assets", "app.js"), "console.log('asset');");

    const router = express.Router();
    router.use(express.static(clientDistDir));
    router.get("/api/fake", (_request, response) => {
      response.json({ source: "api" });
    });
    registerTerminalRoutes(router, clientDistDir);

    await withTestRouter([router], async ({ request, requestRaw }) => {
      assert.deepEqual(await request("/api/fake"), {
        status: 200,
        body: { source: "api" }
      });

      const assetResponse = await requestRaw("/assets/app.js");
      assert.equal(assetResponse.status, 200);
      assert.equal(await assetResponse.text(), "console.log('asset');");

      assert.deepEqual(await request("/assets/missing.js"), {
        status: 404,
        body: { message: "静态资源不存在，请刷新页面获取最新版本。" }
      });

      const fallbackResponse = await requestRaw("/ordinary/unknown/path");
      assert.equal(fallbackResponse.status, 200);
      assert.equal(fallbackResponse.headers.get("cache-control"), "no-store");
      assert.equal(await fallbackResponse.text(), "<main>TrackVault SPA</main>");
    });
  } finally {
    await rm(clientDistDir, { recursive: true, force: true });
  }
});
