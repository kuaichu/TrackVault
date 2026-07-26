import type {
  TransferImportRequest,
  TransferSourceProvider,
  TransferTargetProvider,
  TransferTrack
} from "./types.js";

export const TRANSFER_IMPORT_REQUEST_VALIDATION_MESSAGE = "歌单互转任务输入格式无效。";

export class TransferImportRequestValidationError extends Error {
  constructor() {
    super(TRANSFER_IMPORT_REQUEST_VALIDATION_MESSAGE);
    this.name = "TransferImportRequestValidationError";
  }
}

function invalidTransferImportRequest(): never {
  throw new TransferImportRequestValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSourceProvider(value: unknown): TransferSourceProvider {
  if (value === "netease" || value === "qq" || value === "text" || value === "csv") {
    return value;
  }
  return invalidTransferImportRequest();
}

function parseTargetProvider(value: unknown): TransferTargetProvider {
  if (value === "netease" || value === "qq" || value === "text") {
    return value;
  }
  return invalidTransferImportRequest();
}

function parseOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return invalidTransferImportRequest();
  }
  return value;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return invalidTransferImportRequest();
  }
  return [...value];
}

function parseTransferTrack(value: unknown): TransferTrack {
  if (!isRecord(value)) {
    return invalidTransferImportRequest();
  }

  const source = parseSourceProvider(value.source);
  const title = value.title;
  if (typeof title !== "string") {
    return invalidTransferImportRequest();
  }
  const artists = parseStringArray(value.artists);
  const sourceTrackId = parseOptionalString(value, "sourceTrackId");
  const album = parseOptionalString(value, "album");
  const rawText = parseOptionalString(value, "rawText");
  const durationSeconds = value.durationSeconds;
  if (durationSeconds !== undefined && typeof durationSeconds !== "number") {
    return invalidTransferImportRequest();
  }

  return {
    source,
    ...(sourceTrackId === undefined ? {} : { sourceTrackId }),
    title,
    artists,
    ...(album === undefined ? {} : { album }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(rawText === undefined ? {} : { rawText })
  };
}

export function parseTransferImportRequest(value: unknown): TransferImportRequest {
  if (!isRecord(value)) {
    return invalidTransferImportRequest();
  }

  const sourceProvider = parseSourceProvider(value.sourceProvider);
  const targetProvider = parseTargetProvider(value.targetProvider);
  const playlistName = parseOptionalString(value, "playlistName");
  const playlistId = parseOptionalString(value, "playlistId");
  const text = parseOptionalString(value, "text");
  const sourceTrackIds = value.sourceTrackIds === undefined
    ? undefined
    : parseStringArray(value.sourceTrackIds);
  const sourceTracks = value.sourceTracks;
  if (sourceTracks !== undefined && !Array.isArray(sourceTracks)) {
    return invalidTransferImportRequest();
  }
  const checkAvailability = value.checkAvailability;
  if (checkAvailability !== undefined && typeof checkAvailability !== "boolean") {
    return invalidTransferImportRequest();
  }

  return {
    sourceProvider,
    targetProvider,
    ...(playlistName === undefined ? {} : { playlistName }),
    ...(playlistId === undefined ? {} : { playlistId }),
    ...(sourceTrackIds === undefined ? {} : { sourceTrackIds }),
    ...(sourceTracks === undefined ? {} : { sourceTracks: sourceTracks.map(parseTransferTrack) }),
    ...(text === undefined ? {} : { text }),
    ...(checkAvailability === undefined ? {} : { checkAvailability })
  };
}
