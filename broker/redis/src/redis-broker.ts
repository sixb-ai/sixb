import type { Broker, BrokerRecord, BrokerRecordInput, BrokerStreamDefinition } from "@pario/core"
import { cloneJsonValue } from "@pario/core"
import {
  type RedisBrokerClient,
  type RedisBrokerConnectionOptions,
  RedisConnectionManager,
} from "./connection"
import { assertCursor, compareStreamIds } from "./cursor"
import { RedisBrokerError } from "./errors"
import { assertPrefix, assertStreamId, validateProjectId } from "./keys"
import { APPEND_RECORD_SCRIPT, ENFORCE_AGE_RETENTION_SCRIPT } from "./scripts"
import { assertEncodableRecord, decodeRecord, encodeRecord } from "./serialization"
import { type EnsuredStream, StreamManager } from "./stream-manager"
import {
  bodyFromEntry,
  parseStreamEntries,
  parseXReadEntries,
  type RedisStreamEntry,
  toText,
} from "./stream-replies"
import { type ActiveSubscription, SubscriptionRegistry } from "./subscription-registry"

const DEFAULT_PREFIX = "pario:broker"
const DEFAULT_DEDUPE_TTL_MS = 120_000
const DEFAULT_READ_BATCH_SIZE = 1_000
const DEFAULT_SUBSCRIBE_BATCH_SIZE = 100
const DEFAULT_SUBSCRIBE_BLOCK_MS = 1_000

export interface RedisBrokerOptions {
  /** Bun Redis client options, commonly `{ url: "redis://localhost:6379" }`. */
  readonly connection?: RedisBrokerConnectionOptions
  /** Redis key prefix. Defaults to `"pario:broker"`. */
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
 * Each Pario project and broker stream id maps to a Redis Stream key, with a
 * metadata hash marking the stream as ensured. Subscriptions use plain XREAD
 * so every subscriber receives every matching record independently.
 *
 * This intentionally does not use consumer groups. Consumer groups are durable
 * work-sharing primitives; the core Broker contract is retained fan-out.
 */
export class RedisBroker implements Broker {
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
    const client = await this.connectionManager.connect()
    const records: BrokerRecord[] = []

    for (const input of params.records) {
      // Multi-record append is sequential like NatsBroker. Each individual
      // record is atomic, but callers should use idempotency keys when retrying
      // a batch that may have partially committed.
      const publishedAt = new Date().toISOString()
      const body = encodeRecord(input, publishedAt)
      const result = await this.appendOne({
        client,
        ensured,
        input,
        body,
      })

      if (result.duplicate) {
        records.push(await this.fetchRecordByCursor(client, ensured, result.cursor))
        continue
      }

      records.push({
        streamId: params.streamId,
        cursor: result.cursor,
        name: input.name,
        key: input.key,
        payload: cloneJsonValue(input.payload),
        publishedAt,
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
  }): Promise<readonly BrokerRecord[]> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return []
    }

    const ensured = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (ensured === null) {
      return []
    }

    const client = await this.connectionManager.connect()
    await this.enforceAgeRetention(client, ensured)
    await this.assertCursorInRetainedRange(client, ensured, params.afterCursor)

    const names = params.names && params.names.length > 0 ? new Set(params.names) : undefined
    const records: BrokerRecord[] = []
    // Redis makes range starts exclusive by prefixing the id with "(".
    let start = params.afterCursor === undefined ? "-" : `(${params.afterCursor}`

    while (params.limit === undefined || records.length < params.limit) {
      const entries = await this.readRange(client, ensured, start, this.readBatchSize)
      if (entries.length === 0) {
        break
      }

      let lastScannedId: string | undefined
      for (const entry of entries) {
        lastScannedId = entry.id
        const record = decodeRecord({
          streamId: ensured.streamId,
          body: bodyFromEntry(entry),
          cursor: entry.id,
          fallbackPublishedAt: new Date().toISOString(),
        })

        // Redis Streams cannot filter by arbitrary entry fields. Keep scanning
        // until the caller's limit is met after application-level name filtering.
        if (names && (!record.name || !names.has(record.name))) {
          continue
        }

        records.push(record)
        if (params.limit !== undefined && records.length >= params.limit) {
          break
        }
      }

      if (lastScannedId === undefined || entries.length < this.readBatchSize) {
        break
      }
      start = `(${lastScannedId}`
    }

    return records
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
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    const ensured = await this.streamManager.requireStream(params.projectId, params.streamId)
    const commandClient = await this.connectionManager.connect()
    await this.enforceAgeRetention(commandClient, ensured)
    if (params.afterCursor !== undefined) {
      await this.assertCursorInRetainedRange(commandClient, ensured, params.afterCursor)
    }

    const client = await this.connectionManager.createSubscriptionClient()
    const names = params.names && params.names.length > 0 ? new Set(params.names) : undefined
    // Resolve "latest" to a concrete id once. Reusing "$" after each BLOCK
    // timeout can skip records written between two XREAD calls.
    let lastSeenId =
      params.afterCursor ??
      (params.from === "earliest" ? "0-0" : await this.latestCursor(client, ensured))
    let stopped = false

