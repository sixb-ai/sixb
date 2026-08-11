import { type Broker, cloneJsonValue } from "@sixb/core"
import {
  BrokerCursorExpiredError,
  type BrokerPage,
  type BrokerRecord,
  type BrokerRecordInput,
  type BrokerStreamDefinition,
} from "@sixb/core/broker"
import {
  type RedisBrokerClient,
  type RedisBrokerConnectionOptions,
  RedisConnectionManager,
} from "./connection"
import { assertCursor, compareStreamIds } from "./cursor"
import { RedisBrokerError } from "./errors"
import { assertPrefix, assertStreamId, validateProjectId } from "./keys"
import {
  APPEND_RECORDS_SCRIPT,
  ENFORCE_AGE_RETENTION_SCRIPT,
  TRIM_STREAM_RETENTION_SCRIPT,
} from "./scripts"
import { assertEncodableRecord, decodeRecord, encodeRecord } from "./serialization"
import { type EnsuredStream, StreamManager } from "./stream-manager"
import { bodyFromEntry, parseStreamEntries, type RedisStreamEntry, toText } from "./stream-replies"
import { RedisSubscriptionPump } from "./subscription-pump"
import { SubscriptionRegistry } from "./subscription-registry"

const DEFAULT_PREFIX = "sixb:broker"
const DEFAULT_DEDUPE_TTL_MS = 120_000
const DEFAULT_READ_BATCH_SIZE = 1_000
const DEFAULT_SUBSCRIBE_BATCH_SIZE = 100
const DEFAULT_SUBSCRIBE_BLOCK_MS = 1_000

interface EncodedAppendRecord {
  readonly input: BrokerRecordInput
  readonly body: string
  readonly publishedAt: string
}

interface AppendBatchResult {
  readonly cursor: string
  readonly duplicate: boolean
  readonly duplicateBody?: string
}

export interface RedisBrokerOptions {
  /** Bun Redis client options, commonly `{ url: "redis://localhost:6379" }`. */
  readonly connection?: RedisBrokerConnectionOptions
  /** Redis key prefix. Defaults to `"sixb:broker"`. */
  readonly prefix?: string
  /** Retry-deduplication window for `idempotencyKey`. Defaults to two minutes. */
  readonly dedupeTtlMs?: number
  /** Redis `XRANGE COUNT` page size for bounded reads. */
  readonly readBatchSize?: number
  /** Redis `XREAD COUNT` page size for subscriptions. */
  readonly subscribeBatchSize?: number
  /** Redis `XREAD BLOCK` duration in milliseconds. */
  readonly subscribeBlockMs?: number
}

/**
 * Redis Streams-backed Broker provider.
 *
 * Each Sixb project and broker stream id maps to a Redis Stream key, with a
 * metadata hash marking the stream as ensured. Subscriptions use plain XREAD
 * so every subscriber receives every matching record independently.
 *
 * This intentionally does not use consumer groups. Consumer groups are durable
 * work-sharing primitives; the core Broker contract is retained fan-out.
 */
export class RedisBroker implements Broker {
  readonly scope = "shared" as const
  private readonly connectionManager: RedisConnectionManager
  private readonly streamManager: StreamManager
  private readonly subscriptionRegistry = new SubscriptionRegistry()
  private readonly dedupeTtlMs: number
  private readonly readBatchSize: number
  private readonly subscribeBatchSize: number
  private readonly subscribeBlockMs: number
  private closed = false

  constructor(options: RedisBrokerOptions = {}) {
    const prefix = options.prefix ?? DEFAULT_PREFIX
    assertPrefix(prefix)

    this.connectionManager = new RedisConnectionManager(options.connection)
    this.streamManager = new StreamManager({ connectionManager: this.connectionManager, prefix })
    this.dedupeTtlMs = positiveInteger(options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS)
    this.readBatchSize = positiveInteger(options.readBatchSize ?? DEFAULT_READ_BATCH_SIZE)
    this.subscribeBatchSize = positiveInteger(
      options.subscribeBatchSize ?? DEFAULT_SUBSCRIBE_BATCH_SIZE
    )
    this.subscribeBlockMs = positiveInteger(options.subscribeBlockMs ?? DEFAULT_SUBSCRIBE_BLOCK_MS)
  }

