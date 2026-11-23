import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PlayerStateSchema,
  SearchHistoryInputSchema,
  SongSchema,
  UpdateUserSettingsInputSchema,
} from "#shared";
import type { UserStateRepository } from "../../../infrastructure/db/repositories/user-state-repository.js";
import { requireActor } from "../auth-plugin.js";

export function registerUserStateRoutes(
  app: FastifyInstance,
  deps: { userStateRepo: UserStateRepository },
): void {
  const { userStateRepo } = deps;

  app.get("/api/settings", async (request) => {
    const actor = requireActor(request);
    return { settings: userStateRepo.getSettings(actor.userId) };
  });

  app.patch("/api/settings", async (request) => {
    const actor = requireActor(request);
    const patch = UpdateUserSettingsInputSchema.parse(request.body);
    return { settings: userStateRepo.updateSettings(actor.userId, patch) };
  });

  app.get("/api/player-state", async (request) => {
    const actor = requireActor(request);
    return { state: userStateRepo.getPlayerState(actor.userId) };
  });

  app.put("/api/player-state", async (request) => {
    const actor = requireActor(request);
    const input = PlayerStateSchema.parse(request.body);
    return { state: userStateRepo.savePlayerState(actor.userId, input) };
  });

  app.get("/api/history/play", async (request) => {
    const actor = requireActor(request);
    return { items: userStateRepo.getPlayHistory(actor.userId) };
  });

  app.post("/api/history/play", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ song: SongSchema }).parse(request.body);
    return { items: userStateRepo.recordPlayHistory(actor.userId, body.song) };
  });

  app.delete("/api/history/play", async (request) => {
    const actor = requireActor(request);
    userStateRepo.clearPlayHistory(actor.userId);
    return { items: [] };
  });

  app.get("/api/history/search", async (request) => {
    const actor = requireActor(request);
    return { items: userStateRepo.getSearchHistory(actor.userId) };
  });

  app.post("/api/history/search", async (request) => {
    const actor = requireActor(request);
    const { keyword } = SearchHistoryInputSchema.parse(request.body);
    return { items: userStateRepo.addSearchHistory(actor.userId, keyword) };
  });

  app.delete("/api/history/search", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ keyword: z.string().optional() }).parse(request.query);
    if (query.keyword !== undefined) {
      const trimmed = query.keyword.trim();
      if (!trimmed) {
        return { items: userStateRepo.getSearchHistory(actor.userId) };
      }
      return { items: userStateRepo.removeSearchHistory(actor.userId, trimmed) };
    }
    userStateRepo.clearSearchHistory(actor.userId);
    return { items: [] };
  });
}
