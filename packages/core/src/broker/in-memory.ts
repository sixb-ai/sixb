import { getInvalidJsonValueReason, type JsonValue } from "../json"
import { BrokerError } from "./errors"
import type { Broker, BrokerRecord, BrokerRecordInput, BrokerStreamDefinition } from "./types"

// Payloads are validated by assertBrokerPayload above the call site, so we can
// skip the redundant validity walk that cloneJsonValue performs.
function cloneValidatedPayload(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

// Records stored internally carry a numeric publishedAtMs alongside the public
// ISO publishedAt string so retention sweeps can avoid Date.parse on every
// record on every append/read.
interface StoredRecord extends BrokerRecord {
  readonly publishedAtMs: number
}

interface StoredStream {
  definition: BrokerStreamDefinition
  nextSequence: bigint
  records: StoredRecord[]
}

interface Subscription {
  readonly projectId: string
  readonly streamId: string
  readonly names?: readonly string[]
  readonly handler: (records: readonly BrokerRecord[]) => void
}

export class InMemoryBroker implements Broker {
  private readonly streams = new Map<string, StoredStream>()
  private readonly subscriptions = new Set<Subscription>()

  async ensureStream(params: { projectId: string; stream: BrokerStreamDefinition }): Promise<void> {
    assertProjectId(params.projectId)
    assertStream(params.stream)
    this.getOrCreateStream(params.projectId, params.stream)
  }

  async append(params: {
    projectId: string
    streamId: string
    records: readonly BrokerRecordInput[]
  }): Promise<readonly BrokerRecord[]> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)

    if (params.records.length === 0) {
      return []
    }

    for (const record of params.records) {
      assertBrokerPayload(record.payload)
    }

    const storedStream = this.getEnsuredStream(params.projectId, params.streamId)
    const stored: StoredRecord[] = []

    for (const record of params.records) {
      const cursor = storedStream.nextSequence.toString()
      storedStream.nextSequence += 1n
      const publishedAtMs = Date.now()
      stored.push({
        streamId: params.streamId,
        cursor,
        name: record.name,
        key: record.key,
        payload: cloneValidatedPayload(record.payload as JsonValue),
        publishedAt: new Date(publishedAtMs).toISOString(),
        publishedAtMs,
      })
    }

    storedStream.records.push(...stored)
    this.applyRetention(storedStream)
    const records = stored.map(toBrokerRecord)
    this.notify(params.projectId, params.streamId, stored)
    return records
  }

  async read(params: {
    projectId: string
    streamId: string
    afterCursor?: string
    limit?: number
    names?: readonly string[]
  }): Promise<readonly BrokerRecord[]> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return []
    }

    const storedStream = this.streams.get(streamKey(params.projectId, params.streamId))
    if (!storedStream) {
      return []
    }

    this.applyRetention(storedStream)
    this.assertCursorInRetainedRange(storedStream, params.afterCursor)
    return this.filterRecords(storedStream.records, {
      afterCursor: params.afterCursor,
      limit: params.limit,
      names: params.names,
    })
  }

  async latestCursor(params: { projectId: string; streamId: string }): Promise<string | undefined> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)

    const storedStream = this.streams.get(streamKey(params.projectId, params.streamId))
    if (!storedStream) {
      return undefined
    }

    this.applyRetention(storedStream)
    return storedStream.records.at(-1)?.cursor
  }

  async subscribe(
    params: {
      projectId: string
      streamId: string
      from?: "latest" | "earliest"
      afterCursor?: string
      names?: readonly string[]
    },
    handler: (records: readonly BrokerRecord[]) => void
  ): Promise<() => void> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)
    const storedStream = this.getEnsuredStream(params.projectId, params.streamId)

    const subscription: Subscription = {
      projectId: params.projectId,
      streamId: params.streamId,
      names: params.names,
      handler,
    }
    this.subscriptions.add(subscription)

    const startMode = params.afterCursor !== undefined ? undefined : (params.from ?? "latest")
    if (params.afterCursor !== undefined || startMode === "earliest") {
      this.applyRetention(storedStream)
      const initial = this.filterRecords(storedStream.records, {
        afterCursor: params.afterCursor,
        names: params.names,
      })
      this.deliver(subscription, initial)
    }

    return () => {
      this.subscriptions.delete(subscription)
    }
  }

  private getOrCreateStream(projectId: string, stream: BrokerStreamDefinition): StoredStream {
    const key = streamKey(projectId, stream.id)
    let storedStream = this.streams.get(key)
    if (!storedStream) {
      storedStream = { definition: stream, nextSequence: 1n, records: [] }
      this.streams.set(key, storedStream)
    }
    this.applyRetention(storedStream)
    return storedStream
  }

  private getEnsuredStream(projectId: string, streamId: string): StoredStream {
    const storedStream = this.streams.get(streamKey(projectId, streamId))
    if (!storedStream) {
      throw new BrokerError(
        `stream '${streamId}' has not been ensured for project '${projectId}'. Call ensureStream() before append or subscribe.`
      )
    }
    return storedStream
  }

  private applyRetention(storedStream: StoredStream): void {
    const { retention } = storedStream.definition
    if (!retention) {
      return
    }

    let records = storedStream.records

    if (retention.maxAgeMs !== undefined) {
      if (retention.maxAgeMs <= 0) {
        records = []
      } else {
        const oldestAllowed = Date.now() - retention.maxAgeMs
        // Records are appended in chronological order, so we only need to find
        // the first record that is still in range and slice off the prefix —
        // avoids walking the entire retained set on every sweep.
        let firstInRange = 0
        while (
          firstInRange < records.length &&
          records[firstInRange].publishedAtMs < oldestAllowed
        ) {
          firstInRange += 1
        }
        if (firstInRange > 0) {
          records = records.slice(firstInRange)
        }
      }
    }

    if (retention.maxRecords !== undefined) {
      if (retention.maxRecords <= 0) {
        records = []
      } else if (records.length > retention.maxRecords) {
        records = records.slice(records.length - retention.maxRecords)
      }
    }

    storedStream.records = records
  }

  private assertCursorInRetainedRange(
    storedStream: StoredStream,
    afterCursor: string | undefined
  ): void {
    if (afterCursor === undefined) {
      return
    }

    const requestedNextSequence = BigInt(afterCursor) + 1n
    const firstRecord = storedStream.records[0]
    const firstAvailableSequence =
      firstRecord === undefined ? storedStream.nextSequence : BigInt(firstRecord.cursor)

    if (requestedNextSequence < firstAvailableSequence) {
      throw new BrokerError(
        `afterCursor '${afterCursor}' is outside the retained range for stream '${storedStream.definition.id}'. ` +
          `The next requested cursor sequence is '${requestedNextSequence}', but the earliest ` +
          `available cursor sequence is '${firstAvailableSequence}'.`
      )
    }
  }

  private notify(projectId: string, streamId: string, records: readonly StoredRecord[]): void {
    for (const subscription of this.subscriptions) {
      if (subscription.projectId !== projectId || subscription.streamId !== streamId) {
        continue
      }
      this.deliver(
        subscription,
        this.filterRecords(records, {
          names: subscription.names,
        })
      )
    }
  }

  private deliver(subscription: Subscription, records: readonly BrokerRecord[]): void {
    if (records.length === 0) {
      return
    }

    try {
      subscription.handler(records)
    } catch {
      // Broker subscriptions are live fan-out; handler failures should not break publishers.
    }
  }

  private filterRecords(
    records: readonly StoredRecord[],
    filters: {
      afterCursor?: string
      limit?: number
      names?: readonly string[]
    }
  ): readonly BrokerRecord[] {
    const names = filters.names && filters.names.length > 0 ? new Set(filters.names) : undefined
    const afterCursor = filters.afterCursor ? BigInt(filters.afterCursor) : undefined
    const result: BrokerRecord[] = []

    for (const record of records) {
      if (afterCursor !== undefined && BigInt(record.cursor) <= afterCursor) {
        continue
      }
      if (names && (!record.name || !names.has(record.name))) {
        continue
      }
      result.push(toBrokerRecord(record))
      if (filters.limit !== undefined && result.length >= filters.limit) {
        break
      }
    }

    return result
  }
}

