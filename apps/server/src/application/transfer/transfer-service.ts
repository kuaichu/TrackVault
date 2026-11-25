import type {
  CompareResult,
  CompareStatus,
  ExportFormat,
  ExportPayload,
  ImportAuditResult,
  JobDetailView,
  JobView,
  StartCompareInput,
  StartImportAuditInput,
  StartTransferInput,
  TransferResult,
  UpdateTransferSelectionInput,
} from "#shared";
import type { ActorContext } from "../../domain/context.js";
import { AppError } from "../../domain/errors.js";
import type { CreatePlaylistResult, ProviderRegistry } from "../../domain/ports/music-provider.js";
import {
  formatCompareExport,
  formatImportAuditExport,
  formatTransferExport,
} from "../../domain/transfer/text-and-csv.js";
import type { ProviderAuthResolver } from "../auth/provider-auth-resolver.js";
import type { BackgroundJobManager } from "../jobs/background-job-manager.js";
import { startImportAuditJobUseCase } from "./audit-playlist-use-case.js";
import { startCompareJobUseCase } from "./compare-playlists-use-case.js";
import { importTransferResultToPlatformUseCase } from "./import-playlist-result-use-case.js";
import {
  startTransferJobUseCase,
  updateTransferTrackSelectionUseCase,
} from "./transfer-playlist-use-case.js";

/**
 * Slim TransferService facade coordinating the 5 transfer use-case modules.
 */
export class TransferService {
  readonly #providers: ProviderRegistry;
  readonly #authResolver: ProviderAuthResolver;
  readonly #jobs: BackgroundJobManager;

  constructor(deps: {
    providers: ProviderRegistry;
    authResolver: ProviderAuthResolver;
    jobs: BackgroundJobManager;
  }) {
    this.#providers = deps.providers;
    this.#authResolver = deps.authResolver;
    this.#jobs = deps.jobs;
  }

  startTransferJob(actor: ActorContext, input: StartTransferInput): JobView {
    return startTransferJobUseCase({
      providers: this.#providers,
      authResolver: this.#authResolver,
      jobs: this.#jobs,
      actor,
      input,
    });
  }

  updateTransferTrackSelection(
    actor: ActorContext,
    jobId: string,
    input: UpdateTransferSelectionInput,
  ): JobDetailView {
    return updateTransferTrackSelectionUseCase({
      jobs: this.#jobs,
      actor,
      jobId,
      input,
    });
  }

  startImportAuditJob(actor: ActorContext, input: StartImportAuditInput): JobView {
    return startImportAuditJobUseCase({
      providers: this.#providers,
      authResolver: this.#authResolver,
      jobs: this.#jobs,
      actor,
      input,
    });
  }

  startCompareJob(actor: ActorContext, input: StartCompareInput): JobView {
    return startCompareJobUseCase({
      providers: this.#providers,
      authResolver: this.#authResolver,
      jobs: this.#jobs,
      actor,
      input,
    });
  }

  exportJob(
    actor: ActorContext,
    jobId: string,
    format: ExportFormat,
    statuses?: readonly CompareStatus[],
  ): ExportPayload {
    const record = this.#jobs.getOwnedJob(actor, jobId);
    if (record.status !== "completed" || !record.result) {
      throw new AppError("VALIDATION_ERROR", "任务尚未完成，无法导出。");
    }

    if (record.kind === "transfer") {
      return formatTransferExport(record.result as TransferResult, format);
    }
    if (record.kind === "compare") {
      return formatCompareExport(record.result as CompareResult, format, statuses);
    }
    if (record.kind === "import_audit") {
      return formatImportAuditExport(record.result as ImportAuditResult, format);
    }

    throw new AppError("VALIDATION_ERROR", "该任务类型不支持文本导出。");
  }

  importTransferResultToPlatform(
    actor: ActorContext,
    jobId: string,
    options: { name?: string; existingPlaylistId?: string },
  ): Promise<CreatePlaylistResult & { skippedCount: number }> {
    return importTransferResultToPlatformUseCase({
      providers: this.#providers,
      authResolver: this.#authResolver,
      jobs: this.#jobs,
      actor,
      jobId,
      options,
    });
  }
}
