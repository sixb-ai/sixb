import { randomUUID } from "node:crypto"
import type { SixbErrorCode } from "../errors/types"
import { QueueError } from "./errors"
import { IndexedHeap } from "./indexed-heap"
import type {
  ActionQueueJobFailureCode,
  ActionRunRequestedQueueJob,
  AgentQueueJob,
  AgentQueueJobFailureCode,
  ClaimedQueueJob,
  NewQueueJob,
  PipelineQueueJobFailureCode,
  PipelineRunRequestedQueueJob,
  ProjectionQueueJobFailureCode,
  ProjectionRunRequestedQueueJob,
  Queue,
  QueueJob,
  QueueJobFailure,
  Queues,
  SubagentQueueJob,
  SyncQueueJobFailureCode,
  SyncRunRequestedQueueJob,
  WorkflowQueueJob,
  WorkflowQueueJobFailureCode,
} from "./types"

type QueueRecordState = "queued" | "completed" | "failed"

interface QueueRecord<TQueueJob extends QueueJob = QueueJob> {
  readonly sequence: number
  readonly queueId: string
  job: TQueueJob
  availableAtMs: number
  readonly createdAtMs: number
  leaseExpiryMs: number | null
  // A leased job stays "queued" until a worker completes or fails it.
  state: QueueRecordState
  failure: QueueJobFailure | null
  leaseId: string | null
  claimedAt: string | null
  leaseExpiresAt: string | null
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (value.trim().length === 0) {
    throw new QueueError(`[Sixb] Queue ${fieldName} must not be empty`)
  }
}

function parseTimestamp(value: string, fieldName: string): number {
  const timestamp = Date.parse(value)

  if (Number.isNaN(timestamp)) {
    throw new QueueError(`[Sixb] Queue ${fieldName} must be a valid timestamp`)
  }

  return timestamp
}

function assertPositiveNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new QueueError(`[Sixb] Queue ${fieldName} must be greater than 0`)
  }
}

function clearLease(record: QueueRecord): void {
  record.leaseId = null
  record.claimedAt = null
  record.leaseExpiresAt = null
  record.leaseExpiryMs = null
}

// Best-effort ordering is part of the contract; this keeps the in-memory provider deterministic.
function compareQueueRecords(left: QueueRecord, right: QueueRecord): number {
  const availableDifference = left.availableAtMs - right.availableAtMs
  if (availableDifference !== 0) return availableDifference
  const createdDifference = left.createdAtMs - right.createdAtMs
  if (createdDifference !== 0) return createdDifference

  return left.sequence - right.sequence
}

function createQueueJob<TQueueJob extends QueueJob>(
  projectId: string,
  newJob: NewQueueJob<TQueueJob>
): TQueueJob {
  const createdAt = new Date().toISOString()
  const availableAt = newJob.availableAt ?? createdAt
  parseTimestamp(availableAt, "availableAt")

  return {
    id: newJob.id ?? randomUUID(),
    projectId,
    createdAt,
    availableAt,
    attempt: 0,
    metadata: newJob.metadata ? structuredClone(newJob.metadata) : undefined,
    type: newJob.type,
    payload: structuredClone(newJob.payload),
  } as TQueueJob
}

function leaseExpiresAtMs(record: QueueRecord): number | null {
  return record.leaseExpiryMs
}

function eligibleAt(record: QueueRecord): number {
  return Math.max(record.availableAtMs, record.leaseExpiryMs ?? -Infinity)
}

interface QueueLane {
  // Terminal records remain here for caller-id deduplication, never in the delivery indexes.
  readonly records: Map<string, QueueRecord>
  readonly ready: IndexedHeap<QueueRecord>
  readonly waiting: IndexedHeap<QueueRecord>
}

function toClaimedQueueJob<TQueueJob extends QueueJob>(
  record: QueueRecord<TQueueJob>
): ClaimedQueueJob<TQueueJob> {
  if (!record.leaseId || !record.claimedAt || !record.leaseExpiresAt) {
    throw new QueueError(`[Sixb] Queue job '${record.job.id}' is not currently leased`)
  }

  return {
    leaseId: record.leaseId,
    claimedAt: record.claimedAt,
    leaseExpiresAt: record.leaseExpiresAt,
    job: structuredClone(record.job),
  }
}

class InMemoryQueueStore {
  private readonly projects = new Map<string, Map<string, QueueLane>>()
  private nextSequence = 1

  add<TQueueJob extends QueueJob>(projectId: string, queueId: string, job: TQueueJob): void {
    const lane = this.lane(projectId, queueId)
    const record: QueueRecord = {
      sequence: this.nextSequence++,
      queueId,
      job,
      availableAtMs: parseTimestamp(job.availableAt, "job.availableAt"),
      createdAtMs: parseTimestamp(job.createdAt, "job.createdAt"),
      leaseExpiryMs: null,
      state: "queued",
      failure: null,
      leaseId: null,
      claimedAt: null,
      leaseExpiresAt: null,
    }
    lane.records.set(job.id, record)
    this.schedule(projectId, record, Date.now())
  }

