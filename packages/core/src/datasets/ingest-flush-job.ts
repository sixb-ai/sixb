import { createHash } from "node:crypto"
import type { JsonValue } from "../json"
import { stableJsonStringify } from "../json"
import type { Queues } from "../queues/types"
import type { DatasetIngestSummary } from "../storage/dataset-ingest"
import { ingestFlushJobId } from "../workers/job-ids"
import type { DatasetDefinition } from "./types"
import { lakeDatasetDefinition } from "./write"

export type DatasetIngestFlushQueue = Pick<Queues["lake"], "enqueue">

/**
 * The longest a caller waits for the queue. The changes are already stored, so a queue that does
 * not answer costs a webhook this much at most, and the attempt goes on behind it.
 */
const ENQUEUE_BOUND_MS = 1_000

/** Deliveries waiting this long with no flush progress, and no flush running or failing, stall. */
const STALLED_AFTER_MS = 10 * 60_000

/**
 * Names what a delivery was validated against. A worker that disagrees may run older code than the
 * API that stored it, so what it refuses says nothing about the delivery.
 */
export function datasetDefinitionHash(dataset: DatasetDefinition): string {
  const { schema, primaryKey, sequenceBy } = lakeDatasetDefinition(dataset)
  const definition = stableJsonStringify({ schema, primaryKey, sequenceBy })

  return createHash("sha256").update(definition).digest("hex")
}

/** A dataset's flush request, as the inbox names it. */
export interface DatasetIngestFlushRef {
  readonly datasetId: string
  readonly request: number
}

/**
 * Queues the flush a request names: the request is the job's id, so whoever asks, its deliveries
 * queue one job.
 */
export async function enqueueIngestFlush(
  queue: DatasetIngestFlushQueue,
  projectId: string,
  flush: DatasetIngestFlushRef,
  metadata: Readonly<Record<string, JsonValue>>
): Promise<void> {
  await queue.enqueue({
    projectId,
    jobs: [
      {
        id: ingestFlushJobId(flush.datasetId, flush.request),
        type: "dataset.ingest.flush.requested",
        payload: { datasetId: flush.datasetId },
        metadata,
      },
    ],
  })
}

/**
 * Queues a flush from code whose changes are already stored: a queue that fails or hangs must not
 * fail or hold it. The request stays open in the inbox, so a later delivery asks again, and so does
 * the orchestrator's `ingest` pass.
 */
export async function tryEnqueueIngestFlush(
  queue: DatasetIngestFlushQueue,
  projectId: string,
  flush: DatasetIngestFlushRef,
  metadata: Readonly<Record<string, JsonValue>>
): Promise<void> {
  const warn = (reason: unknown) => {
    console.warn(
      `[Sixb] Could not queue the flush of dataset '${flush.datasetId}'; its changes are stored, and it is asked for again.`,
      reason
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const answered = enqueueIngestFlush(queue, projectId, flush, metadata).then(
    () => true,
    (error: unknown) => {
      warn(error)
      return true
    }
  )
  const outOfTime = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ENQUEUE_BOUND_MS)
  })

  if (!(await Promise.race([answered, outOfTime]))) {
    warn(`The queue did not answer within ${ENQUEUE_BOUND_MS} ms.`)
  }

  clearTimeout(timer)
}

/**
 * Since when a dataset's deliveries have waited with nothing writing them, or null if they haven't
 * for long. The stall starts at the last progress: the oldest delivery's arrival, or the last batch
 * a flush completed after it. It stays the same while nothing moves.
 */
export function ingestStalledSince(summary: DatasetIngestSummary, now: number): number | null {
  const oldest = summary.oldestReceivedAt

  // A flush holds the dataset, or keeps failing on it and reports that itself.
  if (oldest === null || summary.leaseExpiresAt !== null || summary.failureStreak > 0) return null

  const stalledSince = Math.max(oldest.getTime(), summary.lastFlushedAt?.getTime() ?? 0)

  return now - stalledSince < STALLED_AFTER_MS ? null : stalledSince
}
