import type { ErrorCode } from "#shared";

const DEFAULT_STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SETUP_REQUIRED: 412,
  CREDENTIAL_REQUIRED: 403,
  CREDENTIAL_INVALID: 401,
  VIP_REQUIRED: 403,
  COPYRIGHT_UNAVAILABLE: 451,
  TRIAL_ONLY: 403,
  QUALITY_DOWNGRADED: 422,
  FEATURE_UNSUPPORTED: 501,
  UNSAFE_URL: 400,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  JOB_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { statusCode?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "AppError";
    this.code = code;
    this.statusCode = options?.statusCode ?? DEFAULT_STATUS_BY_CODE[code];
    this.details = options?.details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
