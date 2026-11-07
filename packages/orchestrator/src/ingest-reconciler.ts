import { reportDatasetIngestFlushFailure } from "@sixb/core/internal/error-reporting"
import { captureSixbFailure } from "@sixb/core/internal/errors"
import { enqueueIngestFlush } from "@sixb/core/internal/runtime"
import type { DatasetIngestSummary } from "@sixb/core/storage"
import type { IngestReconciliationPorts } from "./types"

const INTERVAL_MS = 30_000

/** Deliveries waiting this long with no flush progress, and no flush running or failing, stall. */
const STALLED_AFTER_MS = 10 * 60_000

interface IngestReconcilerInput extends IngestReconciliationPorts {
  readonly projectId: string
}

/**
 * The only part of ingestion that runs in the orchestrator, and a safety net: `ingest` queues its
 * own flush, so changes reach the lake with or without this pass.
 *
 * It recovers a flush that was never queued: a queue that refused the job, or a process that
 * stopped between storing a delivery and queueing it. Each pass queues a flush for every dataset
 * whose deliveries wait with no flush holding it, under the request the inbox holds, so a request
 * that already has a job queues nothing more.
 *
 * A dataset whose deliveries waited for long with no flush holding it, failing on it or completing
 * a batch of it is reported once per stall: changes are stored and nothing writes them, such as in
 * a deployment that runs no lake worker.
 */
export class IngestReconciler {
  readonly intervalMs: number

  /**
   * The stall each dataset was last reported for. Memory is enough: it spares `onError` a call per
   * pass, and a restart that repeats a report keeps its `notificationId`, which comes from the
   * stall's durable start.
   */
  private readonly reported = new Map<string, number>()

  constructor(private readonly input: IngestReconcilerInput) {
    this.intervalMs = input.intervalMs ?? INTERVAL_MS
  }

  async pass(signal: AbortSignal): Promise<void> {
    const { inbox, queue, projectId } = this.input
    const summaries = await inbox.summarize({ projectId })
    const waiting = summaries.filter((summary) => summary.pendingDeliveries > 0)
    const now = Date.now()

    // Before queueing: a queue that is down must not silence the report.
    for (const summary of waiting) this.reportStalled(summary, now)

    for (const summary of waiting) {
      signal.throwIfAborted()

      if (summary.leaseExpiresAt === null) {
        await enqueueIngestFlush(queue, projectId, summary, { source: "ingest-pass" })
      }
    }
  }

  private reportStalled(summary: DatasetIngestSummary, now: number): void {
    const oldest = summary.oldestReceivedAt
    // A flush holds the dataset, or keeps failing on it and reports that itself.
    if (oldest === null || summary.leaseExpiresAt !== null || summary.failureStreak > 0) return

    // The stall starts at the last progress: the oldest delivery's arrival, or the last batch a
    // flush completed after it. It stays the same while nothing moves, so one stall is one report.
    const stalledSince = Math.max(oldest.getTime(), summary.lastFlushedAt?.getTime() ?? 0)
    if (now - stalledSince < STALLED_AFTER_MS) return
    if (this.reported.get(summary.datasetId) === stalledSince) return

    this.reported.set(summary.datasetId, stalledSince)

    const minutes = Math.floor((now - stalledSince) / 60_000)
    const error = new Error(
      `[SixbOrchestrator] Dataset '${summary.datasetId}' has ${summary.pendingDeliveries} ingested delivery(ies), and none was written for ${minutes} min. Run a lake worker for this project: \`sixb worker lake\`.`
    )

    reportDatasetIngestFlushFailure(this.input.reporter, error, {
      projectId: this.input.projectId,
      datasetId: summary.datasetId,
      failure: captureSixbFailure(error, {
        allowedCodes: ["internal.unexpected", "runtime.cancelled"],
        defaultCode: "internal.unexpected",
      }),
      failureStreak: 0,
      pendingDeliveries: summary.pendingDeliveries,
      oldestReceivedAt: oldest.toISOString(),
      subject: `stalled:${new Date(stalledSince).toISOString()}`,
    })
  }
}
