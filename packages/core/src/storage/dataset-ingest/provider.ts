import { decodeDatasetIngestChanges, encodeDatasetIngestChanges } from "./codec"
import type {
  AcquireDatasetIngestLeaseResult,
  AppendDatasetIngestDeliveryInput,
  DatasetIngestAppendResult,
  DatasetIngestBatch,
  DatasetIngestChange,
  DatasetIngestDelivery,
  DatasetIngestFlushRequest,
  DatasetIngestLease,
  DatasetIngestRejection,
  DatasetIngestStorage,
  DatasetIngestSummary,
  TakeDatasetIngestBatchInput,
} from "./types"

export { decodeDatasetIngestChanges, encodeDatasetIngestChanges } from "./codec"

/** A dataset's flush state: its open request, its lease, and the batch in flight. */
export interface DatasetIngestState {
  readonly datasetId: string
  readonly request: number
  /** When a flush of the open request was last asked for. Null when none is open. */
  readonly requestedAt: Date | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: Date | null
  readonly flushId: string | null
  readonly flushStartedAt: Date | null
  readonly failureStreak: number
  readonly lastFlushedAt: Date | null
}

export interface DatasetIngestDeliveryRecord {
  readonly datasetId: string
  readonly executionId: string
  readonly correlationId: string
  readonly receivedAt: Date
  readonly changeCount: number
  readonly definitionHash: string
  /** `encodeDatasetIngestChanges` text. */
  readonly changes: string
}

export interface DatasetIngestPendingCounts {
  readonly datasetId: string
  readonly pendingDeliveries: number
  readonly pendingChanges: number
  readonly oldestReceivedAt: Date | null
  readonly rejectedDeliveries: number
}

export interface DatasetIngestRejectionRecord {
  readonly delivery: DatasetIngestDelivery
  readonly rejectedAt: Date
  readonly reason: string
  /** `encodeDatasetIngestChanges` text. */
  readonly changes: string
}

