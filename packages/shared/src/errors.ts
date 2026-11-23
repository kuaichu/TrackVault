import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "SETUP_REQUIRED",
  "CREDENTIAL_REQUIRED",
  "CREDENTIAL_INVALID",
  "VIP_REQUIRED",
  "COPYRIGHT_UNAVAILABLE",
  "TRIAL_ONLY",
  "QUALITY_DOWNGRADED",
  "FEATURE_UNSUPPORTED",
  "UNSAFE_URL",
  "PAYLOAD_TOO_LARGE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_ERROR",
  "JOB_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
