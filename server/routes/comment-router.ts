import express from "express";
import type {
  getSongCommentReplies,
  getSongComments,
  replyToSongComment,
  setSongCommentLiked
} from "../comment-provider.js";
import type {
  getQqSongCommentReplies,
  getQqSongComments,
  setQqSongCommentLiked
} from "../qqmusic-provider.js";

export type CommentRouterDependencies = {
  getSongComments: typeof getSongComments;
  getQqSongComments: typeof getQqSongComments;
  getSongCommentReplies: typeof getSongCommentReplies;
  getQqSongCommentReplies: typeof getQqSongCommentReplies;
  setSongCommentLiked: typeof setSongCommentLiked;
  setQqSongCommentLiked: typeof setQqSongCommentLiked;
  replyToSongComment: typeof replyToSongComment;
};

export function getErrorMessage(error: unknown, fallbackMessage: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const record = error as {
      message?: unknown;
      msg?: unknown;
      body?: { message?: unknown; msg?: unknown; code?: unknown };
      status?: unknown;
    };
    const bodyMessage = typeof record.body?.message === "string" ? record.body.message.trim() : "";
    const bodyMsg = typeof record.body?.msg === "string" ? record.body.msg.trim() : "";
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const msg = typeof record.msg === "string" ? record.msg.trim() : "";

    if (bodyMessage || bodyMsg || message || msg) {
      return bodyMessage || bodyMsg || message || msg;
    }

    const code = record.body?.code ?? record.status;
    if (typeof code === "number" || typeof code === "string") {
      return `${fallbackMessage}：${code}`;
    }
  }

  return fallbackMessage;
}

export function createCommentRouter(dependencies: CommentRouterDependencies) {
  const router = express.Router();

  router.get("/api/comments/songs/:id", async (request, response) => {
    const source = typeof request.query.source === "string" ? request.query.source : "";
    const providerSongId = typeof request.query.providerSongId === "string" ? request.query.providerSongId : request.params.id;

    try {
      const page = Number(request.query.page);
      const limit = Number(request.query.limit);
      const comments = source === "qqmusic"
        ? await dependencies.getQqSongComments(providerSongId, page, limit)
        : await dependencies.getSongComments(request.params.id, page, limit);
      response.json(source === "qqmusic" ? { ...comments, songId: request.params.id } : comments);
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取评论失败"
      });
    }
  });

  router.get("/api/comments/songs/:id/:commentId/replies", async (request, response) => {
    const source = typeof request.query.source === "string" ? request.query.source : "";
    const providerSongId = typeof request.query.providerSongId === "string" ? request.query.providerSongId : request.params.id;

    try {
      const time = Number(request.query.time);
      const limit = Number(request.query.limit);
      response.json(
        source === "qqmusic"
          ? await dependencies.getQqSongCommentReplies(providerSongId, request.params.commentId)
          : await dependencies.getSongCommentReplies(request.params.id, request.params.commentId, time, limit)
      );
    } catch (error) {
      response.status(502).json({
        message: error instanceof Error ? error.message : "获取评论回复失败"
      });
    }
  });

  router.post("/api/comments/songs/:id/:commentId/like", async (request, response) => {
    const liked = Boolean(request.body?.liked);
    const source = typeof request.query.source === "string" ? request.query.source : "";

    try {
      response.json(
        source === "qqmusic"
          ? await dependencies.setQqSongCommentLiked(request.params.commentId, liked)
          : await dependencies.setSongCommentLiked(request.params.id, request.params.commentId, liked)
      );
    } catch (error) {
      response.status(401).json({
        message: getErrorMessage(error, liked ? "点赞评论失败" : "取消点赞失败")
      });
    }
  });

  router.post("/api/comments/songs/:id/:commentId/replies", async (request, response) => {
    const content = typeof request.body?.content === "string" ? request.body.content : "";
    const source = typeof request.query.source === "string" ? request.query.source : "";

    try {
      if (source === "qqmusic") {
        response.status(501).json({ message: "QQ 音乐评论回复暂未接入。" });
        return;
      }

      response.json(await dependencies.replyToSongComment(request.params.id, request.params.commentId, content));
    } catch (error) {
      response.status(401).json({
        message: error instanceof Error ? error.message : "回复评论失败"
      });
    }
  });

  return router;
}