    const pump = (async () => {
      try {
        while (!stopped) {
          const entries = await this.xread(client, ensured, lastSeenId)
          const records: BrokerRecord[] = []

          for (const entry of entries) {
            // Advance even for records filtered out by name so the loop never
            // replays unmatched entries forever.
            lastSeenId = entry.id

            let record: BrokerRecord
            try {
              record = decodeRecord({
                streamId: ensured.streamId,
                body: bodyFromEntry(entry),
                cursor: entry.id,
                fallbackPublishedAt: new Date().toISOString(),
              })
            } catch (error) {
              console.error("[RedisBroker] Failed to decode subscribed record:", error)
              continue
            }

            if (names && (!record.name || !names.has(record.name))) {
              continue
            }
            records.push(record)
          }

          if (records.length === 0) {
            continue
          }

          try {
            handler(records)
          } catch {
            // Handler failures are swallowed per the Broker subscribe contract.
          }
        }
      } catch (error) {
        if (!stopped) {
          console.error("[RedisBroker] Subscription pump failed:", error)
        }
      } finally {
        this.connectionManager.closeClient(client)
      }
    })()

    const subscription: ActiveSubscription = {
      stop: () => {
        if (stopped) {
          return
        }
        stopped = true
        this.connectionManager.closeClient(client)
      },
      drain: async () => {
        await pump
      },
    }

    return this.subscriptionRegistry.register(subscription)
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      await this.subscriptionRegistry.drain()
    } finally {
      await this.connectionManager.close()
    }
  }

  private async appendOne(params: {
    client: RedisBrokerClient
    ensured: EnsuredStream
    input: BrokerRecordInput
    body: string
  }): Promise<{ readonly cursor: string; readonly duplicate: boolean }> {
    const hasIdempotencyKey = params.input.idempotencyKey !== undefined

    let reply: unknown
    try {
      // One Lua call keeps XADD, dedupe-key writes, trimming, and retained-range
      // metadata updates in the same Redis atomic operation.
      reply = await params.client.send("EVAL", [
        APPEND_RECORD_SCRIPT,
        "3",
        params.ensured.keys.streamKey,
        params.ensured.keys.metaKey,
        params.ensured.keys.dedupeKey(params.input.idempotencyKey),
        params.body,
        hasIdempotencyKey ? "1" : "0",
        String(this.dedupeTtlMs),
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to append record to stream "${params.ensured.streamId}"`, {
        cause: error,
      })
    }

    if (!Array.isArray(reply) || reply.length !== 2) {
      throw new RedisBrokerError("Redis append script returned a malformed reply")
    }

    const status = toText(reply[0])
    const cursor = toText(reply[1])
    assertCursor(cursor)

    if (status === "stored") {
      return { cursor, duplicate: false }
    }
    if (status === "duplicate") {
      return { cursor, duplicate: true }
    }

    throw new RedisBrokerError(`Redis append script returned unknown status "${status}"`)
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

  private async xread(
    client: RedisBrokerClient,
    ensured: EnsuredStream,
    lastSeenId: string
  ): Promise<readonly RedisStreamEntry[]> {
    let reply: unknown
    try {
      reply = await client.send("XREAD", [
        "COUNT",
        String(this.subscribeBatchSize),
        "BLOCK",
        String(this.subscribeBlockMs),
        "STREAMS",
        ensured.keys.streamKey,
        lastSeenId,
      ])
    } catch (error) {
      throw new RedisBrokerError(`Failed to subscribe to stream "${ensured.streamId}"`, {
        cause: error,
      })
    }
    return parseXReadEntries(reply)
  }

  private async enforceAgeRetention(
    client: RedisBrokerClient,
    ensured: EnsuredStream
  ): Promise<void> {
    try {
      // Age retention is a Pario-level policy. Redis Streams only trim when a
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

  private async latestCursor(client: RedisBrokerClient, ensured: EnsuredStream): Promise<string> {
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

  private async assertCursorInRetainedRange(
    client: RedisBrokerClient,
    ensured: EnsuredStream,
    afterCursor: string | undefined
  ): Promise<void> {
    if (afterCursor === undefined) {
      return
    }

    const metadata = await this.streamManager.readMetadata(client, ensured, ["lastTrimmedId"])
    const lastTrimmedId = metadata.get("lastTrimmedId")

    // Do not compare against the first retained entry: Redis ids are not dense,
    // so the cursor immediately before the first retained entry is still valid.
    // The append script records the latest id actually trimmed; only cursors
    // older than that represent unavailable history.
    if (lastTrimmedId !== undefined && compareStreamIds(afterCursor, lastTrimmedId) < 0) {
      throw new RedisBrokerError(
        `afterCursor '${afterCursor}' is outside the retained range for stream ` +
          `'${ensured.streamId}'. The latest trimmed cursor is '${lastTrimmedId}'.`
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