/** Database-specific row access used by the shared inbox state machine. */
export interface DatasetIngestPersistence {
  now(): Promise<Date>
  /** Inside `transaction`: the dataset's state, created if missing, locked until the transaction ends. */
  lockState(projectId: string, datasetId: string): Promise<DatasetIngestState>
  writeState(projectId: string, state: DatasetIngestState): Promise<void>
  insertDelivery(projectId: string, record: DatasetIngestDeliveryRecord): Promise<string>
  /** Deliveries no flush has taken and none refused, in inbox order, at most `limit`. */
  listUntaken(
    projectId: string,
    datasetId: string,
    limit: number
  ): Promise<readonly DatasetIngestDelivery[]>
  take(
    projectId: string,
    datasetId: string,
    deliveryIds: readonly string[],
    flushId: string
  ): Promise<void>
  /** A flush's deliveries in inbox order. */
  listFlush(
    projectId: string,
    datasetId: string,
    flushId: string
  ): Promise<readonly DatasetIngestDelivery[]>
  /** A flush's deliveries after `afterId` (all when null), in inbox order, with their changes. */
  readFlush(
    projectId: string,
    datasetId: string,
    flushId: string,
    page: { readonly afterId: string | null; readonly limit: number }
  ): Promise<readonly { readonly delivery: DatasetIngestDelivery; readonly changes: string }[]>
  deleteFlush(projectId: string, datasetId: string, flushId: string): Promise<void>
  /** Moves a delivery out of its flush and marks it refused. */
  rejectDelivery(
    projectId: string,
    datasetId: string,
    flushId: string,
    deliveryId: string,
    rejection: { readonly rejectedAt: Date; readonly reason: string }
  ): Promise<void>
  listRejected(
    projectId: string,
    datasetId: string | undefined,
    limit: number
  ): Promise<readonly DatasetIngestRejectionRecord[]>
  deleteRejected(projectId: string, before: Date): Promise<void>
  listStates(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestState[]>
  countPending(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestPendingCounts[]>
}

/** Transaction and lock boundary supplied by a concrete durable storage provider. */
export interface DatasetIngestPersistenceBackend {
  read<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T>
  transaction<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T>
}

/** The lease was taken over after it expired: the owner must stop without writing. */
export class DatasetIngestLeaseLostError extends Error {
  override readonly name = "DatasetIngestLeaseLostError"
}

// A flush reads its deliveries this many at a time, so a large batch is never held twice.
const READ_PAGE_SIZE = 50

/**
 * An open request nobody took for this long may have no job: the process that opened it died, or
 * the queue refused it. The next delivery asks again under the same id, which queues nothing if
 * the job exists, so ingestion restarts by itself. A request is taken in about a second, so the
 * healthy path never gets here, and a stuck one costs one queue call this often, not one a delivery.
 */
const ASK_AGAIN_AFTER_MS = 30_000

/**
 * Shared durable implementation of the ingest inbox. Concrete providers own SQL, transactions and
 * database time; every rule about requests, leases and batches lives here so SQLite, PostgreSQL
 * and the in-memory reference cannot drift.
 *
 * Why a request and a batch never miss a delivery: `append` inserts the delivery and then locks
 * the state row to request a flush, in one transaction. `takeBatch` closes the request and reads
 * the deliveries under that same lock. So either the append commits first and the batch sees its
 * delivery, or the batch closes the request first and the append opens a new one.
 *
 * Why no delivery waits for a job that already ran: a job's id names a request, and a job only ends
 * after moving the request past it, by finding nothing left to take or by handing over. A job that
 * fails stays queued under its id. So the id the inbox holds is always free or still in the queue,
 * and asking under it again is safe. Only a batch or a hand-over moves the request: moving it at
 * every attempt would open a job per failed attempt during an outage.
 */
export class DurableDatasetIngestStorage implements DatasetIngestStorage {
  constructor(private readonly backend: DatasetIngestPersistenceBackend) {}

  async append(input: AppendDatasetIngestDeliveryInput): Promise<DatasetIngestAppendResult> {
    assertNonBlank(input.projectId, "projectId")
    assertNonBlank(input.datasetId, "datasetId")
    assertNonBlank(input.executionId, "executionId")
    assertNonBlank(input.correlationId, "correlationId")
    assertNonBlank(input.definitionHash, "definitionHash")
    if (input.changes.length === 0) {
      throw new Error("[Sixb] A dataset ingest delivery needs at least one change.")
    }

    const changes = encodeDatasetIngestChanges(input.changes)

    return this.backend.transaction(async (persistence) => {
      const receivedAt = await persistence.now()
      const record: DatasetIngestDeliveryRecord = {
        datasetId: input.datasetId,
        executionId: input.executionId,
        correlationId: input.correlationId,
        receivedAt,
        changeCount: input.changes.length,
        definitionHash: input.definitionHash,
        changes,
      }
      const id = await persistence.insertDelivery(input.projectId, record)
      const flush = await requestFlushIn(persistence, input.projectId, input.datasetId, receivedAt)

      const { changes: _changes, ...delivery } = record
      return { delivery: { id, ...delivery }, flush }
    })
  }

  async acquire(input: {
    readonly projectId: string
    readonly datasetId: string
    readonly owner: string
    readonly leaseMs: number
  }): Promise<AcquireDatasetIngestLeaseResult> {
    assertNonBlank(input.owner, "owner")
    assertLeaseMs(input.leaseMs)

    return this.backend.transaction(async (persistence) => {
      const now = await persistence.now()
      const state = await persistence.lockState(input.projectId, input.datasetId)

      if (
        state.leaseOwner !== null &&
        state.leaseOwner !== input.owner &&
        state.leaseExpiresAt !== null &&
        state.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return { acquired: false, busyUntil: state.leaseExpiresAt }
      }

      const expiresAt = new Date(now.getTime() + input.leaseMs)
      await persistence.writeState(input.projectId, {
        ...state,
        leaseOwner: input.owner,
        leaseExpiresAt: expiresAt,
      })

      const inFlight =
        state.flushId === null || state.flushStartedAt === null
          ? null
          : {
              flushId: state.flushId,
              startedAt: state.flushStartedAt,
              deliveries: await persistence.listFlush(
                input.projectId,
                input.datasetId,
                state.flushId
              ),
            }

      return {
        acquired: true,
        lease: {
          projectId: input.projectId,
          datasetId: input.datasetId,
          owner: input.owner,
          expiresAt,
          inFlight,
        },
      }
    })
  }

  async renew(input: {
    readonly lease: DatasetIngestLease
    readonly leaseMs: number
  }): Promise<DatasetIngestLease | null> {
    assertLeaseMs(input.leaseMs)
    const { lease } = input

    return this.backend.transaction(async (persistence) => {
      const now = await persistence.now()
      const state = await persistence.lockState(lease.projectId, lease.datasetId)
      if (state.leaseOwner !== lease.owner) return null

      const expiresAt = new Date(now.getTime() + input.leaseMs)
      await persistence.writeState(lease.projectId, { ...state, leaseExpiresAt: expiresAt })
      return { ...lease, expiresAt }
    })
  }

  async takeBatch(input: TakeDatasetIngestBatchInput): Promise<DatasetIngestBatch | null> {
    const { lease } = input
    assertNonBlank(input.flushId, "flushId")
    if (!Number.isSafeInteger(input.maxChanges) || input.maxChanges < 1) {
      throw new Error("[Sixb] Dataset ingest maxChanges must be a positive integer.")
    }

    return this.backend.transaction(async (persistence) => {
      const state = await lockOwnedState(persistence, lease)
      if (state.flushId !== null) {
        throw new Error(
          `[Sixb] Dataset '${lease.datasetId}' flush '${state.flushId}' is still in flight; resume it before taking another batch.`
        )
      }

      // Every batch moves to the next request, so a request named after one that a flush has
      // closed is never reused by a delivery that comes later.
      const closed = { ...state, requestedAt: null, request: state.request + 1 }
      const untaken = await persistence.listUntaken(
        lease.projectId,
        lease.datasetId,
        input.maxChanges
      )

      if (untaken.length === 0) {
        await persistence.writeState(lease.projectId, {
          ...closed,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        return null
      }

      const deliveries = wholeDeliveries(untaken, input.maxChanges)
      const startedAt = await persistence.now()

      await persistence.take(
        lease.projectId,
        lease.datasetId,
        deliveries.map((delivery) => delivery.id),
        input.flushId
      )
      await persistence.writeState(lease.projectId, {
        ...closed,
        flushId: input.flushId,
        flushStartedAt: startedAt,
      })

      return { flushId: input.flushId, startedAt, deliveries }
    })
  }

  async *readChanges(input: {
    readonly lease: DatasetIngestLease
    readonly flushId: string
  }): AsyncIterable<{
    readonly delivery: DatasetIngestDelivery
    readonly changes: readonly DatasetIngestChange[]
  }> {
    const { lease, flushId } = input
    let afterId: string | null = null

    while (true) {
      const page = await this.backend.read((persistence) =>
        persistence.readFlush(lease.projectId, lease.datasetId, flushId, {
          afterId,
          limit: READ_PAGE_SIZE,
        })
      )

      for (const { delivery, changes } of page) {
        yield { delivery, changes: decodeDatasetIngestChanges(changes) }
      }

      const last = page.at(-1)
      if (!last || page.length < READ_PAGE_SIZE) return
      afterId = last.delivery.id
    }
  }

  async complete(input: {
    readonly lease: DatasetIngestLease
    readonly flushId: string
  }): Promise<void> {
    const { lease, flushId } = input

    await this.backend.transaction(async (persistence) => {
      const state = await lockFlushState(persistence, lease, flushId)

      await persistence.deleteFlush(lease.projectId, lease.datasetId, flushId)
      await persistence.writeState(lease.projectId, {
        ...state,
        flushId: null,
        flushStartedAt: null,
        failureStreak: 0,
        lastFlushedAt: await persistence.now(),
      })
    })
  }

  async reject(input: {
    readonly lease: DatasetIngestLease
    readonly flushId: string
    readonly deliveryId: string
    readonly reason: string
  }): Promise<void> {
    const { lease, flushId, deliveryId, reason } = input

    await this.backend.transaction(async (persistence) => {
      await lockFlushState(persistence, lease, flushId)
      await persistence.rejectDelivery(lease.projectId, lease.datasetId, flushId, deliveryId, {
        rejectedAt: await persistence.now(),
        reason,
      })
    })
  }

  async listRejected(input: {
    readonly projectId: string
    readonly datasetId?: string
    readonly limit: number
  }): Promise<readonly DatasetIngestRejection[]> {
    const records = await this.backend.read((persistence) =>
      persistence.listRejected(input.projectId, input.datasetId, input.limit)
    )

    return records.map((record) => ({
      ...record,
      changes: decodeDatasetIngestChanges(record.changes),
    }))
  }

  async purgeRejected(input: {
    readonly projectId: string
    readonly olderThanMs: number
  }): Promise<void> {
    await this.backend.transaction(async (persistence) => {
      const now = await persistence.now()
      await persistence.deleteRejected(input.projectId, new Date(now.getTime() - input.olderThanMs))
    })
  }

  async fail(input: {
    readonly lease: DatasetIngestLease
  }): Promise<{ readonly failureStreak: number }> {
    const { lease } = input

    return this.backend.transaction(async (persistence) => {
      const state = await persistence.lockState(lease.projectId, lease.datasetId)
      // A lost lease is its new owner's to count.
      if (state.leaseOwner !== lease.owner) return { failureStreak: state.failureStreak }

      const failureStreak = state.failureStreak + 1
      await persistence.writeState(lease.projectId, {
        ...state,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureStreak,
      })
      return { failureStreak }
    })
  }

  async release(input: { readonly lease: DatasetIngestLease }): Promise<void> {
    const { lease } = input

    await this.backend.transaction(async (persistence) => {
      const state = await persistence.lockState(lease.projectId, lease.datasetId)
      if (state.leaseOwner !== lease.owner) return

      await persistence.writeState(lease.projectId, {
        ...state,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
    })
  }

  async handOver(input: {
    readonly lease: DatasetIngestLease
  }): Promise<{ readonly request: number }> {
    const { lease } = input

    return this.backend.transaction(async (persistence) => {
      const state = await lockOwnedState(persistence, lease)
      const request = state.request + 1

      await persistence.writeState(lease.projectId, {
        ...state,
        request,
        requestedAt: await persistence.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      return { request }
    })
  }

  async summarize(input: {
    readonly projectId: string
    readonly datasetIds?: readonly string[]
  }): Promise<readonly DatasetIngestSummary[]> {
    return this.backend.read(async (persistence) => {
      const now = await persistence.now()
      const states = await persistence.listStates(input.projectId, input.datasetIds)
      const pending = await persistence.countPending(input.projectId, input.datasetIds)

      const statesById = new Map(states.map((state) => [state.datasetId, state]))
      const pendingById = new Map(pending.map((counts) => [counts.datasetId, counts]))
      const datasetIds = new Set([...pendingById.keys()])

      for (const state of states) {
        if (isLeaseLive(state, now)) datasetIds.add(state.datasetId)
      }

      return [...datasetIds].sort().map((datasetId) => {
        const state = statesById.get(datasetId)
        const counts = pendingById.get(datasetId)
        const leased = state !== undefined && isLeaseLive(state, now)

        return {
          datasetId,
          pendingDeliveries: counts?.pendingDeliveries ?? 0,
          pendingChanges: counts?.pendingChanges ?? 0,
          oldestReceivedAt: counts?.oldestReceivedAt ?? null,
          request: state?.request ?? 0,
          leaseExpiresAt: leased ? state.leaseExpiresAt : null,
          failureStreak: state?.failureStreak ?? 0,
          lastFlushedAt: state?.lastFlushedAt ?? null,
          rejectedDeliveries: counts?.rejectedDeliveries ?? 0,
        }
      })
    })
  }
}

/** Opens a flush request under the state-row lock, or joins the one open unless it went quiet. */
async function requestFlushIn(
  persistence: DatasetIngestPersistence,
  projectId: string,
  datasetId: string,
  now: Date
): Promise<DatasetIngestFlushRequest> {
  const state = await persistence.lockState(projectId, datasetId)
  const { request, requestedAt } = state

  if (requestedAt !== null && now.getTime() - requestedAt.getTime() < ASK_AGAIN_AFTER_MS) {
    return { request, requested: false }
  }

  await persistence.writeState(projectId, { ...state, requestedAt: now })
  return { request, requested: true }
}

/** A new dataset's state. */
export function initialDatasetIngestState(datasetId: string): DatasetIngestState {
  return {
    datasetId,
    request: 0,
    requestedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    flushId: null,
    flushStartedAt: null,
    failureStreak: 0,
    lastFlushedAt: null,
  }
}

/** The deliveries in order up to `maxChanges` changes, and always the first one. */
function wholeDeliveries(
  untaken: readonly DatasetIngestDelivery[],
  maxChanges: number
): DatasetIngestDelivery[] {
  const taken: DatasetIngestDelivery[] = []
  let changes = 0

  for (const delivery of untaken) {
    if (taken.length > 0 && changes + delivery.changeCount > maxChanges) break
    taken.push(delivery)
    changes += delivery.changeCount
  }

  return taken
}

async function lockOwnedState(
  persistence: DatasetIngestPersistence,
  lease: DatasetIngestLease
): Promise<DatasetIngestState> {
  const state = await persistence.lockState(lease.projectId, lease.datasetId)
  if (state.leaseOwner !== lease.owner) {
    throw new DatasetIngestLeaseLostError(
      `[Sixb] Dataset '${lease.datasetId}' ingest lease was taken over by another flush.`
    )
  }
  return state
}

async function lockFlushState(
  persistence: DatasetIngestPersistence,
  lease: DatasetIngestLease,
  flushId: string
): Promise<DatasetIngestState> {
  const state = await lockOwnedState(persistence, lease)
  if (state.flushId !== flushId) {
    throw new Error(`[Sixb] Dataset '${lease.datasetId}' has no flush '${flushId}' in flight.`)
  }
  return state
}

function isLeaseLive(state: DatasetIngestState, now: Date): boolean {
  return (
    state.leaseOwner !== null &&
    state.leaseExpiresAt !== null &&
    state.leaseExpiresAt.getTime() > now.getTime()
  )
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[Sixb] Dataset ingest ${field} must not be blank.`)
  }
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("[Sixb] Dataset ingest leaseMs must be a non-negative integer.")
  }
}
