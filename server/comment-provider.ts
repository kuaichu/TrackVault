import { createRequire } from "node:module";
import { getSettings } from "./settings-store.js";
import type { SongComment, SongCommentRepliesPage, SongCommentsPage } from "./types.js";

const require = createRequire(import.meta.url);
const { comment, comment_floor, comment_like, comment_music } = require("NeteaseCloudMusicApi") as typeof import("NeteaseCloudMusicApi");

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
  liked?: boolean;
  likedCount?: number;
  replyCount?: number;
  showFloorComment?: {
    replyCount?: number;
    comments?: RawComment[];
  };
  beReplied?: Array<{
    content?: string;
    user?: RawCommentUser;
  }>;
};

type NeteaseResponseBody = {
  code?: number;
  message?: string;
  msg?: string;
};

function formatCommentTime(timestamp: number | undefined, fallback: string | undefined) {
  if (!timestamp) {
    return fallback?.trim() ?? "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
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
    time: typeof comment.time === "number" ? comment.time : undefined,
    liked: Boolean(comment.liked),
    likedCount: Math.max(0, comment.likedCount ?? 0),
    replyCount: Math.max(0, comment.showFloorComment?.replyCount ?? comment.replyCount ?? comment.showFloorComment?.comments?.length ?? comment.beReplied?.length ?? 0),
    replyContent: reply?.content?.trim()
  };
}

async function getCookie() {
  const settings = await getSettings();
  const cookie = settings.neteaseCookie.trim();
  if (!cookie) {
    throw new Error("当前操作需要有效的网易云 Cookie，请先登录或重新导入 MUSIC_U Cookie。");
  }

  return cookie;
}

function assertNeteaseOk(body: NeteaseResponseBody, fallbackMessage: string) {
  if (typeof body.code === "number" && body.code !== 200) {
    throw new Error(body.message ?? body.msg ?? `${fallbackMessage}：${body.code}`);
  }
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

  assertNeteaseOk(body, "获取评论失败");

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

export async function setSongCommentLiked(songId: string, commentId: string, liked: boolean) {
  const safeSongId = songId.trim();
  const safeCommentId = commentId.trim();
  if (!safeSongId || !safeCommentId) {
    throw new Error("缺少歌曲或评论 ID。");
  }

  const response = await comment_like({
    id: safeSongId,
    type: 0,
    cid: safeCommentId,
    t: liked ? 1 : 0,
    cookie: await getCookie()
  });
  assertNeteaseOk(response.body as NeteaseResponseBody, liked ? "点赞评论失败" : "取消点赞失败");

  return { liked };
}

export async function replyToSongComment(songId: string, commentId: string, content: string) {
  const safeSongId = songId.trim();
  const safeCommentId = commentId.trim();
  const safeContent = content.trim();
  if (!safeSongId || !safeCommentId) {
    throw new Error("缺少歌曲或评论 ID。");
  }
  if (!safeContent) {
    throw new Error("回复内容不能为空。");
  }

  const response = await comment({
    id: safeSongId,
    type: 0,
    t: 2,
    commentId: safeCommentId,
    content: safeContent,
    cookie: await getCookie()
  });
  const body = response.body as NeteaseResponseBody & {
    comment?: RawComment;
    data?: {
      comment?: RawComment;
    };
  };
  assertNeteaseOk(body, "回复评论失败");

  return {
    comment: mapComment(body.comment ?? body.data?.comment ?? {
      commentId: Date.now(),
      content: safeContent,
      time: Date.now(),
      likedCount: 0
    })
  };
}

export async function getSongCommentReplies(songId: string, parentCommentId: string, time = -1, limit = 20): Promise<SongCommentRepliesPage> {
  const safeSongId = songId.trim();
  const safeParentCommentId = parentCommentId.trim();
  if (!safeSongId || !safeParentCommentId) {
    throw new Error("缺少歌曲或评论 ID。");
  }

  const safeLimit = Math.min(50, Math.max(5, Math.floor(limit) || 20));
  const safeTime = Number.isFinite(time) ? Math.floor(time) : -1;
  const response = await comment_floor({
    id: safeSongId,
    type: 0,
    parentCommentId: safeParentCommentId,
    time: safeTime,
    limit: safeLimit
  });
  const body = response.body as NeteaseResponseBody & {
    data?: {
      comments?: RawComment[];
      hasMore?: boolean;
      time?: number;
      totalCount?: number;
      total?: number;
    };
    comments?: RawComment[];
    hasMore?: boolean;
    time?: number;
    totalCount?: number;
    total?: number;
  };
  assertNeteaseOk(body, "获取回复失败");

  const data = body.data ?? body;
  const replies = (data.comments ?? []).map(mapComment).filter((item): item is SongComment => Boolean(item));

  return {
    songId: safeSongId,
    parentCommentId: safeParentCommentId,
    replies,
    total: Math.max(0, data.totalCount ?? data.total ?? replies.length),
    hasMore: Boolean(data.hasMore),
    nextTime: typeof data.time === "number" ? data.time : replies[replies.length - 1]?.time
  };
}
