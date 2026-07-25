import express from "express";
import type { RequestHandler } from "express";
import type { AdminConfigUpdate, AdminConfigView } from "../types.js";

export type AdminRouterDependencies = {
  requireAdminAuth: RequestHandler;
  getAdminConfig: () => Promise<AdminConfigView>;
  saveAdminConfig: (input: AdminConfigUpdate) => Promise<AdminConfigView>;
};

export function createAdminRouter(dependencies: AdminRouterDependencies) {
  const router = express.Router();

  router.get("/api/admin/config", dependencies.requireAdminAuth, async (_request, response) => {
    response.json(await dependencies.getAdminConfig());
  });

  router.post("/api/admin/config", dependencies.requireAdminAuth, async (request, response) => {
    response.json(await dependencies.saveAdminConfig(request.body as AdminConfigUpdate));
  });

  return router;
}
