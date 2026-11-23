import { z } from "zod";
import { ErrorCodeSchema } from "../errors.js";
import { QualityLevelSchema } from "../quality.js";
import { SongSchema } from "./music.js";

export const JobKindSchema = z.enum(["download", "transfer", "import_audit", "compare"]);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const DownloadModeSchema = z.enum(["tagged_server", "direct_link"]);
export type DownloadMode = z.infer<typeof DownloadModeSchema>;

export const CreateDownloadJobInputSchema = z.object({
  song: SongSchema,
  level: QualityLevelSchema,
  mode: DownloadModeSchema.default("tagged_server"),
});
export type CreateDownloadJobInput = z.infer<typeof CreateDownloadJobInputSchema>;

export const JobViewSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  title: z.string(),
  subtitle: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  result: z.unknown().optional(),
  errorCode: ErrorCodeSchema.optional(),
  errorMessage: z.string().optional(),
  downloadReady: z.boolean().optional(),
  directUrl: z.string().optional(),
  artifactFilename: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const JobEventSchema = z.object({
  type: z.enum(["job_updated", "job_removed", "heartbeat"]),
  job: JobViewSchema.optional(),
  jobId: z.string().optional(),
  timestamp: z.number(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;
