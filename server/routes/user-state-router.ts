import express from "express";
import type { PersistedPlayerState, Song } from "../types.js";

export type UserStateRouterDependencies = {
  getDataScopeId: () => Promise<string>;
  getSearchHistory: (dataScopeId: string) => Promise<string[]>;
  saveSearchHistory: (items: string[], dataScopeId: string) => Promise<string[]>;
  removeSearchHistory: (keyword: string, dataScopeId: string) => Promise<string[]>;
  getPlayHistory: (dataScopeId: string) => Promise<Song[]>;
  savePlayHistory: (items: Song[], dataScopeId: string) => Promise<Song[]>;
  getPlayerState: (dataScopeId: string) => Promise<PersistedPlayerState>;
  savePlayerState: (state: PersistedPlayerState, dataScopeId: string) => Promise<PersistedPlayerState>;
};

async function resolveRequestDataScope(
  request: express.Request,
  response: express.Response,
  getDataScopeId: UserStateRouterDependencies["getDataScopeId"]
) {
  const expectedDataScopeId = request.header("x-data-scope-id")?.trim() ?? "";
  const currentDataScopeId = await getDataScopeId();
  if (!expectedDataScopeId || expectedDataScopeId !== currentDataScopeId) {
    response.status(409).json({ message: "账号数据作用域已变化，请重试。" });
    return null;
  }

  return currentDataScopeId;
}

export function createUserStateRouter(dependencies: UserStateRouterDependencies) {
  const router = express.Router();

  router.get("/api/history/search", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    response.json({ items: await dependencies.getSearchHistory(dataScopeId) });
  });

  router.put("/api/history/search", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    response.json({ items: await dependencies.saveSearchHistory(items, dataScopeId) });
  });

  router.delete("/api/history/search", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    const keyword = typeof request.query.keyword === "string" ? request.query.keyword : "";
    response.json({ items: await dependencies.removeSearchHistory(keyword, dataScopeId) });
  });

  router.get("/api/history/play", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    response.json({ items: await dependencies.getPlayHistory(dataScopeId) });
  });

  router.put("/api/history/play", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    response.json({ items: await dependencies.savePlayHistory(items, dataScopeId) });
  });

  router.get("/api/player-state", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    response.json(await dependencies.getPlayerState(dataScopeId));
  });

  router.put("/api/player-state", async (request, response) => {
    const dataScopeId = await resolveRequestDataScope(request, response, dependencies.getDataScopeId);
    if (!dataScopeId) return;
    response.json(await dependencies.savePlayerState(request.body, dataScopeId));
  });

  return router;
}
