import { randomUUID } from "node:crypto"
import type { ClaimedQueueJob, NewQueueJob, QueueJob } from "@sixb/core"
import type { Job as BullJob } from "bullmq"
import { parseTimestamp } from "./validation"

/**
 * Stored in `job.data` — the serialized Sixb queue-job envelope.
 *
 * `attempt` is deliberately excluded: BullMQ tracks it at runtime via `attemptsStarted`
 * on the job handle, and reading a stale snapshot from `data.attempt` would lie to the
 * worker about redelivery counts. Making the field absent at the type level enforces that.
 */
export type QueueJobData<TQueueJob extends QueueJob> = Omit<TQueueJob, "attempt">

export function buildEnvelope<TQueueJob extends QueueJob>(
  projectId: string,
  newJob: NewQueueJob<TQueueJob>
) {
  const createdAt = new Date().toISOString()
  const availableAt = newJob.availableAt ?? createdAt
  const availableAtMs = parseTimestamp(availableAt, "availableAt")
  const id = newJob.id ?? randomUUID()

  const job = {
    id,
    projectId,
    createdAt,
    availableAt,
    attempt: 0,
    metadata: newJob.metadata,
    type: newJob.type,
    payload: newJob.payload,
  } as TQueueJob

  const data = {
    id,
    projectId,
    type: newJob.type,
    payload: newJob.payload,
    createdAt,
    availableAt,
    metadata: newJob.metadata,
  } as unknown as QueueJobData<TQueueJob>

  const delayMs = Math.max(0, availableAtMs - Date.now())

  return { job, data, delayMs }
}

/**
 * Converts a BullMQ `Job` in active state into a Sixb `ClaimedQueueJob`.
 *
 * Sixb's `attempt` counts how many times a job has been claimed (including redelivery after
 * retry or stall). That maps to BullMQ's `attemptsStarted`, which the `moveToActive` Lua
 * script increments on every fetch; `attemptsMade` is a different counter that only
 * increments on failure and is not used here.
 */
export function toClaimed<TQueueJob extends QueueJob>(
  bullJob: BullJob<QueueJobData<TQueueJob>>,
  leaseId: string,
  leaseMs: number,
  claimedAtMs: number
): ClaimedQueueJob<TQueueJob> {
  const data = bullJob.data
  const claimedAt = new Date(claimedAtMs).toISOString()

  const job = {
    id: data.id,
    projectId: data.projectId,
    createdAt: data.createdAt,
    availableAt: data.availableAt,
    attempt: bullJob.attemptsStarted ?? 0,
    metadata: data.metadata,
    type: data.type,
    payload: data.payload,
  } as TQueueJob

  return {
    leaseId,
    claimedAt,
    leaseExpiresAt: new Date(claimedAtMs + leaseMs).toISOString(),
    job,
  }
}

export function envelopeToJob<TQueueJob extends QueueJob>(
  data: QueueJobData<TQueueJob>,
  attempt: number
): TQueueJob {
  return {
    id: data.id,
    projectId: data.projectId,
    createdAt: data.createdAt,
    availableAt: data.availableAt,
    attempt,
    metadata: data.metadata,
    type: data.type,
    payload: data.payload,
  } as TQueueJob
}
