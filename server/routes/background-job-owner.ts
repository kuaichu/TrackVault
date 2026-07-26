import type { Response } from "express";
import { InvalidClientSessionIdError } from "../request-context.js";

export async function resolveBackgroundJobOwner(
  getOwnerKey: () => Promise<string>,
  response: Response
): Promise<string | null> {
  try {
    const ownerKey = await getOwnerKey();
    if (!ownerKey.trim()) {
      throw new Error("empty background job owner");
    }
    return ownerKey;
  } catch (error) {
    response.status(400).json({
      message: error instanceof InvalidClientSessionIdError
        ? error.message
        : "无法确认后台任务所属身份。"
    });
    return null;
  }
}
