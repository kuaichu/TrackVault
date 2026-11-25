import { z } from "zod";

export const UserRoleSchema = z.enum(["admin", "member"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const MusicPlatformSchema = z.enum(["netease", "qq"]);
export type MusicPlatform = z.infer<typeof MusicPlatformSchema>;

export const ProviderModeSchema = z.enum(["netease", "qq", "aggregate"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const UserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  role: UserRoleSchema,
  trustedFallback: z.boolean(),
  createdAt: z.number(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const AuthStatusSchema = z.object({
  initialized: z.boolean(),
  authenticated: z.boolean(),
  user: UserSummarySchema.nullable(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const SetupAdminInputSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "用户名仅支持字母、数字及 _ . -"),
  password: z.string().min(8).max(128),
});
export type SetupAdminInput = z.infer<typeof SetupAdminInputSchema>;

export const LoginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const CreateMemberInputSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, "用户名仅支持字母、数字及 _ . -"),
  password: z.string().min(8).max(128),
  role: UserRoleSchema.default("member"),
  trustedFallback: z.boolean().default(false),
});
export type CreateMemberInput = z.infer<typeof CreateMemberInputSchema>;

export const UpdateMemberInputSchema = z.object({
  role: UserRoleSchema.optional(),
  trustedFallback: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});
export type UpdateMemberInput = z.infer<typeof UpdateMemberInputSchema>;

/**
 * Desensitized platform binding state sent to the frontend.
 * Raw cookies are NEVER included in any response schema.
 */
export const PlatformBindingViewSchema = z.object({
  platform: MusicPlatformSchema,
  connected: z.boolean(),
  accountUid: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  vipEnabled: z.boolean(),
  vipExpireAt: z.number().nullable(),
  verifiedAt: z.number().nullable(),
  message: z.string().optional(),
  credentialCorrupted: z.boolean().optional(),
});
export type PlatformBindingView = z.infer<typeof PlatformBindingViewSchema>;

export const BindCookieInputSchema = z.object({
  cookie: z.string().trim().min(4).max(16_384),
});
export type BindCookieInput = z.infer<typeof BindCookieInputSchema>;

export const SystemFallbackViewSchema = z.object({
  platform: MusicPlatformSchema,
  configured: z.boolean(),
  enabled: z.boolean(),
  updatedAt: z.number().nullable(),
});
export type SystemFallbackView = z.infer<typeof SystemFallbackViewSchema>;

export const UpdateSystemFallbackInputSchema = z.object({
  cookie: z.string().trim().max(16_384).optional(),
  enabled: z.boolean(),
  clearCookie: z.boolean().optional(),
});
export type UpdateSystemFallbackInput = z.infer<typeof UpdateSystemFallbackInputSchema>;

export const QrStartResultSchema = z.object({
  key: z.string(),
  qrImage: z.string(),
  qrUrl: z.string().optional(),
});
export type QrStartResult = z.infer<typeof QrStartResultSchema>;

export const QrCheckResultSchema = z.object({
  status: z.enum(["waiting", "scanned", "confirmed", "expired", "error"]),
  code: z.number(),
  message: z.string(),
  binding: PlatformBindingViewSchema.optional(),
});
export type QrCheckResult = z.infer<typeof QrCheckResultSchema>;