  find<TQueueJob extends QueueJob>(
    projectId: string,
    queueId: string,
    jobId: string
  ): QueueRecord<TQueueJob> | null {
    return (this.projects.get(projectId)?.get(queueId)?.records.get(jobId) ??
      null) as QueueRecord<TQueueJob> | null
  }

  schedule(projectId: string, record: QueueRecord, now: number): void {
    const lane = this.lane(projectId, record.queueId)
    if (record.state !== "queued") {
      lane.ready.delete(record)
      lane.waiting.delete(record)
    } else if (eligibleAt(record) <= now) {
      lane.waiting.delete(record)
      lane.ready.set(record)
    } else {
      lane.ready.delete(record)
      lane.waiting.set(record)
    }
  }

  takeReady<TQueueJob extends QueueJob>(
    projectId: string,
    queueId: string,
    now: number,
    limit: number
  ): QueueRecord<TQueueJob>[] {
    const lane = this.projects.get(projectId)?.get(queueId)
    if (!lane) return []
    // Wake delayed jobs and expired leases, then order all ready jobs by the original contract.
    // A lease expiry controls eligibility, not the priority of a redelivered job.
    while (lane.waiting.peek() && eligibleAt(lane.waiting.peek()!) <= now) {
      lane.ready.set(lane.waiting.pop()!)
    }
    const selected: QueueRecord[] = []
    while (selected.length < limit) {
      const record = lane.ready.peek()
      if (!record || record.availableAtMs > now) break
      lane.ready.pop()
      // A backwards wall-clock adjustment can make a previously expired lease live again.
      if (eligibleAt(record) > now) lane.waiting.set(record)
      else selected.push(record)
    }
    return selected as QueueRecord<TQueueJob>[]
  }

  private lane(projectId: string, queueId: string): QueueLane {
    let queues = this.projects.get(projectId)
    if (!queues) {
      queues = new Map()
      this.projects.set(projectId, queues)
    }
    let lane = queues.get(queueId)
    if (!lane) {
      lane = {
        records: new Map(),
        ready: new IndexedHeap(compareQueueRecords),
        waiting: new IndexedHeap(
          (left, right) => eligibleAt(left) - eligibleAt(right) || left.sequence - right.sequence
        ),
      }
      queues.set(queueId, lane)
    }
    return lane
  }
}

