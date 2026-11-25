import type { JobDetailView, JobKind, JobStatus, JobSummaryView } from "#shared";
import type { StoredJobRecord, StoredJobSummaryRecord } from "../../domain/ports/job-repository.js";

export function hasLocalDownloadArtifactExpectation(record: {
  kind: JobKind;
  status: JobStatus;
  artifactFilename?: string;
  directUrl?: string;
  metadata?: Record<string, unknown>;
  artifactExpired?: boolean;
}): boolean {
  const isDirectLink = Boolean(record.directUrl) || record.metadata?.mode === "direct_link";
  const artifactExpired = Boolean(record.artifactExpired || record.metadata?.artifactExpired);
  return (
    record.kind === "download" &&
    record.status === "completed" &&
    Boolean(record.artifactFilename) &&
    !isDirectLink &&
    !artifactExpired
  );
}

export function toJobSummaryView(record: StoredJobSummaryRecord | StoredJobRecord): JobSummaryView {
  const artifactExpired = Boolean(record.artifactExpired || record.metadata?.artifactExpired);
  const isDirectLink = Boolean(record.directUrl) || record.metadata?.mode === "direct_link";
  const hasResult =
    typeof record.hasResult === "boolean"
      ? record.hasResult
      : "result" in record
        ? record.result !== undefined
        : false;

  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    progress: record.progress,
    title: record.title,
    subtitle: record.subtitle,
    metadata: record.metadata,
    hasResult,
    revision: record.revision ?? 0,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    downloadReady:
      record.kind === "download" &&
      record.status === "completed" &&
      Boolean(record.artifactFilename) &&
      !isDirectLink &&
      !artifactExpired,
    artifactExpired: artifactExpired || undefined,
    directUrl: record.directUrl,
    artifactFilename: record.artifactFilename,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toJobView(record: StoredJobRecord): JobDetailView {
  return {
    ...toJobSummaryView(record),
    ...(record.result !== undefined ? { result: record.result } : {}),
  };
}
