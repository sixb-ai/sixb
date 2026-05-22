import { cloneJsonValue, getInvalidJsonValueReason } from "../json"
import { BrokerError } from "./errors"
import type { Broker, BrokerRecord, BrokerRecordInput, BrokerStreamDefinition } from "./types"

interface StoredStream {
  definition: BrokerStreamDefinition
  nextSequence: bigint
  records: BrokerRecord[]
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
    const stored: BrokerRecord[] = []

    for (const record of params.records) {
      const cursor = storedStream.nextSequence.toString()
      storedStream.nextSequence += 1n
      stored.push({
        streamId: params.streamId,
        cursor,
        name: record.name,
        key: record.key,
        payload: cloneJsonValue(record.payload),
        publishedAt: new Date().toISOString(),
      })
    }

    storedStream.records.push(...stored)
    this.applyRetention(storedStream)
    this.notify(params.projectId, params.streamId, stored)
    return stored
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
        records = records.filter((record) => Date.parse(record.publishedAt) >= oldestAllowed)
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

  private notify(projectId: string, streamId: string, records: readonly BrokerRecord[]): void {
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
    records: readonly BrokerRecord[],
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
      result.push(record)
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
