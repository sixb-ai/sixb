import type { JsonValue } from "../json"
import type { Queues } from "../queues/types"

export type DatasetIngestFlushQueue = Pick<Queues["lake"], "enqueue">

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
 * Queues a flush from code whose changes are already stored: a queue that fails must not fail it.
 * The request stays in the inbox, and the orchestrator's `ingest` pass queues the job.
 */
export async function tryEnqueueIngestFlush(
  queue: DatasetIngestFlushQueue,
  projectId: string,
  flush: DatasetIngestFlushRef,
  metadata: Readonly<Record<string, JsonValue>>
): Promise<void> {
  try {
    await enqueueIngestFlush(queue, projectId, flush, metadata)
  } catch (error) {
    console.warn(
      `[Sixb] Could not queue the flush of dataset '${flush.datasetId}'; its changes are stored, and the next ingest pass queues it.`,
      error
    )
  }
}
