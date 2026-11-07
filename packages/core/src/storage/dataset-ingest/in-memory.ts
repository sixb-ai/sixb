import {
  type DatasetIngestDeliveryRecord,
  type DatasetIngestPendingCounts,
  type DatasetIngestPersistence,
  type DatasetIngestPersistenceBackend,
  type DatasetIngestState,
  DurableDatasetIngestStorage,
  initialDatasetIngestState,
} from "./provider"
import type { DatasetIngestDelivery } from "./types"

interface StoredDelivery extends DatasetIngestDeliveryRecord {
  readonly projectId: string
  readonly id: bigint
  readonly flushId: string | null
}

interface InMemoryDatasetIngestData {
  nextId: bigint
  readonly deliveries: Map<bigint, StoredDelivery>
  readonly states: Map<string, DatasetIngestState>
}

export type InMemoryDatasetIngestSnapshot = InMemoryDatasetIngestData

/**
 * In-memory {@link DatasetIngestStorage}: the shared inbox state machine over Maps. Deliveries
 * live only in this process's memory and are lost on restart.
 */
export class InMemoryDatasetIngestStorage extends DurableDatasetIngestStorage {
  private readonly data: InMemoryDatasetIngestData

  constructor() {
    const data: InMemoryDatasetIngestData = { nextId: 1n, deliveries: new Map(), states: new Map() }
    super(new InMemoryDatasetIngestBackend(data))
    this.data = data
  }

  snapshot(): InMemoryDatasetIngestSnapshot {
    return structuredClone(this.data)
  }

  restore(snapshot: InMemoryDatasetIngestSnapshot): void {
    const copy = structuredClone(snapshot)
    this.data.nextId = copy.nextId
    replaceEntries(this.data.deliveries, copy.deliveries)
    replaceEntries(this.data.states, copy.states)
  }
}

class InMemoryDatasetIngestBackend implements DatasetIngestPersistenceBackend {
  private readonly persistence: DatasetIngestPersistence
  // Every await yields; chaining transactions keeps read-modify-write atomic.
  private tail: Promise<unknown> = Promise.resolve()

  constructor(data: InMemoryDatasetIngestData) {
    this.persistence = new InMemoryDatasetIngestPersistence(data)
  }

  read<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    return run(this.persistence)
  }

  transaction<T>(run: (persistence: DatasetIngestPersistence) => Promise<T>): Promise<T> {
    const result = this.tail.then(() => run(this.persistence))
    this.tail = result.catch(() => undefined)
    return result
  }
}

class InMemoryDatasetIngestPersistence implements DatasetIngestPersistence {
  constructor(private readonly data: InMemoryDatasetIngestData) {}

  async now(): Promise<Date> {
    return new Date()
  }

  async lockState(projectId: string, datasetId: string): Promise<DatasetIngestState> {
    return (
      this.data.states.get(stateKey(projectId, datasetId)) ?? initialDatasetIngestState(datasetId)
    )
  }

  async writeState(projectId: string, state: DatasetIngestState): Promise<void> {
    this.data.states.set(stateKey(projectId, state.datasetId), state)
  }

  async insertDelivery(projectId: string, record: DatasetIngestDeliveryRecord): Promise<string> {
    const id = this.data.nextId
    this.data.nextId += 1n
    this.data.deliveries.set(id, { ...record, projectId, id, flushId: null })
    return id.toString()
  }

  async listUntaken(
    projectId: string,
    datasetId: string,
    limit: number
  ): Promise<readonly DatasetIngestDelivery[]> {
    return this.deliveriesOf(projectId, datasetId)
      .filter((delivery) => delivery.flushId === null)
      .slice(0, limit)
      .map(toDelivery)
  }

  async take(
    projectId: string,
    datasetId: string,
    deliveryIds: readonly string[],
    flushId: string
  ): Promise<void> {
    for (const id of deliveryIds) {
      const delivery = this.data.deliveries.get(BigInt(id))
      if (delivery?.projectId === projectId && delivery.datasetId === datasetId) {
        this.data.deliveries.set(delivery.id, { ...delivery, flushId })
      }
    }
  }

