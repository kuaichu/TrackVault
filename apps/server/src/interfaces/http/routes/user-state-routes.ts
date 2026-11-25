import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  PlayerStateSchema,
  SearchHistoryInputSchema,
  SongSchema,
  UpdateUserSettingsInputSchema,
} from "#shared";
import type { UserStateService } from "../../../application/user-state/user-state-service.js";
import { requireActor } from "../auth-plugin.js";

export function registerUserStateRoutes(
  app: FastifyInstance,
  deps: { userStateService: UserStateService },
): void {
  const { userStateService } = deps;

  app.get("/api/settings", async (request) => {
    const actor = requireActor(request);
    return { settings: userStateService.getSettings(actor) };
  });

  app.patch("/api/settings", async (request) => {
    const actor = requireActor(request);
    const patch = UpdateUserSettingsInputSchema.parse(request.body);
    return { settings: userStateService.updateSettings(actor, patch) };
  });

  app.get("/api/player-state", async (request) => {
    const actor = requireActor(request);
    return { state: userStateService.getPlayerState(actor) };
  });

  app.put("/api/player-state", async (request) => {
    const actor = requireActor(request);
    const input = PlayerStateSchema.parse(request.body);
    return { state: userStateService.savePlayerState(actor, input) };
  });

  app.get("/api/history/play", async (request) => {
    const actor = requireActor(request);
    return userStateService.getPlayHistory(actor);
  });

  app.post("/api/history/play", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ song: SongSchema }).parse(request.body);
    return userStateService.recordPlayHistory(actor, body.song);
  });

  app.delete("/api/history/play", async (request) => {
    const actor = requireActor(request);
    return userStateService.clearPlayHistory(actor);
  });

  app.get("/api/history/search", async (request) => {
    const actor = requireActor(request);
    return { items: userStateService.getSearchHistory(actor) };
  });

  app.post("/api/history/search", async (request) => {
    const actor = requireActor(request);
    const { keyword } = SearchHistoryInputSchema.parse(request.body);
    return { items: userStateService.addSearchHistory(actor, keyword) };
  });

  app.delete("/api/history/search", async (request) => {
    const actor = requireActor(request);
    const query = z.object({ keyword: z.string().optional() }).parse(request.query);
    return { items: userStateService.deleteSearchHistory(actor, query.keyword) };
  });
}