function streamKey(projectId: string, streamId: string): string {
  return `${projectId}\0${streamId}`
}

function toBrokerRecord(record: StoredRecord): BrokerRecord {
  return {
    streamId: record.streamId,
    cursor: record.cursor,
    name: record.name,
    key: record.key,
    payload: record.payload,
    publishedAt: record.publishedAt,
  }
}

function assertProjectId(projectId: string): void {
  if (projectId.trim().length === 0) {
    throw new BrokerError("projectId must be a non-empty string")
  }
}

function assertStream(stream: BrokerStreamDefinition): void {
  if (stream.id.trim().length === 0) {
    throw new BrokerError("stream.id must be a non-empty string")
  }
}

function assertStreamId(streamId: string): void {
  if (streamId.trim().length === 0) {
    throw new BrokerError("streamId must be a non-empty string")
  }
}

function assertBrokerPayload(payload: unknown): void {
  const reason = getInvalidJsonValueReason(payload, "record.payload")
  if (reason) {
    throw new BrokerError(`record.payload must be a JSON value; ${reason}`)
  }
}

function assertCursor(cursor: string | undefined): void {
  if (cursor === undefined) {
    return
  }

  try {
    if (BigInt(cursor) < 0n) {
      throw new BrokerError("cursor must be non-negative")
    }
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error
    }
    throw new BrokerError("cursor must be a numeric in-memory broker cursor", {
      cause: error,
    })
  }
}
