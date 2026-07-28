import { randomUUID } from "node:crypto"
import type { Queue } from "@sixb/core"
import {
  type ClaimedQueueJob,
  type NewQueueJob,
  QueueError,
  type QueueJob,
  type QueueJobError,
} from "@sixb/core/queues"
import {
  type Job as BullJob,
  Queue as BullQueue,
  Worker as BullWorker,
  type KeepJobs,
  UnrecoverableError,
} from "bullmq"
import {
  buildEnvelope,
  envelopeToJob,
  type QueueJobData,
  toBullMqJobId,
  toClaimed,
} from "./adapter"
import type { BullMqConnections } from "./connection"
import { wrapLeaseError } from "./errors"
import { assertNonEmpty, assertPositiveNumber, parseTimestamp } from "./validation"

export interface BullMqLaneShared {
  readonly connections: BullMqConnections
  readonly prefix: string
  readonly defaultLeaseMs: number
  readonly removeOnComplete: KeepJobs | number | boolean
  readonly removeOnFail: KeepJobs | number | boolean
  readonly stalledInterval: number
  readonly maxStalledCount: number
}

/**
 * Translates Sixb's `Queue<TJob>` contract onto BullMQ's manual-fetch primitives.
 *
 * Each `(projectId, laneId)` pair maps to a dedicated BullMQ queue named
 * `${projectId}:${laneId}` under the shared prefix. `Queue` handles are created lazily on the
 * first non-claim operation; `Worker` handles are created lazily on the first `claim()` and
 * reused for the lifetime of the provider.
 *
 * Design notes:
 * - `leaseId` is minted per `claim()` as a UUID and passed to BullMQ as its `token`.
 * - `attempt` is read back from BullMQ's `attemptsStarted`, which increments on every move to
 *   active (including redelivery after retry or stall). `attemptsMade` is a different counter
 *   that only increments on failure and is not used here.
 * - BullMQ's built-in retry machinery is deliberately bypassed (`attempts: 1`): the Sixb
 *   contract places retry policy on the caller, not the broker.
 */
export class BullMqQueue<TQueueJob extends QueueJob> implements Queue<TQueueJob> {
  private readonly queuesByProject = new Map<string, BullQueue<QueueJobData<TQueueJob>>>()
  private readonly workersByProject = new Map<string, BullWorker<QueueJobData<TQueueJob>>>()
  private closed = false

  constructor(
    private readonly shared: BullMqLaneShared,
    private readonly laneId: string
  ) {
    assertNonEmpty(laneId, "laneId")
  }

  async enqueue(params: {
    projectId: string
    jobs: readonly NewQueueJob<TQueueJob>[]
  }): Promise<readonly TQueueJob[]> {
    assertNonEmpty(params.projectId, "projectId")
    if (params.jobs.length === 0) return []
    for (const job of params.jobs) {
      if (job.id !== undefined) assertNonEmpty(job.id, "job.id")
    }

    const envelopes = params.jobs.map((job) => buildEnvelope<TQueueJob>(params.projectId, job))
    const queue = this.getQueue(params.projectId)

    // BullMQ's `addBulk` signature uses `ExtractNameType<Data>` which only narrows when the
    // data type is a discriminated union of literal `name`s. Our generic `TQueueJob["type"]`
    // doesn't satisfy that inference, so we widen the array at the call site.
    type AddBulkArg = Parameters<typeof queue.addBulk>[0]
    await queue.addBulk(
      envelopes.map((envelope) => ({
        name: envelope.data.type,
        data: envelope.data,
        opts: {
          jobId: toBullMqJobId(envelope.data.id),
          delay: envelope.delayMs,
          attempts: 1,
          removeOnComplete: this.shared.removeOnComplete,
          removeOnFail: this.shared.removeOnFail,
        },
      })) as unknown as AddBulkArg
    )

    return envelopes.map((envelope) => envelope.job)
  }

