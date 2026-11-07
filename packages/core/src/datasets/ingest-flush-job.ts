import { createHash } from "node:crypto"
import type { JsonValue } from "../json"
import { stableJsonStringify } from "../json"
import type { Queues } from "../queues/types"
import type { DatasetDefinition } from "./types"
import { lakeDatasetDefinition } from "./write"

export type DatasetIngestFlushQueue = Pick<Queues["lake"], "enqueue">

/**
 * The longest a caller waits for the queue. The changes are already stored, so a queue that does
 * not answer costs a webhook this much at most, and the attempt goes on behind it.
 */
const ENQUEUE_BOUND_MS = 1_000

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
        id: `ingest-flush:${flush.datasetId}:${flush.request}`,
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
