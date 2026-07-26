import path from "node:path";
import type { Router } from "express";

export function registerTerminalRoutes(app: Pick<Router, "get">, clientDistDir: string) {
  app.get("/assets/*", (_request, response) => {
    response.status(404).json({ message: "静态资源不存在，请刷新页面获取最新版本。" });
  });

  app.get("*", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(clientDistDir, "index.html"));
  });
}
