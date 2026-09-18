import { getInvalidJsonValueReason, type JsonValue } from "../json"
import { BrokerCursorExpiredError, BrokerError } from "./errors"
import { waitForSubscriber } from "./subscriber"
import type {
  Broker,
  BrokerPage,
  BrokerRecord,
  BrokerRecordInput,
  BrokerStreamDefinition,
} from "./types"

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
  readonly byteSize: number
}

interface StoredStream {
  definition: BrokerStreamDefinition
  nextSequence: bigint
  records: StoredRecord[]
  retainedBytes: number
}

interface Subscription {
  readonly projectId: string
  readonly streamId: string
  readonly names?: readonly string[]
  readonly keys?: readonly string[]
  readonly handler: (records: readonly BrokerRecord[]) => unknown
  cursor: string
  pumping: boolean
  readonly controller: AbortController
}

export class InMemoryBroker implements Broker {
  readonly scope = "process" as const
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
      const storedRecord = {
        streamId: params.streamId,
        cursor,
        name: record.name,
        key: record.key,
        payload: cloneValidatedPayload(record.payload as JsonValue),
        publishedAt: new Date(publishedAtMs).toISOString(),
        publishedAtMs,
      }
      stored.push({
        ...storedRecord,
        byteSize: utf8Bytes(JSON.stringify(storedRecord)),
      })
    }

    storedStream.records.push(...stored)
    storedStream.retainedBytes += stored.reduce((total, record) => total + record.byteSize, 0)
    this.applyRetention(storedStream)
    const records = stored.map(toBrokerRecord)
    this.notify(params.projectId, params.streamId)
    return records
  }

  async read(params: {
    projectId: string
    streamId: string
    afterCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    const storedStream = this.streams.get(streamKey(params.projectId, params.streamId))
    if (!storedStream) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    this.applyRetention(storedStream)
    this.assertCursorInRetainedRange(storedStream, params.afterCursor)
    return this.readForward(storedStream.records, {
      afterCursor: params.afterCursor,
      limit: params.limit,
      names: params.names,
      keys: params.keys,
    })
  }

  async tail(params: {
    projectId: string
    streamId: string
    beforeCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.beforeCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    const storedStream = this.streams.get(streamKey(params.projectId, params.streamId))
    if (!storedStream) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    this.applyRetention(storedStream)
    this.assertTailCursorInRetainedRange(storedStream, params.beforeCursor)
    return this.readBackward(storedStream.records, params)
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
      keys?: readonly string[]
    },
    handler: (records: readonly BrokerRecord[]) => unknown
  ): Promise<() => void> {
    assertProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)
    const storedStream = this.getEnsuredStream(params.projectId, params.streamId)

    // Retention may have trimmed past the caller's cursor. Reject that here rather than let
    // `readForward` skip silently to the oldest retained record: a resuming subscriber would be
    // fast-forwarded over the gap and would believe it had seen everything. `read` and `tail`
    // already reject it, and so does the Redis provider, so this keeps the three consistent.
    // Checked before the subscription is registered so a throw cannot leave one behind.
    this.applyRetention(storedStream)
    this.assertCursorInRetainedRange(storedStream, params.afterCursor)

    const startMode = params.afterCursor !== undefined ? undefined : (params.from ?? "latest")
    const subscription: Subscription = {
      projectId: params.projectId,
      streamId: params.streamId,
      names: params.names,
      keys: params.keys,
      handler,
      cursor:
        params.afterCursor ??
        (startMode === "earliest"
          ? BigInt(storedStream.records[0]?.cursor ?? storedStream.nextSequence) - 1n
          : storedStream.nextSequence - 1n
        ).toString(),
      pumping: false,
      controller: new AbortController(),
    }
    this.subscriptions.add(subscription)

    if (params.afterCursor !== undefined || startMode === "earliest") {
      this.deliver(subscription)
    }

    return () => {
      this.subscriptions.delete(subscription)
      subscription.controller.abort()
    }
  }

  private getOrCreateStream(projectId: string, stream: BrokerStreamDefinition): StoredStream {
    const key = streamKey(projectId, stream.id)
    let storedStream = this.streams.get(key)
    if (!storedStream) {
      storedStream = {
        definition: stream,
        nextSequence: 1n,
        records: [],
        retainedBytes: 0,
      }
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

    let removeCount = 0
    const records = storedStream.records

    if (retention.maxAgeMs !== undefined) {
      if (retention.maxAgeMs <= 0) {
        removeCount = records.length
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
        removeCount = Math.max(removeCount, firstInRange)
      }
    }

    if (retention.maxRecords !== undefined) {
      if (retention.maxRecords <= 0) {
        removeCount = records.length
      } else if (records.length - removeCount > retention.maxRecords) {
        removeCount = records.length - retention.maxRecords
      }
    }

    if (retention.maxBytes !== undefined) {
      if (retention.maxBytes <= 0) {
        removeCount = records.length
      } else {
        let bytes = storedStream.retainedBytes
        for (let index = 0; index < removeCount; index += 1) {
          bytes -= records[index]!.byteSize
        }
        while (removeCount < records.length && bytes > retention.maxBytes) {
          bytes -= records[removeCount]!.byteSize
          removeCount += 1
        }
      }
    }

    if (removeCount > 0) {
      for (let index = 0; index < removeCount; index += 1) {
        storedStream.retainedBytes -= records[index]!.byteSize
      }
      storedStream.records = records.slice(removeCount)
    }
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
      throw new BrokerCursorExpiredError(
        `afterCursor '${afterCursor}' is outside the retained range for stream '${storedStream.definition.id}'. ` +
          `The next requested cursor sequence is '${requestedNextSequence}', but the earliest ` +
          `available cursor sequence is '${firstAvailableSequence}'.`
      )
    }
  }

  private assertTailCursorInRetainedRange(
    storedStream: StoredStream,
    beforeCursor: string | undefined
  ): void {
    if (beforeCursor === undefined || storedStream.records.length === 0) {
      return
    }
    const firstAvailableSequence = BigInt(storedStream.records[0]!.cursor)
    if (BigInt(beforeCursor) < firstAvailableSequence) {
      throw new BrokerCursorExpiredError(
        `beforeCursor '${beforeCursor}' is outside the retained range for stream '${storedStream.definition.id}'. ` +
          `The earliest available cursor sequence is '${firstAvailableSequence}'.`
      )
    }
  }

  private notify(projectId: string, streamId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.projectId !== projectId || subscription.streamId !== streamId) {
        continue
      }
      this.deliver(subscription)
    }
  }

  private deliver(subscription: Subscription): void {
    if (subscription.pumping) return
    subscription.pumping = true
    // Only the retained stream holds the backlog, never a second queue of cloned batches.
    void this.pump(subscription).catch((error) => {
      this.subscriptions.delete(subscription)
      subscription.controller.abort()
      console.error("[InMemoryBroker] Subscription stopped:", error)
    })
  }

  private async pump(subscription: Subscription): Promise<void> {
    while (this.subscriptions.has(subscription)) {
      const stream = this.getEnsuredStream(subscription.projectId, subscription.streamId)
      this.applyRetention(stream)
      this.assertCursorInRetainedRange(stream, subscription.cursor)
      const page = this.readForward(stream.records, {
        afterCursor: subscription.cursor,
        names: subscription.names,
        keys: subscription.keys,
        limit: 100,
      })
      if (page.records.length === 0) {
        subscription.cursor = page.cursor ?? subscription.cursor
        // Clear synchronously: an append must not miss the wake-up between return and finally.
        subscription.pumping = false
        return
      }
      try {
        await waitForSubscriber(subscription.handler(page.records), subscription.controller.signal)
      } catch {
        // Preserve observer error isolation, including rejected async callbacks.
      }
      if (!this.subscriptions.has(subscription)) return
      subscription.cursor = page.cursor ?? subscription.cursor
    }
  }

  private readForward(
    records: readonly StoredRecord[],
    filters: {
      afterCursor?: string
      limit?: number
      names?: readonly string[]
      keys?: readonly string[]
    }
  ): BrokerPage {
    const names = filters.names && filters.names.length > 0 ? new Set(filters.names) : undefined
    const keys = filters.keys && filters.keys.length > 0 ? new Set(filters.keys) : undefined
    const afterCursor = filters.afterCursor ? BigInt(filters.afterCursor) : undefined
    const result: BrokerRecord[] = []
    let cursor = filters.afterCursor
    let stoppedAt = records.length

    // Cursor pumps repeatedly read the tail: do not rescan the whole retained prefix per batch.
    let start = 0
    let end = records.length
    if (afterCursor !== undefined) {
      while (start < end) {
        const middle = Math.floor((start + end) / 2)
        if (BigInt(records[middle]!.cursor) <= afterCursor) start = middle + 1
        else end = middle
      }
    }
    for (let index = start; index < records.length; index += 1) {
      const record = records[index]!
      cursor = record.cursor
      if (!matchesFilters(record, names, keys)) {
        continue
      }
      result.push(toBrokerRecord(record))
      if (filters.limit !== undefined && result.length >= filters.limit) {
        stoppedAt = index + 1
        break
      }
    }

    let hasMore = false
    for (let index = stoppedAt; index < records.length; index += 1) {
      if (matchesFilters(records[index]!, names, keys)) {
        hasMore = true
        break
      }
    }
    return {
      records: result,
      cursor,
      hasMore,
    }
  }

  private readBackward(
    records: readonly StoredRecord[],
    filters: {
      beforeCursor?: string
      limit?: number
      names?: readonly string[]
      keys?: readonly string[]
    }
  ): BrokerPage {
    const names = filters.names && filters.names.length > 0 ? new Set(filters.names) : undefined
    const keys = filters.keys && filters.keys.length > 0 ? new Set(filters.keys) : undefined
    const beforeCursor = filters.beforeCursor ? BigInt(filters.beforeCursor) : undefined
    const reversed: BrokerRecord[] = []
    let cursor = filters.beforeCursor
    let stoppedAt = -1

    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index]!
      if (beforeCursor !== undefined && BigInt(record.cursor) >= beforeCursor) {
        continue
      }
      cursor = record.cursor
      if (!matchesFilters(record, names, keys)) {
        continue
      }
      reversed.push(toBrokerRecord(record))
      if (filters.limit !== undefined && reversed.length >= filters.limit) {
        stoppedAt = index - 1
        break
      }
    }

    return {
      records: reversed.reverse(),
      cursor,
      hasMore:
        stoppedAt >= 0 &&
        records.slice(0, stoppedAt + 1).some((record) => matchesFilters(record, names, keys)),
    }
  }
}

function matchesFilters(
  record: BrokerRecord,
  names: ReadonlySet<string> | undefined,
  keys: ReadonlySet<string> | undefined
): boolean {
  return (
    (!names || (!!record.name && names.has(record.name))) &&
    (!keys || (!!record.key && keys.has(record.key)))
  )
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
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
