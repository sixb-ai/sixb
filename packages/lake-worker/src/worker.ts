import { reportLakeRetentionFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import {
  DatasetIngestFlushError,
  type DatasetIngestRuntime,
  getDatasetIngestRuntime,
  getLakeRetentionRuntime,
  type LakeRetention,
} from "@sixb/core/internal/runtime"
import {
  type BackoffPolicy,
  backoffDelay,
  QueueWorker,
  type QueueWorkerFailureDecision,
} from "@sixb/core/internal/workers"
import type { LakeRetentionReport } from "@sixb/core/lake-storage"
import type {
  ClaimedQueueJob,
  DatasetIngestFlushRequestedQueueJob,
  LakeQueueJob,
  LakeRetentionRequestedQueueJob,
  Queues,
} from "@sixb/core/queues"

const FAILURE_CODES = ["internal.unexpected", "runtime.cancelled"] as const

/** Four at a time, so the flushes of several datasets run together and beside a long retention run. */
const DEFAULT_CONCURRENCY = 4

/**
 * A failed flush is tried again sooner at first, then every minute, for as long as it fails: its
 * changes stay in the inbox until one succeeds. The flush reports a dataset that keeps failing.
 */
const FLUSH_RETRY: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000 }

/**
 * A flush that finds the dataset held tries again this soon, not when the holder's lease would
 * expire: the holder releases it as soon as it is done, often long before.
 */
const BUSY_RETRY_MS = 1_000

export interface LakeWorkerHost {
  readonly id: string
  readonly queues: Pick<Queues, "lake">
}

export interface LakeWorkerOptions {
  /** Maximum lake jobs this worker claims and executes at once. Defaults to 4. */
  readonly concurrency?: number
}

/** Another flush holds the dataset, at most until `until`, when its lease would expire. */
class DatasetIngestFlushBusy extends Error {
  constructor(readonly until: Date) {
    super("[SixbLakeWorker] Another flush holds the dataset.")
  }
}

/** Consumes the `lake` queue, so lake work never takes a slot from the runs that write the lake. */
export class LakeWorker extends QueueWorker<LakeQueueJob, typeof FAILURE_CODES> {
  private readonly host: LakeWorkerHost
  private readonly retention: LakeRetention
  private readonly ingest: DatasetIngestRuntime
  private retentionRunning = false

  constructor(host: LakeWorkerHost, options: LakeWorkerOptions = {}) {
    super({
      projectId: host.id,
      queue: host.queues.lake,
      failureCodes: FAILURE_CODES,
      workerId: `lake-worker-${host.id}`,
      claimLimit: options.concurrency ?? DEFAULT_CONCURRENCY,
    })

    this.host = host
    this.retention = getLakeRetentionRuntime(host)
    this.ingest = getDatasetIngestRuntime(host)
  }

  protected async execute(claimed: ClaimedQueueJob<LakeQueueJob>, signal: AbortSignal) {
    const { job } = claimed

    switch (job.type) {
      case "lake.retention.requested":
        await this.runRetention(job, signal)
        return
      case "dataset.ingest.flush.requested":
        await this.flush(job, signal)
        return
    }
  }

  /**
   * Runs one interval's request, unless a run is going: the slots are for flushes, and the next
   * interval's request takes what that run leaves.
   */
  private async runRetention(job: LakeRetentionRequestedQueueJob, signal: AbortSignal) {
    if (this.retentionRunning) return

    this.retentionRunning = true
    try {
      const report = await this.retention.runRequested(job.payload.intervalStart, signal)

      if (report && changedAnything(report)) {
        console.info(
          `[SixbLakeWorker] Lake retention expired ${report.expiredVersions} version(s) and deleted ` +
            `${report.deletedFiles + report.orphanedFiles} file(s)` +
            (report.hasMore ? "; the next run continues." : ".")
        )
      }
    } finally {
      this.retentionRunning = false
    }
  }

  private async flush(job: DatasetIngestFlushRequestedQueueJob, signal: AbortSignal) {
    const outcome = await this.ingest.flush(job.payload.datasetId, signal)
    if (outcome.kind === "busy") throw new DatasetIngestFlushBusy(outcome.until)
  }

  protected override onExecutionError(
    claimed: ClaimedQueueJob<LakeQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]> {
    const { job } = claimed

    switch (job.type) {
      case "lake.retention.requested":
        return this.failRetention(job, error)
      case "dataset.ingest.flush.requested":
        return this.retryFlush(job, error)
    }
  }

  /** The next interval's request is the retry, so a run that fails is reported once and ends. */
  private failRetention(
    job: LakeRetentionRequestedQueueJob,
    error: unknown
  ): QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]> {
    const failure = captureSixbFailure(error, {
      allowedCodes: FAILURE_CODES,
      defaultCode: "internal.unexpected",
    })

    reportLakeRetentionFailure(this.host, error, {
      projectId: this.host.id,
      intervalStart: job.payload.intervalStart,
      failure,
    })

    return { kind: "fail", failure }
  }

  /** A flush job is never failed: the next attempt resumes the batch where this one stopped. */
  private retryFlush(
    job: DatasetIngestFlushRequestedQueueJob,
    error: unknown
  ): QueueWorkerFailureDecision<(typeof FAILURE_CODES)[number]> {
    if (error instanceof DatasetIngestFlushBusy) {
      const soon = Math.min(error.until.getTime(), Date.now() + BUSY_RETRY_MS)
      return { kind: "retry", availableAt: new Date(soon).toISOString() }
    }

    const failures = error instanceof DatasetIngestFlushError ? error.failureStreak : job.attempt
    const delayMs = backoffDelay(Math.max(failures - 1, 0), FLUSH_RETRY)

    console.warn(
      `[SixbLakeWorker] Flushing the ingested changes of dataset '${job.payload.datasetId}' failed; retrying in ${delayMs / 1_000} s.`,
      error
    )
    return { kind: "retry", availableAt: new Date(Date.now() + delayMs).toISOString() }
  }
}

function changedAnything(report: LakeRetentionReport): boolean {
  return report.expiredVersions + report.deletedFiles + report.orphanedFiles > 0
}
