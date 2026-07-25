import express from "express";
import type {
  UserEventsPage,
  UserFollowActionResult,
  UserProfile,
  UserSocialListKind,
  UserSocialPage
} from "../types.js";

export type UserProfileRouterDependencies = {
  getUserProfile: (userId: string) => Promise<UserProfile>;
  getUserSocialList: (
    userId: string,
    kind: UserSocialListKind,
    page: number,
    limit: number
  ) => Promise<UserSocialPage>;
  getUserEvents: (userId: string, lasttime: number, limit: number) => Promise<UserEventsPage>;
  getUserMutualFollow: (userId: string) => Promise<{ userId: string; mutual: boolean }>;
  setUserFollowed: (userId: string, followed: boolean) => Promise<UserFollowActionResult>;
};

export function createUserProfileRouter(dependencies: UserProfileRouterDependencies) {
  const router = express.Router();

  router.get("/api/users/:id", async (request, response) => {
    try {
      response.json({ user: await dependencies.getUserProfile(request.params.id) });
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取用户信息失败"
      });
    }
  });

  router.get("/api/users/:id/social", async (request, response) => {
    const kind: UserSocialListKind = request.query.kind === "followeds" ? "followeds" : "follows";
    const page = Number(request.query.page);
    const limit = Number(request.query.limit);

    try {
      response.json(await dependencies.getUserSocialList(request.params.id, kind, page, limit));
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取好友列表失败"
      });
    }
  });

  router.get("/api/users/:id/events", async (request, response) => {
    const lasttime = Number(request.query.lasttime);
    const limit = Number(request.query.limit);

    try {
      response.json(await dependencies.getUserEvents(request.params.id, lasttime, limit));
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取用户动态失败"
      });
    }
  });

  router.get("/api/users/:id/mutual-follow", async (request, response) => {
    try {
      response.json(await dependencies.getUserMutualFollow(request.params.id));
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "获取互关状态失败"
      });
    }
  });

  router.post("/api/users/:id/follow", async (request, response) => {
    try {
      response.json(await dependencies.setUserFollowed(request.params.id, Boolean(request.body?.followed)));
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "关注操作失败"
      });
    }
  });

  return router;
}