class InMemoryQueue<TQueueJob extends QueueJob, TFailureCode extends SixbErrorCode>
  implements Queue<TQueueJob, TFailureCode>
{
  constructor(
    private readonly store: InMemoryQueueStore,
    private readonly queueId: string
  ) {
    assertNonEmpty(queueId, "queueId")
  }

  async enqueue(params: {
    projectId: string
    jobs: readonly NewQueueJob<TQueueJob>[]
  }): Promise<readonly TQueueJob[]> {
    assertNonEmpty(params.projectId, "projectId")

    if (params.jobs.length === 0) {
      return []
    }

    const createdJobs = params.jobs.map((job) => {
      if (job.id !== undefined) assertNonEmpty(job.id, "job.id")
      const existing = job.id
        ? this.store.find<TQueueJob>(params.projectId, this.queueId, job.id)
        : null
      if (existing) return existing.job

      const created = createQueueJob(params.projectId, job)
      this.store.add(params.projectId, this.queueId, created)
      return created
    })

    return createdJobs.map((job) => structuredClone(job))
  }

  async claim(params: {
    projectId: string
    workerId: string
    limit?: number
    leaseMs?: number
  }): Promise<readonly ClaimedQueueJob<TQueueJob>[]> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.workerId, "workerId")

    const limit = Math.trunc(params.limit ?? 1)
    if (!(limit > 0)) {
      return []
    }

    const leaseMs = params.leaseMs ?? 30_000
    assertPositiveNumber(leaseMs, "leaseMs")

    const now = Date.now()
    const claimedAt = new Date(now).toISOString()
    // Validate before removing candidates, and cache the same millisecond precision we return.
    const leaseExpiry = new Date(now + leaseMs)
    const leaseExpiresAt = leaseExpiry.toISOString()
    const claimable = this.store.takeReady<TQueueJob>(params.projectId, this.queueId, now, limit)

    return claimable.map((record) => {
      // Attempts count claims so redelivery after lease expiry or retry is visible to workers.
      record.job = {
        ...record.job,
        attempt: record.job.attempt + 1,
      }
      record.leaseId = randomUUID()
      record.claimedAt = claimedAt
      record.leaseExpiresAt = leaseExpiresAt
      record.leaseExpiryMs = leaseExpiry.getTime()
      this.store.schedule(params.projectId, record, now)

      return toClaimedQueueJob(record)
    })
  }

  async complete(params: { projectId: string; jobId: string; leaseId: string }): Promise<void> {
    const record = this.requireActiveLease(params)
    record.state = "completed"
    clearLease(record)
    this.store.schedule(params.projectId, record, Date.now())
  }

  async retry(params: {
    projectId: string
    jobId: string
    leaseId: string
    availableAt?: string
  }): Promise<void> {
    const record = this.requireActiveLease(params)
    const availableAt = params.availableAt ?? new Date().toISOString()
    const availableAtMs = parseTimestamp(availableAt, "availableAt")

    record.availableAtMs = availableAtMs
    record.job = {
      ...record.job,
      availableAt,
    }
    clearLease(record)
    this.store.schedule(params.projectId, record, Date.now())
  }

  async fail(params: {
    projectId: string
    jobId: string
    leaseId: string
    failure: QueueJobFailure<TFailureCode>
  }): Promise<void> {
    const record = this.requireActiveLease(params)
    record.state = "failed"
    record.failure = structuredClone(params.failure)
    clearLease(record)
    this.store.schedule(params.projectId, record, Date.now())
  }

  async renewLease(params: {
    projectId: string
    jobId: string
    leaseId: string
    leaseMs: number
  }): Promise<ClaimedQueueJob<TQueueJob> | null> {
    assertPositiveNumber(params.leaseMs, "leaseMs")

    const record = this.store.find<TQueueJob>(params.projectId, this.queueId, params.jobId)
    if (!record || record.state !== "queued") {
      return null
    }

    const now = Date.now()
    const expiresAt = leaseExpiresAtMs(record)
    if (record.leaseId !== params.leaseId || expiresAt === null) {
      return null
    }

    if (expiresAt <= now) {
      return null
    }

    const leaseExpiry = new Date(now + params.leaseMs)
    record.leaseExpiresAt = leaseExpiry.toISOString()
    record.leaseExpiryMs = leaseExpiry.getTime()
    this.store.schedule(params.projectId, record, now)
    return toClaimedQueueJob(record)
  }

  private requireActiveLease(params: {
    projectId: string
    jobId: string
    leaseId: string
  }): QueueRecord<TQueueJob> {
    assertNonEmpty(params.projectId, "projectId")
    assertNonEmpty(params.jobId, "jobId")
    assertNonEmpty(params.leaseId, "leaseId")

    const record = this.store.find<TQueueJob>(params.projectId, this.queueId, params.jobId)

    if (!record) {
      throw new QueueError(`[Sixb] Unknown queue job '${params.jobId}'`)
    }

    if (record.state !== "queued") {
      throw new QueueError(`[Sixb] Queue job '${params.jobId}' is no longer active`)
    }

    if (record.leaseId !== params.leaseId || !record.leaseExpiresAt) {
      throw new QueueError(`[Sixb] Lease mismatch for queue job '${params.jobId}'`)
    }

    const expiresAt = leaseExpiresAtMs(record)
    if (expiresAt === null || expiresAt <= Date.now()) {
      throw new QueueError(`[Sixb] Lease for queue job '${params.jobId}' has expired`)
    }

    return record
  }
}

export class InMemoryQueues implements Queues {
  readonly scope = "process" as const
  private readonly store = new InMemoryQueueStore()

  readonly syncRuns = new InMemoryQueue<SyncRunRequestedQueueJob, SyncQueueJobFailureCode>(
    this.store,
    "sync.runs"
  )
  readonly pipelines = new InMemoryQueue<PipelineRunRequestedQueueJob, PipelineQueueJobFailureCode>(
    this.store,
    "pipeline.runs"
  )
  readonly projections = new InMemoryQueue<
    ProjectionRunRequestedQueueJob,
    ProjectionQueueJobFailureCode
  >(this.store, "projection.runs")
  readonly workflows = new InMemoryQueue<WorkflowQueueJob, WorkflowQueueJobFailureCode>(
    this.store,
    "workflow.runs"
  )
  readonly actions = new InMemoryQueue<ActionRunRequestedQueueJob, ActionQueueJobFailureCode>(
    this.store,
    "action.runs"
  )
  readonly agents = new InMemoryQueue<AgentQueueJob, AgentQueueJobFailureCode>(
    this.store,
    "agent.runs"
  )
  readonly agentChildren = new InMemoryQueue<SubagentQueueJob, AgentQueueJobFailureCode>(
    this.store,
    "agent.children"
  )

  /** Nothing to reach: the store is a field of this object. */
  health(): Promise<void> {
    return Promise.resolve()
  }
}