  async listFlush(
    projectId: string,
    datasetId: string,
    flushId: string
  ): Promise<readonly DatasetIngestDelivery[]> {
    return this.flushOf(projectId, datasetId, flushId).map(toDelivery)
  }

  async readFlush(
    projectId: string,
    datasetId: string,
    flushId: string,
    page: { readonly afterId: string | null; readonly limit: number }
  ): Promise<readonly { readonly delivery: DatasetIngestDelivery; readonly changes: string }[]> {
    const afterId = page.afterId === null ? 0n : BigInt(page.afterId)

    return this.flushOf(projectId, datasetId, flushId)
      .filter((delivery) => delivery.id > afterId)
      .slice(0, page.limit)
      .map((delivery) => ({ delivery: toDelivery(delivery), changes: delivery.changes }))
  }

  async deleteFlush(projectId: string, datasetId: string, flushId: string): Promise<void> {
    for (const delivery of this.flushOf(projectId, datasetId, flushId)) {
      this.data.deliveries.delete(delivery.id)
    }
  }

  async deleteDeliveries(
    projectId: string,
    datasetId: string,
    flushId: string,
    deliveryIds: readonly string[]
  ): Promise<void> {
    const ids = new Set(deliveryIds)
    for (const delivery of this.flushOf(projectId, datasetId, flushId)) {
      if (ids.has(delivery.id.toString())) this.data.deliveries.delete(delivery.id)
    }
  }

  async listStates(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestState[]> {
    const wanted = datasetIds === undefined ? null : new Set(datasetIds)

    return [...this.data.states.entries()]
      .filter(([key]) => key.startsWith(`${projectId}\u0000`))
      .map(([, state]) => state)
      .filter((state) => wanted === null || wanted.has(state.datasetId))
  }

  async countPending(
    projectId: string,
    datasetIds: readonly string[] | undefined
  ): Promise<readonly DatasetIngestPendingCounts[]> {
    const wanted = datasetIds === undefined ? null : new Set(datasetIds)
    const counts = new Map<string, DatasetIngestPendingCounts>()

    for (const delivery of this.data.deliveries.values()) {
      if (delivery.projectId !== projectId) continue
      if (wanted !== null && !wanted.has(delivery.datasetId)) continue

      const current = counts.get(delivery.datasetId)
      counts.set(delivery.datasetId, {
        datasetId: delivery.datasetId,
        pendingDeliveries: (current?.pendingDeliveries ?? 0) + 1,
        pendingChanges: (current?.pendingChanges ?? 0) + delivery.changeCount,
        oldestReceivedAt:
          current?.oldestReceivedAt && current.oldestReceivedAt <= delivery.receivedAt
            ? current.oldestReceivedAt
            : delivery.receivedAt,
      })
    }

    return [...counts.values()]
  }

  private deliveriesOf(projectId: string, datasetId: string): StoredDelivery[] {
    return [...this.data.deliveries.values()]
      .filter((delivery) => delivery.projectId === projectId && delivery.datasetId === datasetId)
      .sort((left, right) => (left.id < right.id ? -1 : 1))
  }

  private flushOf(projectId: string, datasetId: string, flushId: string): StoredDelivery[] {
    return this.deliveriesOf(projectId, datasetId).filter(
      (delivery) => delivery.flushId === flushId
    )
  }
}

function toDelivery(stored: StoredDelivery): DatasetIngestDelivery {
  return {
    id: stored.id.toString(),
    datasetId: stored.datasetId,
    executionId: stored.executionId,
    correlationId: stored.correlationId,
    receivedAt: stored.receivedAt,
    changeCount: stored.changeCount,
    definitionHash: stored.definitionHash,
  }
}

function stateKey(projectId: string, datasetId: string): string {
  return `${projectId}\u0000${datasetId}`
}

function replaceEntries<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}
