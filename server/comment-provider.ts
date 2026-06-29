import { createRequire } from "node:module";
import type { SongComment, SongCommentsPage } from "./types.js";

const require = createRequire(import.meta.url);
const { comment_music } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

type RawCommentUser = {
  userId?: number;
  nickname?: string;
  avatarUrl?: string;
};

type RawComment = {
  commentId?: number;
  user?: RawCommentUser;
  content?: string;
  time?: number;
  timeStr?: string;
  likedCount?: number;
  beReplied?: Array<{
    content?: string;
    user?: RawCommentUser;
  }>;
};

function formatCommentTime(timestamp: number | undefined, fallback: string | undefined) {
  if (fallback?.trim()) {
    return fallback.trim();
  }

  if (!timestamp) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function mapComment(comment: RawComment): SongComment | null {
  const id = comment.commentId ? String(comment.commentId) : "";
  const content = comment.content?.trim() ?? "";

  if (!id || !content) {
    return null;
  }

  const reply = comment.beReplied?.find((item) => item.content?.trim());

  return {
    id,
    userId: comment.user?.userId ? String(comment.user.userId) : "",
    nickname: comment.user?.nickname?.trim() || "网易云用户",
    avatarUrl: comment.user?.avatarUrl,
    content,
    timeText: formatCommentTime(comment.time, comment.timeStr),
    likedCount: Math.max(0, comment.likedCount ?? 0),
    replyContent: reply?.content?.trim()
  };
}

export async function getSongComments(songId: string, page = 1, limit = 20): Promise<SongCommentsPage> {
  const safeSongId = songId.trim();
  if (!safeSongId) {
    throw new Error("缺少歌曲 ID。");
  }

  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));
  const offset = (safePage - 1) * safeLimit;
  const response = await comment_music({
    id: safeSongId,
    limit: safeLimit,
    offset
  });
  const body = response.body as {
    code?: number;
    total?: number;
    more?: boolean;
    hotComments?: RawComment[];
    comments?: RawComment[];
    message?: string;
    msg?: string;
  };

  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `获取评论失败：${body.code}`);
  }

  const comments = (body.comments ?? []).map(mapComment).filter((comment): comment is SongComment => Boolean(comment));
  const hotComments = safePage === 1
    ? (body.hotComments ?? []).map(mapComment).filter((comment): comment is SongComment => Boolean(comment))
    : [];

  return {
    songId: safeSongId,
    total: Math.max(0, body.total ?? comments.length),
    page: safePage,
    limit: safeLimit,
    hasMore: Boolean(body.more),
    hotComments,
    comments
  };
}
