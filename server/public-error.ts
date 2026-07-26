import type { ErrorRequestHandler } from "express";

export const PUBLIC_ERROR_MESSAGES = {
  internalServer: "服务器处理请求失败，请稍后重试。",
  playlistTransferCreate: "创建歌单互转任务失败",
  playlistTransferRun: "歌单互转失败",
  neteaseImport: "导入网易云歌单失败",
  qqImport: "导入 QQ 音乐歌单失败",
  playlistCompare: "歌单对比失败",
  neteaseImportAudit: "网易云导入歌单清理失败",
  playableNeteaseImport: "创建正常歌曲新歌单失败"
} as const;

export type PublicErrorMessage = typeof PUBLIC_ERROR_MESSAGES[keyof typeof PUBLIC_ERROR_MESSAGES];

export function publicErrorResponse(message: PublicErrorMessage) {
  return { message };
}

export function toExpressError(error: unknown, internalMessage: string): Error {
  return error instanceof Error ? error : new Error(internalMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInvalidJsonBodyError(error: unknown): boolean {
  return isRecord(error)
    && error.status === 400
    && error.type === "entity.parse.failed";
}

function isRequestBodyTooLargeError(error: unknown): boolean {
  return isRecord(error)
    && error.status === 413
    && error.type === "entity.too.large";
}

export const safeHttpErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(toExpressError(error, "HTTP request failed after response headers were sent"));
    return;
  }

  if (isInvalidJsonBodyError(error)) {
    response.status(400).json({
      code: "INVALID_JSON_BODY",
      message: "请求 JSON 格式无效。"
    });
    return;
  }

  if (isRequestBodyTooLargeError(error)) {
    response.status(413).json({
      code: "REQUEST_BODY_TOO_LARGE",
      message: "请求体超过允许大小。"
    });
    return;
  }

  response.status(500).json(publicErrorResponse(PUBLIC_ERROR_MESSAGES.internalServer));
};
