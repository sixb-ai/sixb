import { reportLakeRetentionFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { getLakeRetentionRuntime, type LakeRetentionRuntime } from "@sixb/core/internal/runtime"
import { QueueWorker, type QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import type { LakeRetentionReport } from "@sixb/core/lake-storage"
import type { ClaimedQueueJob, LakeQueueJob, Queues } from "@sixb/core/queues"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

/** Two at a time, so lake work behind a long retention pass does not wait for it. */
const LAKE_CONCURRENCY = 2

/** A failed run is tried this many times in all, a minute apart, before it is reported. */
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 60_000

export interface LakeWorkerHost {
  readonly id: string
  readonly queues: Pick<Queues, "lake">
}

/** Separate lane: lake work never takes a sync slot, and a sync never delays it. */
export class LakeWorker extends QueueWorker<LakeQueueJob, typeof FAILURE_CODES> {
  private readonly host: LakeWorkerHost
  private readonly retention: LakeRetentionRuntime

  constructor(host: LakeWorkerHost) {
    super({
      projectId: host.id,
      queue: host.queues.lake,
      failureCodes: FAILURE_CODES,
      workerId: `lake-worker-${host.id}`,
      claimLimit: LAKE_CONCURRENCY,
    })

    this.host = host
    this.retention = getLakeRetentionRuntime(host)
  }

  protected async execute(claimed: ClaimedQueueJob<LakeQueueJob>, signal: AbortSignal) {
    const { occurrenceAt } = claimed.job.payload
    const report = await this.retention.runOccurrence(occurrenceAt, signal)

    if (report && changedAnything(report)) {
      console.info(
        `[SixbSyncWorker] Lake retention expired ${report.expiredVersions} version(s) and deleted ` +
          `${report.deletedFiles + report.orphanedFiles} file(s)` +
          (report.hasMore ? "; the next run continues." : ".")
      )
    }
  }

  protected override onExecutionError(
    claimed: ClaimedQueueJob<LakeQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]> {
    const { job } = claimed

    if (job.attempt < MAX_ATTEMPTS) {
      console.warn(
        `[SixbSyncWorker] Lake retention failed (attempt ${job.attempt} of ${MAX_ATTEMPTS}); retrying in a minute.`,
        error
      )
      return { kind: "retry", availableAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString() }
    }

    const failure = captureSixbFailure(error, {
      allowedCodes: FAILURE_CODES,
      defaultCode: "internal.unexpected",
    })
    reportLakeRetentionFailure(this.host, error, {
      projectId: this.host.id,
      occurrenceAt: job.payload.occurrenceAt,
      attempt: job.attempt,
      failure,
    })

    return { kind: "fail", failure }
  }
}

function changedAnything(report: LakeRetentionReport): boolean {
  return report.expiredVersions + report.deletedFiles + report.orphanedFiles > 0
}