  async ensureStream(params: { projectId: string; stream: BrokerStreamDefinition }): Promise<void> {
    this.assertOpen()
    await this.streamManager.ensureStream(params.projectId, params.stream)
  }

  async append(params: {
    projectId: string
    streamId: string
    records: readonly BrokerRecordInput[]
  }): Promise<readonly BrokerRecord[]> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)

    if (params.records.length === 0) {
      return []
    }

    for (const input of params.records) {
      assertEncodableRecord(input)
    }

    const ensured = await this.streamManager.requireStream(params.projectId, params.streamId)
    const encodedRecords: EncodedAppendRecord[] = params.records.map((input) => {
      const publishedAt = new Date().toISOString()
      return {
        input,
        publishedAt,
        body: encodeRecord(input, publishedAt),
      }
    })

    const appendResults = await this.connectionManager.useCommandClient((client) =>
      this.appendBatch({
        client,
        ensured,
        records: encodedRecords,
      })
    )

    if (appendResults.length !== encodedRecords.length) {
      throw new RedisBrokerError(
        `Redis append script returned ${appendResults.length} result(s) for ${encodedRecords.length} record(s).`
      )
    }

    const records: BrokerRecord[] = []
    for (let index = 0; index < encodedRecords.length; index += 1) {
      const encoded = encodedRecords[index]!
      const result = appendResults[index]!

      if (result.duplicate) {
        records.push(
          result.duplicateBody
            ? decodeRecord({
                streamId: ensured.streamId,
                body: result.duplicateBody,
                cursor: result.cursor,
                fallbackPublishedAt: new Date().toISOString(),
              })
            : await this.connectionManager.useCommandClient((client) =>
                this.fetchRecordByCursor(client, ensured, result.cursor)
              )
        )
        continue
      }

      records.push({
        streamId: params.streamId,
        cursor: result.cursor,
        name: encoded.input.name,
        key: encoded.input.key,
        payload: cloneJsonValue(encoded.input.payload),
        publishedAt: encoded.publishedAt,
      })
    }

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
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    const ensured = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (ensured === null) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    await this.connectionManager.useCommandClient((client) =>
      this.enforceAgeRetention(client, ensured)
    )
    const lastTrimmedId = await this.connectionManager.useCommandClient((client) =>
      this.readLastTrimmedId(client, ensured)
    )
    this.assertCursorInRetainedRange(ensured.streamId, params.afterCursor, lastTrimmedId)

    const names = params.names && params.names.length > 0 ? new Set(params.names) : undefined
    const keys = params.keys && params.keys.length > 0 ? new Set(params.keys) : undefined
    const records: BrokerRecord[] = []
    const target = params.limit === undefined ? undefined : params.limit + 1
    // Redis makes range starts exclusive by prefixing the id with "(".
    let start =
      params.afterCursor === undefined
        ? lastTrimmedId === undefined
          ? "-"
          : `(${lastTrimmedId}`
        : `(${params.afterCursor}`

    let cursor = params.afterCursor
    let reachedTarget = false
    while (!reachedTarget) {
      const entries = await this.connectionManager.useCommandClient((client) =>
        this.readRange(client, ensured, start, this.readBatchSize)
      )
      if (entries.length === 0) {
        break
      }

      let lastScannedId: string | undefined
      for (const entry of entries) {
        lastScannedId = entry.id
        cursor = entry.id
        const record = decodeRecord({
          streamId: ensured.streamId,
          body: bodyFromEntry(entry),
          cursor: entry.id,
          fallbackPublishedAt: new Date().toISOString(),
        })

        // Redis Streams cannot filter by arbitrary entry fields. Keep scanning
        // until the caller's limit is met after application-level name filtering.
        if (!matchesFilters(record, names, keys)) {
          continue
        }

        records.push(record)
        if (target !== undefined && records.length >= target) {
          reachedTarget = true
          break
        }
      }

      if (reachedTarget || lastScannedId === undefined || entries.length < this.readBatchSize) {
        break
      }
      start = `(${lastScannedId}`
    }

    const hasMore = params.limit !== undefined && records.length > params.limit
    const pageRecords = hasMore ? records.slice(0, params.limit) : records
    return {
      records: pageRecords,
      cursor: hasMore ? (pageRecords.at(-1)?.cursor ?? params.afterCursor) : cursor,
      hasMore,
    }
  }

  async tail(params: {
    projectId: string
    streamId: string
    beforeCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.beforeCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    const ensured = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (ensured === null) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    const lastTrimmedId = await this.connectionManager.useCommandClient(async (client) => {
      await this.enforceAgeRetention(client, ensured)
      return this.readLastTrimmedId(client, ensured)
    })
    this.assertTailCursorInRetainedRange(ensured.streamId, params.beforeCursor, lastTrimmedId)

    const names = params.names && params.names.length > 0 ? new Set(params.names) : undefined
    const keys = params.keys && params.keys.length > 0 ? new Set(params.keys) : undefined
    const reversed: BrokerRecord[] = []
    const target = params.limit === undefined ? undefined : params.limit + 1
    let cursor = params.beforeCursor
    let start = params.beforeCursor === undefined ? "+" : `(${params.beforeCursor}`
    const end = lastTrimmedId === undefined ? "-" : `(${lastTrimmedId}`
    let reachedTarget = false

    while (!reachedTarget) {
      const entries = await this.connectionManager.useCommandClient((client) =>
        this.readReverseRange(client, ensured, start, end, this.readBatchSize)
      )
      if (entries.length === 0) {
        break
      }

      let lastScannedId: string | undefined
      for (const entry of entries) {
        lastScannedId = entry.id
        cursor = entry.id
        const record = decodeRecord({
          streamId: ensured.streamId,
          body: bodyFromEntry(entry),
          cursor: entry.id,
          fallbackPublishedAt: new Date().toISOString(),
        })
        if (!matchesFilters(record, names, keys)) {
          continue
        }
        reversed.push(record)
        if (target !== undefined && reversed.length >= target) {
          reachedTarget = true
          break
        }
      }

      if (reachedTarget || lastScannedId === undefined || entries.length < this.readBatchSize) {
        break
      }
      start = `(${lastScannedId}`
    }

    const hasMore = params.limit !== undefined && reversed.length > params.limit
    const pageRecords = (hasMore ? reversed.slice(0, params.limit) : reversed).reverse()
    return {
      records: pageRecords,
      cursor: hasMore ? (pageRecords[0]?.cursor ?? params.beforeCursor) : cursor,
      hasMore,
    }
  }

  async latestCursor(params: { projectId: string; streamId: string }): Promise<string | undefined> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)

    const ensured = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (ensured === null) {
      return undefined
    }

    return this.connectionManager.useCommandClient(async (client) => {
      await this.enforceAgeRetention(client, ensured)
      const entries = await this.readReverseRange(client, ensured, "+", "-", 1)
      return entries[0]?.id
    })
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
    handler: (records: readonly BrokerRecord[]) => void
  ): Promise<() => void> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    const ensured = await this.streamManager.requireStream(params.projectId, params.streamId)
    const lastTrimmedId = await this.connectionManager.useCommandClient(async (commandClient) => {
      await this.enforceAgeRetention(commandClient, ensured)
      return this.readLastTrimmedId(commandClient, ensured)
    })
    if (params.afterCursor !== undefined) {
      this.assertCursorInRetainedRange(ensured.streamId, params.afterCursor, lastTrimmedId)
    }

    const client = await this.connectionManager.createSubscriptionClient()
    const pump = new RedisSubscriptionPump({
      connectionManager: this.connectionManager,
      client,
      stream: ensured,
      names: params.names && params.names.length > 0 ? new Set(params.names) : undefined,
      keys: params.keys && params.keys.length > 0 ? new Set(params.keys) : undefined,
      batchSize: this.subscribeBatchSize,
      blockMs: this.subscribeBlockMs,
      handler,
    })
    const unsubscribe = this.subscriptionRegistry.register(pump)

    try {
      // Resolve "latest" to a concrete id once. Reusing "$" after each BLOCK
      // timeout can skip records written between two XREAD calls.
      const cursor =
        params.afterCursor ??
        (params.from === "earliest"
          ? (lastTrimmedId ?? "0-0")
          : await this.subscriptionStartCursor(client, ensured))
      this.assertOpen()
      pump.start(cursor)
      return unsubscribe
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      await this.connectionManager.close()
    } finally {
      await this.subscriptionRegistry.drain()
    }
  }

  private async appendBatch(params: {
    client: RedisBrokerClient
    ensured: EnsuredStream
    records: readonly EncodedAppendRecord[]
  }): Promise<readonly AppendBatchResult[]> {
    let reply: unknown
    try {
      const dedupeKeys = params.records.map((record) =>
        params.ensured.keys.dedupeKey(record.input.idempotencyKey)
      )
      const args = params.records.flatMap((record) => [
        record.body,
        record.input.idempotencyKey === undefined ? "0" : "1",
      ])

      // One Lua call keeps XADDs and dedupe-key writes atomic for the whole
      // append batch. Retention trimming follows as a separate command so
      // blocked XREAD subscribers can observe the complete live batch first.
      reply = await params.client.send("EVAL", [
        APPEND_RECORDS_SCRIPT,
        String(2 + dedupeKeys.length),
        params.ensured.keys.streamKey,
        params.ensured.keys.metaKey,
        ...dedupeKeys,
        String(this.dedupeTtlMs),
        String(params.records.length),
        ...args,
      ])
    } catch (error) {
      throw new RedisBrokerError(
        `Failed to append records to stream "${params.ensured.streamId}"`,
        {
          cause: error,
        }
      )
    }

    const results = parseAppendBatchReply(reply)
    if (results.some((result) => !result.duplicate)) {
      await this.trimRetention(params.client, params.ensured)
    }

    return results
  }

  private async trimRetention(client: RedisBrokerClient, ensured: EnsuredStream): Promise<void> {
    try {
      await client.send("EVAL", [
        TRIM_STREAM_RETENTION_SCRIPT,
        "2",
        ensured.keys.streamKey,
        ensured.keys.metaKey,
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to trim stream "${ensured.streamId}"`, { cause: error })
    }
  }

  private async fetchRecordByCursor(
    client: RedisBrokerClient,
    ensured: EnsuredStream,
    cursor: string
  ): Promise<BrokerRecord> {
    const entries = await this.readRange(client, ensured, cursor, 1, cursor)
    const entry = entries[0]
    if (entry === undefined || entry.id !== cursor) {
      throw new RedisBrokerError(
        `Redis deduplicated publish at cursor ${cursor}, but the retained record was not found.`
      )
    }

    return decodeRecord({
      streamId: ensured.streamId,
      body: bodyFromEntry(entry),
      cursor: entry.id,
      fallbackPublishedAt: new Date().toISOString(),
    })
  }

  private async readRange(
    client: RedisBrokerClient,
    ensured: EnsuredStream,
    start: string,
    count: number,
    end = "+"
  ): Promise<readonly RedisStreamEntry[]> {
    let reply: unknown
    try {
      reply = await client.send("XRANGE", [
        ensured.keys.streamKey,
        start,
        end,
        "COUNT",
        String(count),
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to read stream "${ensured.streamId}"`, { cause: error })
    }
    return parseStreamEntries(reply)
  }

  private async enforceAgeRetention(
    client: RedisBrokerClient,
    ensured: EnsuredStream
  ): Promise<void> {
    try {
      // Age retention is a Sixb-level policy. Redis Streams only trim when a
      // command asks them to, so reads/replays must also trim idle streams.
      await client.send("EVAL", [
        ENFORCE_AGE_RETENTION_SCRIPT,
        "2",
        ensured.keys.streamKey,
        ensured.keys.metaKey,
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to enforce retention for stream "${ensured.streamId}"`, {
        cause: error,
      })
    }
  }

  private async subscriptionStartCursor(
    client: RedisBrokerClient,
    ensured: EnsuredStream
  ): Promise<string> {
    const entries = await this.readReverseRange(client, ensured, "+", "-", 1)
    const latest = entries[0]
    if (latest !== undefined) {
      return latest.id
    }

    const metadata = await this.streamManager.readMetadata(client, ensured, ["lastId"])
    return metadata.get("lastId") ?? "0-0"
  }

  private async readReverseRange(
    client: RedisBrokerClient,
    ensured: EnsuredStream,
    start: string,
    end: string,
    count: number
  ): Promise<readonly RedisStreamEntry[]> {
    let reply: unknown
    try {
      reply = await client.send("XREVRANGE", [
        ensured.keys.streamKey,
        start,
        end,
        "COUNT",
        String(count),
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to read stream "${ensured.streamId}"`, { cause: error })
    }
    return parseStreamEntries(reply)
  }

  private async readLastTrimmedId(
    client: RedisBrokerClient,
    ensured: EnsuredStream
  ): Promise<string | undefined> {
    const metadata = await this.streamManager.readMetadata(client, ensured, ["lastTrimmedId"])
    return metadata.get("lastTrimmedId")
  }

  private assertCursorInRetainedRange(
    streamId: string,
    afterCursor: string | undefined,
    lastTrimmedId: string | undefined
  ): void {
    if (afterCursor === undefined) {
      return
    }

    // Do not compare against the first retained entry: Redis ids are not dense,
    // so the cursor immediately before the first retained entry is still valid.
    // The append/trim scripts record the latest id removed from the logical
    // retained range; only cursors older than that represent unavailable history.
    if (lastTrimmedId !== undefined && compareStreamIds(afterCursor, lastTrimmedId) < 0) {
      throw new BrokerCursorExpiredError(
        `afterCursor '${afterCursor}' is outside the retained range for stream ` +
          `'${streamId}'. The latest trimmed cursor is '${lastTrimmedId}'.`
      )
    }
  }

  private assertTailCursorInRetainedRange(
    streamId: string,
    beforeCursor: string | undefined,
    lastTrimmedId: string | undefined
  ): void {
    if (beforeCursor === undefined) {
      return
    }
    if (lastTrimmedId !== undefined && compareStreamIds(beforeCursor, lastTrimmedId) <= 0) {
      throw new BrokerCursorExpiredError(
        `beforeCursor '${beforeCursor}' is outside the retained range for stream ` +
          `'${streamId}'. The latest trimmed cursor is '${lastTrimmedId}'.`
      )
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RedisBrokerError("broker has been closed")
    }
  }
}

function positiveInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new RedisBrokerError("broker numeric options must be positive finite integers")
  }
  return value
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

function parseAppendBatchReply(reply: unknown): readonly AppendBatchResult[] {
  if (!Array.isArray(reply)) {
    throw new RedisBrokerError("Redis append script returned a malformed reply")
  }

  return reply.map(parseAppendBatchResult)
}

function parseAppendBatchResult(item: unknown): AppendBatchResult {
  if (!Array.isArray(item) || item.length < 2) {
    throw new RedisBrokerError("Redis append script returned a malformed item")
  }

  const status = toText(item[0])
  const cursor = toText(item[1])
  assertCursor(cursor)
  const duplicateBody = item.length >= 3 ? optionalText(item[2]) : undefined

  if (status === "stored") {
    return { cursor, duplicate: false }
  }
  if (status === "duplicate") {
    return { cursor, duplicate: true, duplicateBody }
  }

  throw new RedisBrokerError(`Redis append script returned unknown status "${status}"`)
}

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined
  }

  const text = toText(value)
  return text.length === 0 ? undefined : text
}
