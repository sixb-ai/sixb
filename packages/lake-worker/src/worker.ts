import { reportLakeRetentionFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { getLakeRetentionRuntime, type LakeRetention } from "@sixb/core/internal/runtime"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { LakeRetentionReport } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, LakeQueueJob, Queues } from "@sixb/core/queues"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

export interface LakeWorkerHost {
  readonly id: string
  readonly queues: Pick<Queues, "lake">
}

export interface LakeWorkerOptions {
  /** Maximum lake jobs this worker claims and executes at once. Defaults to 1. */
  readonly concurrency?: number
}

/** Consumes the `lake` queue, so lake work never takes a slot from the runs that write the lake. */
export class LakeWorker extends QueueWorker<LakeQueueJob, typeof FAILURE_CODES> {
  private readonly host: LakeWorkerHost
  private readonly retention: LakeRetention

  constructor(host: LakeWorkerHost, options: LakeWorkerOptions = {}) {
    super({
      projectId: host.id,
      queue: host.queues.lake,
      failureCodes: FAILURE_CODES,
      workerId: `lake-worker-${host.id}`,
      claimLimit: options.concurrency,
    })

    this.host = host
    this.retention = getLakeRetentionRuntime(host)
  }

  protected async execute(claimed: ClaimedQueueJob<LakeQueueJob>, signal: AbortSignal) {
    const report = await this.retention.runRequested(claimed.job.payload.intervalStart, signal)

    if (report && changedAnything(report)) {
      console.info(
        `[SixbLakeWorker] Lake retention expired ${report.expiredVersions} version(s) and deleted ` +
          `${report.deletedFiles + report.orphanedFiles} file(s)` +
          (report.hasMore ? "; the next run continues." : ".")
      )
    }
  }

  /** The next interval's request is the retry, so a run that fails is reported once and ends. */
  protected override onExecutionError(
    claimed: ClaimedQueueJob<LakeQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]> {
    const failure = captureSixbFailure(error, {
      allowedCodes: FAILURE_CODES,
      defaultCode: "internal.unexpected",
    })

    reportLakeRetentionFailure(this.host, error, {
      projectId: this.host.id,
      intervalStart: claimed.job.payload.intervalStart,
      failure,
    })

    return { kind: "fail", failure }
  }
}

function changedAnything(report: LakeRetentionReport): boolean {
  return report.expiredVersions + report.deletedFiles + report.orphanedFiles > 0
}