  async claim(params: {
    projectId: string
    workerId: string
    limit?: number
    leaseMs?: number
  }): Promise<readonly ClaimedQueueJob<TQueueJob>[]> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.workerId, "workerId")

    const limit = params.limit ?? 1
    if (limit <= 0) return []

    const leaseMs = params.leaseMs ?? this.shared.defaultLeaseMs
    assertPositiveNumber(leaseMs, "leaseMs")

    const worker = this.getWorker(params.projectId)
    const claimed: ClaimedQueueJob<TQueueJob>[] = []

    for (let i = 0; i < limit; i++) {
      const token = randomUUID()
      const bullJob = (await worker.getNextJob(token)) as
        | BullJob<QueueJobData<TQueueJob>>
        | undefined
      if (!bullJob) break

      const claimedAtMs = Date.now()
      const extended = await extendLockOrZero(bullJob, token, leaseMs)
      if (!extended) {
        // The lock was lost between fetch and extend (rare — only under racing stall checks).
        // Skip this job and let the next claim attempt pick it up again after its lock expires.
        continue
      }

      claimed.push(toClaimed<TQueueJob>(bullJob, token, leaseMs, claimedAtMs))
    }

    return claimed
  }

  async complete(params: { projectId: string; jobId: string; leaseId: string }): Promise<void> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.jobId, "jobId")
    assertNonEmpty(params.leaseId, "leaseId")

    const bullJob = await this.loadKnownJob(params.projectId, params.jobId)
    try {
      await bullJob.moveToCompleted(undefined, params.leaseId, false)
    } catch (error) {
      throw wrapLeaseError(error, params.jobId)
    }
  }

  async retry(params: {
    projectId: string
    jobId: string
    leaseId: string
    availableAt?: string
    error?: QueueJobError
  }): Promise<void> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.jobId, "jobId")
    assertNonEmpty(params.leaseId, "leaseId")

    const availableAt = params.availableAt ?? new Date().toISOString()
    const availableAtMs = parseTimestamp(availableAt, "availableAt")

    const bullJob = await this.loadKnownJob(params.projectId, params.jobId)
    try {
      await bullJob.moveToDelayed(Math.max(availableAtMs, Date.now()), params.leaseId)
    } catch (error) {
      throw wrapLeaseError(error, params.jobId)
    }
  }

  async fail(params: {
    projectId: string
    jobId: string
    leaseId: string
    error: QueueJobError
  }): Promise<void> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.jobId, "jobId")
    assertNonEmpty(params.leaseId, "leaseId")

    const bullJob = await this.loadKnownJob(params.projectId, params.jobId)
    const wrapped = new UnrecoverableError(params.error.message)
    if (params.error.name) wrapped.name = params.error.name

    try {
      await bullJob.moveToFailed(wrapped, params.leaseId, false)
    } catch (error) {
      throw wrapLeaseError(error, params.jobId)
    }
  }

  async renewLease(params: {
    projectId: string
    jobId: string
    leaseId: string
    leaseMs: number
  }): Promise<ClaimedQueueJob<TQueueJob> | null> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.jobId, "jobId")
    assertNonEmpty(params.leaseId, "leaseId")
    assertPositiveNumber(params.leaseMs, "leaseMs")

    const queue = this.getQueue(params.projectId)
    const bullJob = (await queue.getJob(toBullMqJobId(params.jobId))) as
      | BullJob<QueueJobData<TQueueJob>>
      | undefined
    if (!bullJob) return null

    const extended = await extendLockOrZero(bullJob, params.leaseId, params.leaseMs)
    if (!extended) return null

    const claimedAtMs = Date.now()
    return {
      leaseId: params.leaseId,
      claimedAt: new Date(claimedAtMs).toISOString(),
      leaseExpiresAt: new Date(claimedAtMs + params.leaseMs).toISOString(),
      job: envelopeToJob<TQueueJob>(bullJob.data, bullJob.attemptsStarted ?? 0),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const closers: Promise<unknown>[] = []
    for (const worker of this.workersByProject.values()) {
      stopStalledCheckTimer(worker)
      closers.push(worker.close().catch(() => undefined))
    }
    for (const queue of this.queuesByProject.values()) {
      closers.push(queue.close().catch(() => undefined))
    }
    this.workersByProject.clear()
    this.queuesByProject.clear()
    await Promise.all(closers)
  }

  private async loadKnownJob(
    projectId: string,
    jobId: string
  ): Promise<BullJob<QueueJobData<TQueueJob>>> {
    const queue = this.getQueue(projectId)
    const bullJob = (await queue.getJob(toBullMqJobId(jobId))) as
      | BullJob<QueueJobData<TQueueJob>>
      | undefined
    if (!bullJob) {
      throw new QueueError(`[Sixb] Unknown queue job '${jobId}'`)
    }
    return bullJob
  }

  private getQueue(projectId: string): BullQueue<QueueJobData<TQueueJob>> {
    if (this.closed) {
      throw new QueueError("[Sixb] BullMqQueues has been closed")
    }

    const existing = this.queuesByProject.get(projectId)
    if (existing) return existing

    // BullMQ forbids `:` in queue names, so per-tenant scoping goes in the prefix instead.
    // Redis keys end up as `${prefix}:${projectId}:{${laneId}}:...`, which matches the
    // `sixb:<projectId>:<lane>:...` layout documented for the provider.
    const prefix = `${this.shared.prefix}:${projectId}`
    const queue = new BullQueue<QueueJobData<TQueueJob>>(this.laneId, {
      connection: this.shared.connections.queueConnection,
      prefix,
    })
    queue.on("error", noop)
    this.queuesByProject.set(projectId, queue)
    return queue
  }

  private getWorker(projectId: string): BullWorker<QueueJobData<TQueueJob>> {
    if (this.closed) {
      throw new QueueError("[Sixb] BullMqQueues has been closed")
    }

    const existing = this.workersByProject.get(projectId)
    if (existing) return existing

    const prefix = `${this.shared.prefix}:${projectId}`
    const worker = new BullWorker<QueueJobData<TQueueJob>>(this.laneId, null, {
      connection: this.shared.connections.workerConnection,
      prefix,
      autorun: false,
      lockDuration: this.shared.defaultLeaseMs,
      stalledInterval: this.shared.stalledInterval,
      maxStalledCount: this.shared.maxStalledCount,
    })
    // BullMQ workers emit `error` when the stalled-check timer or a fetch hits a connection
    // problem (e.g., mid-shutdown). Unhandled, they bubble up as test failures; we swallow
    // them because the underlying command promise is already settled by BullMQ's own
    // `checkConnectionError` path.
    worker.on("error", noop)
    void worker.startStalledCheckTimer()

    this.workersByProject.set(projectId, worker)
    return worker
  }
}

function noop(): void {}

function stopStalledCheckTimer(worker: BullWorker): void {
  ;(worker as unknown as { stalledCheckStopper?: (() => void) | undefined }).stalledCheckStopper?.()
}

/**
 * BullMQ's `extendLock` does not throw on token mismatch — the underlying Lua script returns
 * `0` when the lock's current value is not the caller's token (or the key no longer exists).
 * Calling code needs that signal to return `null` from `renewLease` and to skip the claim in
 * the rare racing-stall-check window. This helper folds the error path and the silent-zero
 * path into a single boolean: `true` iff the lock was actually extended.
 */
async function extendLockOrZero(
  bullJob: BullJob,
  token: string,
  leaseMs: number
): Promise<boolean> {
  try {
    const result = await bullJob.extendLock(token, leaseMs)
    return Number(result) > 0
  } catch {
    return false
  }
}
